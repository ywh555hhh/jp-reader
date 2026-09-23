import * as vscode from 'vscode';
import * as path from 'path';
import { toJpTokens } from './ruleEngine';
import { sentenceAt } from './readingSource';
import { highlightEditor, disposeDecorations } from './highlighter';
import { addEntry, refreshLemmasFile } from './collection';
import { speak } from './tts';
import { WordbookViewProvider, readingOf } from './wordbookView';
import { buildMarkdownItPlugin } from './mdPlugin';
import { watchDataFiles } from './dataWatcher';
import { openReadingView, refreshReadingView } from './readingView';
import {
    callProvider,
    currentData,
    dataRootPath,
    ensureData,
    getTokenizer,
    initSecrets,
    isProviderEnabled,
    loadEngineData,
    migrateLegacyAiKey,
    refreshWordbook,
    setDictionaryDir,
    setExtensionDir,
    scheduleHighlightRefresh,
    setProviderSecret,
    setWordbook,
} from './appContext';


function getDicPath(context: vscode.ExtensionContext): string {
    return path.join(context.extensionPath, 'node_modules', 'kuromoji', 'dict');
}

/**
 * 重新加载规则/词库数据，并把所有依赖它的状态刷一遍。
 *
 * 为什么需要它：规则和词表是这个扩展的**数据**，数据变了就得重新加载。
 * 之前只在激活时加载一次（`if (!data)` 记忆化），结果改 rules_config.json
 * 必须 Reload Window —— 那与“改 JSON 就生效”的核心承诺直接冲突（issue #6）。
 */
async function reloadData(): Promise<void> {
    const loaded = loadEngineData();

    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'markdown') {
        await highlightEditor(editor, loaded);
    }
    refreshWordbook();
    refreshReadingView();
    Promise.resolve(vscode.commands.executeCommand('markdown.preview.refresh')).catch(() => undefined);
}


/** 取选中文本 */
function selectedText(editor: vscode.TextEditor): string {
    return editor.document.getText(editor.selection).trim();
}


/** 命令1：查词 */
async function analyzeSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const selText = selectedText(editor);
    if (!selText) {
        vscode.window.showInformationMessage('请先选中日语文本');
        return;
    }
    const engineData = ensureData();
    const tokenizer = await getTokenizer();
    const raw = tokenizer.tokenize(selText);
    const jp = toJpTokens(raw, engineData);
    if (jp.length === 0) {
        vscode.window.showInformationMessage('选中内容未识别为日语');
        return;
    }
    const items = jp.map((t) => ({
        label: t.surface,
        description: t.reading ? `[${t.reading}]` : '',
        detail: `${t.lemma} ｜ 品詞:${t.pos} ｜ 語種:${t.wtype}`,
    }));
    vscode.window.showQuickPick(items, {
        title: 'JP Reader 查词',
        placeHolder: selText,
    });
}

/** 命令2：朗读 */
async function readSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const selText = selectedText(editor);
    if (!selText) {
        vscode.window.showInformationMessage('请先选中日语文本');
        return;
    }
    const cfg = vscode.workspace.getConfiguration('jpReader');
    if (!cfg.get<boolean>('enableTTS', true)) {
        vscode.window.showInformationMessage('朗读已关闭（jpReader.enableTTS）');
        return;
    }
    await speak(selText);
}

