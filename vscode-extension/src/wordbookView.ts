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
import {
    DEFAULT_NEW_LIMIT,
    ReviewGrade,
    buildQueue,
    computeStats,
    dueText,
    grade as gradeState,
    todayKey,
} from './reviewSchedule';
import { loadReviewStates, saveReviewStates, stateOf } from './reviewStore';

/**
 * 复习队列的一项：要背的 lemma + 用它的一条语境出题。
 * 每个 lemma 只出一次（同词多条语境时取第一条）—— 记的是"词"，不是"句子"。
 */
interface QueueItem {
    lemma: string;
    entry: CollectionEntry;
}

/** 新词每日限额（设置项 jpReader.newWordsPerDay） */
function newWordLimit(): number {
    const cfg = vscode.workspace.getConfiguration('jpReader');
    const raw = Number(cfg.get<number>('newWordsPerDay', DEFAULT_NEW_LIMIT));
    return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_NEW_LIMIT;
}

export class WordbookViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'jpReader.wordbook';
    private view?: vscode.WebviewView;
    private queue: QueueItem[] = [];
    private queueIndex = 0;
    private reviewedThisSession = 0;

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
                this.answerReview(msg.grade as ReviewGrade);
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
        const today = todayKey();
        const { states } = loadReviewStates(dataRoot);
        const grouped = groupByLemma(dataRoot);
        const groups = Array.from(grouped.entries()).map(([lemma, entries]) => ({
            lemma,
            wtype: entries[0].wtype,
            pos: entries[0].pos,
            dueText: dueText(states.get(lemma), today),
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
        this.view.webview.postMessage({
            type: 'data',
            groups,
            stats: computeStats(grouped.keys(), states, today),
        });
    }

    // ---------------- 复习（间隔重复） ----------------

    /**
     * 组队列：到期的先来，不足时按日限额补新词。
     * 这里不再用"按状态加权随机"—— 随机抽词与记忆强度无关，
     * 会出现"熟的词反复出现、生词永远不出现"。
     */
    private startReview(): void {
        const dataRoot = this.dataRootFn();
        const today = todayKey();
        const { states } = loadReviewStates(dataRoot);
        const grouped = groupByLemma(dataRoot);

        const { due, fresh } = buildQueue(grouped.keys(), states, today, {
            newLimit: newWordLimit(),
        });

        const items: QueueItem[] = [];
        for (const lemma of [...due, ...fresh]) {
            const entries = grouped.get(lemma);
            if (entries && entries.length > 0) {
                items.push({ lemma, entry: entries[0] });
            }
        }

        if (items.length === 0) {
            this.post({
                type: 'reviewEmpty',
                stats: computeStats(grouped.keys(), states, today),
            });
            return;
        }

        this.queue = items;
        this.queueIndex = 0;
        this.reviewedThisSession = 0;
        this.sendNextReview();
    }

    private sendNextReview(): void {
        const dataRoot = this.dataRootFn();
        const today = todayKey();
        const grouped = groupByLemma(dataRoot);
        const { states } = loadReviewStates(dataRoot);

        if (this.queueIndex >= this.queue.length) {
            this.post({
                type: 'reviewDone',
                reviewed: this.reviewedThisSession,
                stats: computeStats(grouped.keys(), states, today),
            });
            return;
        }

        const { lemma, entry } = this.queue[this.queueIndex];
        this.post({
            type: 'reviewItem',
            item: {
                // 隐藏这个词在本句中的所有表层形式：只给语境，让用户在上下文里回忆
                sentenceHidden: hideSurfaces(entry.sentence, entry.surfaceForm),
                lemma,
                reading: this.readingFn(entry.surfaceForm),
                wtype: entry.wtype,
                dueText: dueText(states.get(lemma), today),
                done: this.queueIndex + 1,
                total: this.queue.length,
            },
        });
    }

    private answerReview(grade: ReviewGrade): void {
        if (!['again', 'hard', 'good', 'easy'].includes(grade)) {
            return;
        }
        const item = this.queue[this.queueIndex];
        if (!item) {
            return;
        }
        const dataRoot = this.dataRootFn();
        const today = todayKey();
        const { states } = loadReviewStates(dataRoot);
        const next = gradeState(stateOf(states, item.lemma, today), grade, today);
        states.set(item.lemma, next);
        saveReviewStates(dataRoot, states);

        this.reviewedThisSession += 1;
        this.queueIndex += 1;
        if (grade === 'again') {
            // 忘了 → 今天再见一次（放到本次队列末尾，而不是等到明天）
            this.queue.push(item);
        }

        this.sendData();
        this.sendNextReview();
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
