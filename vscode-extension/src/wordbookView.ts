import * as vscode from 'vscode';
import { webviewHtml } from './webviewHtml';
import {
    groupByLemma,
    updateEntryStatus,
    updateEntryNote,
    deleteEntry,
    CollectionEntry,
} from './collection';
import { readyTokenizer } from './appContext';

interface ReviewPoolItem {
    entry: CollectionEntry;
}

export class WordbookViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'jpReader.wordbook';
    private view?: vscode.WebviewView;
    private pool: ReviewPoolItem[] = [];
    private poolIndex = 0;
    private totalPicked = 0;

    constructor(
        private dataRootFn: () => string,
        private readingFn: (s: string) => string
    ) {}

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true };
        view.webview.html = webviewHtml();
        view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
        this.sendData();
    }

    /** 供外部（收集/删除后）调用以刷新面板 */
    refresh(): void {
        this.sendData();
    }

    private onMessage(msg: any): void {
        const dataRoot = this.dataRootFn();
        switch (msg.type) {
            case 'ready':
                this.sendData();
                break;
            case 'setStatus':
                updateEntryStatus(dataRoot, msg.id, msg.status);
                this.sendData();
                break;
            case 'setNote':
                updateEntryNote(dataRoot, msg.id, msg.note);
                break;
            case 'delete':
                deleteEntry(dataRoot, msg.id);
                this.sendData();
                break;
            case 'reviewStart':
                this.startReview();
                break;
            case 'reviewAnswer':
                this.answerReview(msg.ok);
                break;
            case 'loadSettings':
                this.sendSettings();
                break;
            case 'openProviders': {
                const fs = require('fs');
                const p = require('path').join(this.dataRootFn(), 'providers_config.json');
                if (fs.existsSync(p)) {
                    vscode.workspace.openTextDocument(p).then((doc) => {
                        vscode.window.showTextDocument(doc);
                    });
                }
                break;
            }
        }
    }

    private sendSettings(): void {
        if (!this.view) return;
        const fs = require('fs');
        const p = require('path').join(this.dataRootFn(), 'providers_config.json');
        let cfg: any = {};
        try {
            cfg = JSON.parse(fs.readFileSync(p, 'utf-8'));
        } catch { /* ignore */ }
        this.view.webview.postMessage({
            type: 'settings',
            translate: cfg.translate?.active || 'google',
            speak: cfg.speak?.active || 'google_tts',
            explain: cfg.explain?.active || 'off',
        });
    }

    private sendData(): void {
        if (!this.view) {
            return;
        }
        const dataRoot = this.dataRootFn();
        const grouped = groupByLemma(dataRoot);
        const groups = Array.from(grouped.entries()).map(([lemma, entries]) => ({
            lemma,
            wtype: entries[0].wtype,
            pos: entries[0].pos,
            entries: entries.map((e) => ({
                id: e.id,
                timestamp: e.timestamp,
                surface: e.surfaceForm,
                sentence: e.sentence,
                source: e.source,
                status: e.status,
                note: e.note,
            })),
        }));
        this.view.webview.postMessage({ type: 'data', groups });
    }

    // ---------------- 复习 ----------------
    private startReview(): void {
        const dataRoot = this.dataRootFn();
        const entries = Array.from(groupByLemma(dataRoot).values()).flat();
        if (entries.length === 0) {
            this.post({ type: 'reviewEmpty' });
            return;
        }
        // 轻量加权池：新词 4 / 接触过 2 / 已掌握 1
        const pool: ReviewPoolItem[] = [];
        for (const e of entries) {
            const w = e.status === 'mastered' ? 1 : e.status === 'seen' ? 2 : 4;
            for (let i = 0; i < w; i++) {
                pool.push({ entry: e });
            }
        }
        // 洗牌
        for (let i = pool.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        this.pool = pool;
        this.poolIndex = 0;
        this.totalPicked = 0;
        this.sendNextReview();
    }

    private sendNextReview(): void {
        if (this.poolIndex >= this.pool.length) {
            this.post({ type: 'reviewEmpty' });
            return;
        }
        const item = this.pool[this.poolIndex];
        this.totalPicked++;
        const entry = item.entry;
        // 隐藏该 lemma 在本句中的所有表层形式
        const hidden = hideSurfaces(entry.sentence, entry.surfaceForm);
        const reading = this.readingFn(entry.surfaceForm);
        this.post({
            type: 'reviewItem',
            item: {
                sentenceHidden: hidden,
                lemma: entry.lemma,
                reading,
                wtype: entry.wtype,
                done: this.totalPicked,
                total: this.pool.length,
            },
        });
    }

    private answerReview(ok: boolean): void {
        if (this.poolIndex >= this.pool.length) {
            return;
        }
        const entry = this.pool[this.poolIndex].entry;
        const cur = entry.status || 'new';
        const next: CollectionEntry['status'] = ok
            ? cur === 'new'
                ? 'seen'
                : cur === 'seen'
                ? 'mastered'
                : 'mastered'
            : 'new';
        if (next !== cur) {
            updateEntryStatus(this.dataRootFn(), entry.id, next);
            entry.status = next;
        }
        this.poolIndex++;
        this.sendNextReview();
        this.sendData();
    }

    private post(msg: any): void {
        if (this.view) {
            this.view.webview.postMessage(msg);
        }
    }
}

/** 在句子中隐藏指定表层形式（全部出现处 → 「＿＿」） */
function hideSurfaces(sentence: string, surface: string): string {
    if (!sentence || !surface) {
        return sentence;
    }
    return sentence.split(surface).join('<span class="blank">＿＿</span>');
}

/** 读取表层读音（kuromoji 首个 token 的 reading），未就绪返回空 */
export function readingOf(surface: string): string {
    const tk = readyTokenizer();
    if (!tk) {
        return '';
    }
    try {
        const toks = tk.tokenize(surface);
        for (const t of toks) {
            if (t.reading) {
                return t.reading;
            }
        }
    } catch {
        return '';
    }
    return '';
}
