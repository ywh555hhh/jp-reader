import * as vscode from 'vscode';
import * as kuromoji from 'kuromoji';
import { RuleEngineData } from './dataLoader';
import * as fs from 'fs';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import { toJpTokens } from './ruleEngine';
import { analyzeCoverage, countLemmas, summarize } from './coverage';
import { collectCoverageInputs } from './coverageInputs';
import { buildMarkdownItPlugin } from './mdPlugin';
import { buildSourceIndex, sentenceAt } from './readingSource';
import { loadingHtml, wrapHtml } from './readingViewHtml';
import { addEntry, refreshLemmasFile } from './collection';
import { resolveTtsUrls } from './tts';
import {
    callProvider,
    ensureData,
    extensionDirPath,
    getTokenizer,
    isProviderEnabled,
    readingSession,
    readyTokenizer,
    scheduleReadingRender,
} from './appContext';

/**
 * JP Reader 阅读视图：自建 Webview 面板，复用宿主侧 markdown-it 渲染 + 高亮插件。
 * 会话状态由 appContext 持有（见那里的 readingSession）。
 * 因为是我们自己的 webview，可以双向通信，实现划词悬浮工具栏 / 点词查词 / 语境收集。
 *
 * 两条关键设计：
 *   · 划词动作回传的是 span 上的**真实 offset**，原句由 sentenceAt() 从源文切出来（否命题 A6）
 *   · 正文更新一律用 postMessage 局部替换，不重设 webview.html
 *     （重设等于整页重载：滚动归零、弹窗消失、正在朗读的音频被打断）
 */

export async function openReadingView(context: vscode.ExtensionContext): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showWarningMessage('请先打开一个 Markdown 课文文件');
        return;
    }
    const doc = editor.document;
    readingSession.docUri = doc.uri;

    if (readingSession.panel) {
        readingSession.panel.title = `JP Reader: ${doc.fileName}`;
        readingSession.panel.reveal();
    } else {
        readingSession.ready = false;
        readingSession.panel = vscode.window.createWebviewPanel(
            'jpReader.reading',
            `JP Reader: ${doc.fileName}`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [],
            }
        );
        const thisPanel = readingSession.panel;
        thisPanel.onDidDispose(() => {
            readingSession.panel = null;
            readingSession.ready = false;
            readingSession.docUri = undefined;
        }, undefined, context.subscriptions);

        thisPanel.webview.onDidReceiveMessage(
            (msg) => handleMessage(msg),
            undefined,
            context.subscriptions
        );

        // 文档变更防抖重渲染。
        // ⚠ 必须挂在**面板**的 disposables 上：以前挂在 context.subscriptions 上
        // 且每次 openReadingView 都注册一遍，打开 N 次后每次编辑会触发 N 次全文重渲染。
        const docWatcher = vscode.workspace.onDidChangeTextDocument((ev) => {
            if (!readingSession.docUri || ev.document.uri.toString() !== readingSession.docUri.toString()) {
                return;
            }
            scheduleReadingRender(() => {
                render().catch(() => undefined);
            });
        });
        thisPanel.onDidDispose(() => docWatcher.dispose(), undefined, context.subscriptions);
    }

    await render();
}

/**
 * 计算并推送覆盖率：阅读视图顶部那行"本课 N 词 ｜ 见过 X% ｜ 生词 M"。
 * 与命令面板用的是同一套纯计算与同一份输入，所以两处结论必然一致。
 */
function postCoverage(rawText: string, tokenizer: kuromoji.Tokenizer, engineData: RuleEngineData): void {
    if (!readingSession.panel) {
        return;
    }
    const lemmas = toJpTokens(tokenizer.tokenize(rawText), engineData).map((t) => t.lemma);
    const inputs = collectCoverageInputs(
        engineData.dataRoot,
        engineData.rules.map((rule) => rule.lemmaSet)
    );
    const report = analyzeCoverage(
        countLemmas(lemmas),
        inputs.known,
        inputs.mastered,
        inputs.priority
    );
    readingSession.panel.webview.postMessage({
        type: 'coverage',
        summary: summarize(report),
        unknown: report.unknown.slice(0, 24),
    });
}

/** 数据文件（规则/词库）变了之后，宿主可以调它让阅读视图重渲染 */
export function refreshReadingView(): void {
    if (readingSession.panel && readingSession.docUri) {
        render().catch(() => undefined);
    }
}

async function render(): Promise<void> {
    if (!readingSession.panel || !readingSession.docUri) {
        return;
    }
    const doc = await vscode.workspace.openTextDocument(readingSession.docUri);
    const rawText = doc.getText();

    // 确保分词器就绪（首次可能未构建完成）
    let tokenizer = readyTokenizer();
    if (!tokenizer) {
        readingSession.panel.webview.html = loadingHtml();
        readingSession.ready = false;
        tokenizer = await getTokenizer();
    }

    // 源文索引：拿到每个词的**真实**绝对偏移，供 mdPlugin 写到 span 上（否命题 A6）
    const source = buildSourceIndex(rawText, tokenizer);

    const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
    buildMarkdownItPlugin(md, { getEngineData: ensureData, source });
    const bodyHtml = md.render(rawText);

    if (!readingSession.ready) {
        readingSession.panel.webview.html = wrapHtml(bodyHtml, sharedCss(extensionDirPath()));
        readingSession.ready = true;
        postCoverage(rawText, tokenizer, ensureData());
        return;
    }
    // 局部更新正文：保留滚动位置、弹窗与正在播放的音频
    readingSession.panel.webview.postMessage({ type: 'updateBody', html: bodyHtml });
    postCoverage(rawText, tokenizer, ensureData());
}