/** 命令3：语境收集 */
async function collectSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const selText = selectedText(editor);
    if (!selText) {
        vscode.window.showInformationMessage('请先选中日语文本');
        return;
    }
    const engineData = ensureData();
    const tokenizer = await getTokenizer();
    const raw = tokenizer.tokenize(selText);
    const jp = toJpTokens(raw, engineData);
    if (jp.length === 0) {
        vscode.window.showInformationMessage('选中内容未识别为日语，未收集');
        return;
    }
    const sentence = sentenceAt(
        editor.document.getText(),
        editor.document.offsetAt(editor.selection.start)
    );
    const source = editor.document.uri.fsPath;
    const seen = new Set<string>();
    let count = 0;
    for (const t of jp) {
        const key = `${t.lemma}|${t.surface}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        const ok = addEntry(dataRootPath(), {
            lemma: t.lemma,
            surfaceForm: t.surface,
            wtype: t.wtype,
            pos: t.pos,
            sentence,
            source,
            status: 'new',
            note: '',
        });
        if (ok) {
            count++;
        }
    }
    refreshLemmasFile(dataRootPath());
    await highlightEditor(editor, ensureData());
    refreshWordbook();
    vscode.window.showInformationMessage(
        `JP Reader: 已收集 ${count} 个词条 → ${path.join(dataRootPath(), 'vocab', 'my_collection.tsv')}`
    );
}

/** 命令4：中日翻译（联网可选） */
async function translateSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const selText = selectedText(editor);
    if (!selText) {
        vscode.window.showInformationMessage('请先选中日语文本');
        return;
    }
    if (!isProviderEnabled('translate')) {
        vscode.window.showInformationMessage('翻译已关闭（providers_config.json 里 translate.active = "off"）');
        return;
    }
    vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'JP Reader 翻译中…' },
        async () => {
            try {
                const out = await callProvider('translate', { text: selText });
                await vscode.window.showInformationMessage(`${selText} → ${out.content}`);
            } catch (e) {
                vscode.window.showWarningMessage(`翻译失败: ${(e as Error).message}`);
            }
        }
    );
}

/** 命令5：AI 句子讲解（联网可选，默认关闭） */
async function aiExplainSelection() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return;
    }
    const selText = selectedText(editor);
    if (!selText) {
        vscode.window.showInformationMessage('请先选中日语文本');
        return;
    }
    if (!isProviderEnabled('explain')) {
        vscode.window.showInformationMessage(
            'AI 讲解未启用：在 providers_config.json 里把 explain.active 设成具体 provider。'
        );
        return;
    }
    const sentence = sentenceAt(
        editor.document.getText(),
        editor.document.offsetAt(editor.selection.start)
    );
    vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'JP Reader AI 讲解中…' },
        async () => {
            try {
                const out = await callProvider('explain', {
                    text: selText,
                    context: { sentence },
                });
                await vscode.window.showInformationMessage(out.content);
            } catch (e) {
                vscode.window.showWarningMessage(`AI 讲解失败: ${(e as Error).message}`);
            }
        }
    );
}

export function activate(context: vscode.ExtensionContext) {
    setDictionaryDir(getDicPath(context));
    initSecrets(context.secrets);
    setExtensionDir(context.extensionPath);
    migrateLegacyAiKey().catch(() => undefined);

    // 数据（规则/词库）延迟加载；加载一次之后由文件监听器负责重载
    const engine = ensureData();
    watchDataFiles(context, engine.dataRoot, () => {
        reloadData().catch(() => undefined);
    });
    // Webview 侧边面板（单词本 / 复习）
    const wordbookView = new WordbookViewProvider(
        () => ensureData().dataRoot,
        (s) => readingOf(s)
    );
    setWordbook(wordbookView);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(WordbookViewProvider.viewType, wordbookView)
    );

    // 命令
    context.subscriptions.push(
        vscode.commands.registerCommand('jpReader.analyzeSelection', analyzeSelection),
        vscode.commands.registerCommand('jpReader.readSelection', readSelection),
        vscode.commands.registerCommand('jpReader.collectSelection', collectSelection),
        vscode.commands.registerCommand('jpReader.translateSelection', translateSelection),
        vscode.commands.registerCommand('jpReader.aiExplainSelection', aiExplainSelection),
        vscode.commands.registerCommand('jpReader.openWordbook', () => {
            vscode.commands.executeCommand('jpReader.wordbook.focus');
        }),
        vscode.commands.registerCommand('jpReader.setProviderSecret', setProviderSecret),
        vscode.commands.registerCommand('jpReader.openReadingView', () => {
            openReadingView(context).catch(() => undefined);
        })
    );

    // 振假名 + 高亮统一由 extendMarkdownIt 插件实现（见 buildMarkdownItPlugin）

    // 预加载 kuromoji；构建完成后刷新一次 markdown 预览，让高亮立即出现
    getTokenizer()
        .then(() => {
            Promise.resolve(
                vscode.commands.executeCommand('markdown.preview.refresh')
            ).catch(() => undefined);
        })
        .catch(() => undefined);

    // 打开/切换编辑器时高亮
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.languageId === 'markdown') {
                highlightEditor(editor, ensureData()).catch(() => undefined);
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((doc) => {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document === doc && doc.languageId === 'markdown') {
                highlightEditor(editor, ensureData()).catch(() => undefined);
            }
        })
    );

    // 文本修改防抖后重绘
    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((ev) => {
            if (ev.document.languageId !== 'markdown') {
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document !== ev.document) {
                return;
            }
            scheduleHighlightRefresh(() => {
                highlightEditor(editor, ensureData()).catch(() => undefined);
            });
        })
    );

    // 启动后对当前 markdown 编辑器立即高亮
    const active = vscode.window.activeTextEditor;
    if (active && active.document.languageId === 'markdown') {
        highlightEditor(active, ensureData()).catch(() => undefined);
    }

    vscode.window.showInformationMessage('JP Reader 已激活：打开日语 markdown 课文即可高亮。');

    // 返回给 VS Code 的 markdown 预览插件钩子（官方 markdown.markdownItPlugins 机制）。
    // 规则表用 getter 传进去：预览可能比数据加载更早发生，也可能在数据重载之后重渲染。
    return {
        extendMarkdownIt: (md: any) => buildMarkdownItPlugin(md, { getEngineData: currentData }),
    };
}

export function deactivate() {
    disposeDecorations();
}
