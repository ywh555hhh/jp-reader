import * as vscode from 'vscode';
import * as path from 'path';
import { toJpTokens } from './ruleEngine';
import { analyzeCoverage, countLemmas, summarize } from './coverage';
import { collectCoverageInputs } from './coverageInputs';
import { sentenceAt } from './readingSource';
import { highlightEditor } from './highlighter';
import { addEntry, refreshLemmasFile } from './collection';
import { speak } from './tts';
import { openReadingView, refreshReadingView } from './readingView';
import {
    callProvider,
    dataRootPath,
    dictionarySummary,
    lookupDefinitions,
    ensureData,
    getTokenizer,
    isProviderEnabled,
    refreshWordbook,
    setProviderSecret,
} from './appContext';

/**
 * 全部用户命令的实现。
 *
 * 单独一个模块的理由：这些函数只依赖 appContext 提供的事实与几个领域模块，
 * 与"扩展怎么启动、面板怎么注册"无关。放在 extension.ts 里会把那个文件顶过
 * 350 行预警线（否命题 A19），也会让"生命周期编排"和"具体功能"混在一起。
 *
 * 注册动作由 registerCommands() 返回 Disposable 数组，订阅的归属权留在调用方。
 */

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
    const items = jp.map((t) => {
        const { entries } = lookupDefinitions(t.lemma);
        const glosses = entries.flatMap((e) => e.glosses).slice(0, 4);
        return {
            label: t.surface,
            description: t.reading ? `[${t.reading}]` : '',
            detail:
                `${t.lemma} ｜ 品詞:${t.pos} ｜ 語種:${t.wtype}` +
                (glosses.length > 0 ? ` ｜ ${glosses.join('；')}` : ''),
        };
    });
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
    // 新收集的词要让阅读视图里的覆盖率/高亮也跟着变
    refreshReadingView();
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

/**
 * 命令6：分析当前课文的覆盖率（纯本地，不联网）。
 *
 * 回答"这篇课文现在读不读"：见了多少词、还有哪些生词、其中哪些是重点词表里的。
 */
async function analyzeCoverageSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'markdown') {
        vscode.window.showWarningMessage('请先打开一个 Markdown 课文文件');
        return;
    }
    const engineData = ensureData();
    const tokenizer = await getTokenizer();
    const lemmas = toJpTokens(tokenizer.tokenize(editor.document.getText()), engineData).map(
        (t) => t.lemma
    );

    const inputs = collectCoverageInputs(
        engineData.dataRoot,
        engineData.rules.map((r) => r.lemmaSet)
    );
    const report = analyzeCoverage(
        countLemmas(lemmas),
        inputs.known,
        inputs.mastered,
        inputs.priority
    );

    const limit = 100;
    const items = report.unknown.slice(0, limit).map((u) => ({
        label: `${u.priority ? '★ ' : ''}${u.lemma}`,
        description: `出现 ${u.count} 次`,
        detail: u.priority ? '在你的重点词表里' : '不在你的重点词表里',
    }));

    if (items.length === 0) {
        vscode.window.showInformationMessage(`JP Reader: ${summarize(report)}`);
        return;
    }

    const suffix =
        report.unknownUnique > limit ? `（只列出前 ${limit} 个）` : '';
    const picked = await vscode.window.showQuickPick(items, {
        title: summarize(report),
        placeHolder: `生词 ${report.unknownUnique} 个${suffix} —— ★ 表示在你的重点词表里`,
        matchOnDescription: true,
    });

    if (picked) {
        // 选中后把该词在编辑器里选中，方便接着查词/收集
        const surface = picked.label.replace(/^★ /, '');
        const text = editor.document.getText();
        const at = text.indexOf(surface);
        if (at >= 0) {
            const start = editor.document.positionAt(at);
            const end = editor.document.positionAt(at + surface.length);
            editor.selection = new vscode.Selection(start, end);
            editor.revealRange(new vscode.Range(start, end));
        }
    }
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

/** 命令7：检查词典（路径对不对、加载了多少词条、有哪些坏行） */
async function checkDictionary(): Promise<void> {
    const summary = dictionarySummary();
    const detail = await vscode.window.showInformationMessage(`JP Reader 词典：${summary}`, '打开设置');
    if (detail === '打开设置') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'jpReader.dictionaryPath');
    }
}

/** 注册全部命令；返回的 Disposable 由调用方放进 context.subscriptions */
export function registerCommands(context: vscode.ExtensionContext): vscode.Disposable[] {
    return [
        vscode.commands.registerCommand('jpReader.analyzeSelection', analyzeSelection),
        vscode.commands.registerCommand('jpReader.readSelection', readSelection),
        vscode.commands.registerCommand('jpReader.collectSelection', collectSelection),
        vscode.commands.registerCommand('jpReader.translateSelection', translateSelection),
        vscode.commands.registerCommand('jpReader.aiExplainSelection', aiExplainSelection),
        vscode.commands.registerCommand('jpReader.analyzeCoverage', analyzeCoverageSelection),
        vscode.commands.registerCommand('jpReader.checkDictionary', checkDictionary),
        vscode.commands.registerCommand('jpReader.openWordbook', () => {
            vscode.commands.executeCommand('jpReader.wordbook.focus');
        }),
        vscode.commands.registerCommand('jpReader.setProviderSecret', setProviderSecret),
        vscode.commands.registerCommand('jpReader.openReadingView', () => {
            openReadingView(context).catch(() => undefined);
        })
    ];
}
