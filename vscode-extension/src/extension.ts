import * as vscode from 'vscode';
import * as path from 'path';
import { highlightEditor, disposeDecorations } from './highlighter';
import { WordbookViewProvider, readingOf } from './wordbookView';
import { buildMarkdownItPlugin } from './mdPlugin';
import { watchDataFiles } from './dataWatcher';
import { refreshReadingView } from './readingView';
import { registerCommands } from './commands';
import {
    currentData,
    ensureData,
    getTokenizer,
    initSecrets,
    loadEngineData,
    migrateLegacyAiKey,
    refreshWordbook,
    scheduleHighlightRefresh,
    setDictionaryDir,
    setExtensionDir,
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

    // 命令（实现都在 commands.ts；这里只负责注册与生命周期）
    context.subscriptions.push(...registerCommands(context));

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
