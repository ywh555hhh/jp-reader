import * as vscode from 'vscode';
import { RuleEngineData, isJapaneseChar, resolveLemma, getWtype } from './dataLoader';
import { matchRules } from './ruleEngine';
import { getTokenizer } from './appContext';

/**
 * 高亮渲染：对文档逐行分词，按命中规则的最高优先级样式分组，
 * 每组一个 TextEditorDecorationType，set 到编辑器视图。
 */
export async function highlightEditor(
    editor: vscode.TextEditor,
    data: RuleEngineData
): Promise<void> {
    const tokenizer = await getTokenizer();
    const doc = editor.document;

    // styleKey -> Range[]
    const groups = new Map<string, vscode.Range[]>();

    for (let lineNo = 0; lineNo < doc.lineCount; lineNo++) {
        const line = doc.lineAt(lineNo);
        const text = line.text;
        if (!text) {
            continue;
        }
        let tokens;
        try {
            tokens = tokenizer.tokenize(text);
        } catch (e) {
            continue;
        }
        for (const t of tokens) {
            const surface = t.surface_form;
            if (!surface || surface.trim() === '' || !isJapaneseChar(surface[0])) {
                continue;
            }
            const lemma = resolveLemma(t.basic_form, data.lemmaMapping);
            const wtype = getWtype(lemma, data.lemmaWtype);
            const token = {
                surface,
                basicForm: t.basic_form,
                reading: t.reading || '',
                pos: t.pos_detail_1 ? `${t.pos}_${t.pos_detail_1}` : t.pos,
                lemma,
                wtype,
            };
            const hits = matchRules(token, data);
            if (hits.length === 0) {
                continue;
            }
            const rule = hits[0]; // 最高优先级
            const start = t.word_position;
            const end = start + surface.length;
            const range = new vscode.Range(lineNo, start, lineNo, end);
            const arr = groups.get(rule.styleKey);
            if (arr) {
                arr.push(range);
            } else {
                groups.set(rule.styleKey, [range]);
            }
        }
    }

    // 清理旧的装饰
    clearAllDecorations(editor);
    for (const [styleKey, ranges] of groups) {
        const deco = getDecorationType(styleKey);
        editor.setDecorations(deco, ranges);
    }
}

const decorationCache = new Map<string, { type: vscode.TextEditorDecorationType; style: any }>();

function getDecorationType(styleKey: string): vscode.TextEditorDecorationType {
    // styleKey 形如 {"color":"#4ade80","fontWeight":"500"}
    let entry = decorationCache.get(styleKey);
    if (entry) {
        return entry.type;
    }
    let style: any;
    try {
        style = JSON.parse(styleKey);
    } catch {
        style = {};
    }
    const type = vscode.window.createTextEditorDecorationType({
        color: style.color,
        fontWeight: style.fontWeight,
        fontStyle: style.fontStyle,
        textDecoration: style.textDecoration ? `underline ${style.textDecoration}` : undefined,
    });
    decorationCache.set(styleKey, { type, style });
    return type;
}

function clearAllDecorations(editor: vscode.TextEditor): void {
    for (const [, { type }] of decorationCache) {
        editor.setDecorations(type, []);
    }
}

export function disposeDecorations(): void {
    for (const [, { type }] of decorationCache) {
        type.dispose();
    }
    decorationCache.clear();
}