/**
 * 预览与阅读视图共用同一份 CSS 文件。
 * 以前阅读视图里内联了第三份高亮样式，改一处忘一处 —— 现在只有 preview/jp-reader.css 一份。
 */
function sharedCss(extensionPath: string): string {
    try {
        return fs.readFileSync(path.join(extensionPath, 'preview', 'jp-reader.css'), 'utf-8');
    } catch {
        return '';
    }
}

/** 按 offset 定位原句；定位不到就返回 null（调用方必须提示，而不是猜一个位置） */
async function locateSentence(
    offset: unknown
): Promise<{ sentence: string; fsPath: string } | null> {
    const n = Number(offset);
    if (!readingSession.docUri || !Number.isInteger(n)) {
        return null;
    }
    const doc = await vscode.workspace.openTextDocument(readingSession.docUri);
    const sentence = sentenceAt(doc.getText(), n);
    return sentence ? { sentence, fsPath: doc.uri.fsPath } : null;
}

async function handleMessage(msg: any): Promise<void> {
    if (!readingSession.panel) {
        return;
    }
    const engineData = ensureData();
    const tokenizer = readyTokenizer() ?? (await getTokenizer());

    switch (msg.type) {
        case 'speak': {
            const text = String(msg.text || '');
            if (!text) {
                break;
            }
            if (!isProviderEnabled('speak')) {
                readingSession.panel.webview.postMessage({ type: 'speakUrls', urls: [], error: '朗读未启用' });
                break;
            }
            try {
                // URL 由 provider 层给出（出网只有一个出口）；webview 只负责播放
                const urls = await resolveTtsUrls(text);
                readingSession.panel.webview.postMessage({ type: 'speakUrls', urls });
            } catch (e) {
                readingSession.panel.webview.postMessage({ type: 'speakUrls', urls: [], error: (e as Error).message });
            }
            break;
        }
        case 'lookup': {
            const surface = String(msg.surface || '');
            const raw = tokenizer.tokenize(surface);
            const jp = toJpTokens(raw, engineData);
            const items = jp.map((t) => ({
                surface: t.surface,
                lemma: t.lemma,
                pos: t.pos,
                wtype: t.wtype,
                reading: t.reading,
            }));
            readingSession.panel.webview.postMessage({ type: 'lookupResult', surface, items });
            break;
        }
        case 'translate': {
            const text = String(msg.text || '');
            if (!isProviderEnabled('translate')) {
                readingSession.panel.webview.postMessage({ type: 'translateResult', text, error: '翻译未启用' });
                return;
            }
            try {
                const out = await callProvider('translate', { text });
                readingSession.panel.webview.postMessage({ type: 'translateResult', text, result: out.content });
            } catch (e) {
                readingSession.panel.webview.postMessage({ type: 'translateResult', text, error: (e as Error).message });
            }
            break;
        }
        case 'aiExplain': {
            const text = String(msg.text || '');
            const located = await locateSentence(msg.offset);
            if (!located) {
                readingSession.panel.webview.postMessage({
                    type: 'aiResult',
                    text,
                    error: '无法定位原句：请选中一个词（高亮或未高亮都可以，只要落在词内）',
                });
                break;
            }
            if (!isProviderEnabled('explain')) {
                readingSession.panel.webview.postMessage({ type: 'aiResult', text, error: 'AI 讲解未启用（在 providers_config.json 中配置）' });
                return;
            }
            try {
                const out = await callProvider('explain', { text, context: { sentence: located.sentence } });
                readingSession.panel.webview.postMessage({ type: 'aiResult', text, result: out.content });
            } catch (e) {
                readingSession.panel.webview.postMessage({ type: 'aiResult', text, error: (e as Error).message });
            }
            break;
        }
        case 'collect': {
            const surface = String(msg.surface || '');
            const located = await locateSentence(msg.offset);
            if (!located) {
                readingSession.panel.webview.postMessage({
                    type: 'collectResult',
                    surface,
                    count: 0,
                    sentence: '',
                    error: '无法定位原句：请选中一个词（高亮或未高亮都可以，只要落在词内）',
                });
                break;
            }
            const raw = tokenizer.tokenize(surface);
            const jp = toJpTokens(raw, engineData);
            let count = 0;
            for (const t of jp) {
                const ok = addEntry(engineData.dataRoot, {
                    lemma: t.lemma,
                    surfaceForm: t.surface,
                    wtype: t.wtype,
                    pos: t.pos,
                    sentence: located.sentence,
                    source: located.fsPath,
                    status: 'new',
                    note: '',
                });
                if (ok) {
                    count++;
                }
            }
            refreshLemmasFile(engineData.dataRoot);
            readingSession.panel.webview.postMessage({ type: 'collectResult', surface, count, sentence: located.sentence });
            // 重渲染让新收集的词立即变色（局部更新，不丢滚动位置）
            render().catch(() => undefined);
            break;
        }
    }
}
