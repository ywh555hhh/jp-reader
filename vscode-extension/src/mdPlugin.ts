import { readyTokenizer } from './appContext';
import { toJpTokens, matchRules } from './ruleEngine';
import { RuleEngineData } from './dataLoader';
import { createMatcher, SourceToken } from './readingSource';
import { cssClassOf, cssDeclarationsOf } from './highlightStyle';
import * as vscode from 'vscode';

/**
 * Markdown 渲染插件：在 markdown-it 管线里注入 JP Reader 高亮。
 *
 * 原理：重写 markdown-it 的 `text` 渲染规则。VS Code 渲染 markdown 时，
 * 每个普通文本叶子节点都会走这里；我们用 kuromoji 分词 + 规则引擎，
 * 把日语词包成 <span class="jp ...">。
 *
 * 两条硬约束（见 docs/architecture.md）：
 *   A5 渲染层不认识任何具体的规则 id —— 样式一律由 rules_config 的 `style` 生成
 *      （曾经的 classForRule switch 让"改 JSON 就生效"只对硬编码过的 id 成立）
 *   A6 高亮 span 带的是**真实 offset**（由 readingSource 的单调匹配器给出），
 *      不用 indexOf 反查
 *
 * 注意：本模块不再持有模块级可变状态。需要规则表就由调用方把 getter 传进来，
 * 这样一个扩展实例里多个预览/面板互不干扰（A10）。
 */

export interface MarkdownItPluginOptions {
    /** 取当前的规则引擎数据。允许返回 null（还没加载完）。 */
    getEngineData: () => RuleEngineData | null;
    /**
     * 源文索引。给了它，span 上会带 data-offset（阅读视图需要），
     * 没给就是纯预览（VS Code 自带预览，没有划词收集功能）。
     */
    source?: SourceToken[];
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function hasJapanese(s: string): boolean {
    return /[\u3040-\u30ff\u3400-\u9fff]/.test(s);
}

function hasKanji(s: string): boolean {
    for (const ch of s) {
        const c = ch.charCodeAt(0);
        if ((c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff)) {
            return true;
        }
    }
    return false;
}

function isKana(s: string): boolean {
    return /^[\u3040-\u30ffー]+$/.test(s);
}

function furiganaOn(): boolean {
    const cfg = vscode.workspace.getConfiguration('jpReader');
    return !!cfg.get<boolean>('enableFurigana', false);
}

interface RenderToken {
    surface: string;
    lemma: string;
    wtype: string;
    reading: string;
}

/**
 * 渲染一个词。
 * 注意：**所有日语词都会包 span**（不只是命中规则的），这样划词时总能拿到 offset；
 * 样式只对命中规则的词生效 —— 这解决了"选中未高亮的词就定位不到原句"的问题。
 */
function renderToken(t: RenderToken, style: string, cls: string | null, offset: number | null): string {
    const showFurigana = furiganaOn() && hasKanji(t.surface) && t.reading && isKana(t.reading);
    const inner = showFurigana
        ? `<ruby>${escapeHtml(t.surface)}<rt>${escapeHtml(t.reading)}</rt></ruby>`
        : escapeHtml(t.surface);

    const attrs: string[] = ['class="jp' + (cls ? ` ${cls}` : '') + '"'];
    if (style) {
        attrs.push(`style="${escapeHtml(style)}"`);
    }
    attrs.push(`data-lemma="${escapeHtml(t.lemma)}"`);
    attrs.push(`data-surface="${escapeHtml(t.surface)}"`);
    attrs.push(`data-wtype="${escapeHtml(t.wtype)}"`);
    if (offset !== null) {
        attrs.push(`data-offset="${offset}"`);
    }
    return `<span ${attrs.join(' ')}>${inner}</span>`;
}

function installTextRenderer(md: any, defaultText: any, options: MarkdownItPluginOptions): void {
    const matchOffset = options.source ? createMatcher(options.source) : null;

    md.renderer.rules.text = (tokens: any[], idx: number, _o: any, env: any, self: any) => {
        const content: string = tokens[idx].content;
        const engineData = options.getEngineData();
        const tk = readyTokenizer();
        if (!tk || !engineData || !hasJapanese(content)) {
            return defaultText ? defaultText(tokens, idx, _o, env, self) : escapeHtml(content);
        }

        const jp = toJpTokens(tk.tokenize(content), engineData);

        let html = '';
        let cursor = 0;
        for (const t of jp) {
            const pos = content.indexOf(t.surface, cursor);
            if (pos === -1) {
                continue;
            }
            if (pos > cursor) {
                html += escapeHtml(content.slice(cursor, pos));
            }
            const hits = matchRules(t, engineData);
            const rule = hits.length > 0 ? hits[0] : null;
            const style = rule ? cssDeclarationsOf(rule.style) : '';
            const cls = rule ? cssClassOf(rule.id) : null;
            const offset = matchOffset ? matchOffset(t.surface) : null;
            html += renderToken(t, style, cls, offset);
            cursor = pos + t.surface.length;
        }
        if (cursor < content.length) {
            html += escapeHtml(content.slice(cursor));
        }
        return html;
    };
}

/** 供 extension.activate 的 extendMarkdownIt 与阅读视图调用：把插件挂到 md 实例上 */
export function buildMarkdownItPlugin(md: any, options: MarkdownItPluginOptions): any {
    const defaultText = md.renderer.rules.text;
    installTextRenderer(md, defaultText, options);
    return md;
}
