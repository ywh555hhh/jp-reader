/**
 * 规则样式 → CSS 的翻译层。
 *
 * 这是"改 rules_config.json 就能定义新规则、不用改代码"能成立的**唯一**原因：
 * 渲染层不认识任何具体的规则 id，只把数据翻译成 CSS（否命题 A5）。
 *
 * 刻意不依赖 vscode：纯函数，可单测（tests/highlightStyle.test.mjs）。
 * 也刻意只接受白名单取值：规则配置是用户手写的 JSON，
 * 不能让它把任意字符串塞进 HTML 属性里。
 */

export interface HighlightStyle {
    color?: string;
    fontWeight?: string;
    fontStyle?: string;
    /** 下划线样式：solid / dotted / dashed / double / wavy */
    textDecoration?: string;
}

const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%]+\)|[a-zA-Z]{3,20})$/;
const WEIGHT_RE = /^(normal|bold|bolder|lighter|[1-9]00)$/;
const FONT_STYLE_RE = /^(normal|italic|oblique)$/;
const DECORATION_RE = /^(solid|double|dotted|dashed|wavy)$/;

/** 规则样式 → 内联 CSS 声明（非法的取值会被静默丢弃，而不是拼进属性里） */
export function cssDeclarationsOf(style: HighlightStyle | undefined): string {
    if (!style) {
        return '';
    }
    const parts: string[] = [];
    if (style.color && COLOR_RE.test(style.color)) {
        parts.push(`color:${style.color}`);
    }
    if (style.fontWeight && WEIGHT_RE.test(style.fontWeight)) {
        parts.push(`font-weight:${style.fontWeight}`);
    }
    if (style.fontStyle && FONT_STYLE_RE.test(style.fontStyle)) {
        parts.push(`font-style:${style.fontStyle}`);
    }
    if (style.textDecoration && DECORATION_RE.test(style.textDecoration)) {
        parts.push(`text-decoration:underline ${style.textDecoration}`);
    }
    return parts.join(';');
}

/**
 * 规则 id → 稳定的类名。
 * 类名只是留给用户在自己 CSS 里进一步定制的钩子，**样式本身不依赖它**。
 */
export function cssClassOf(ruleId: string): string {
    const safe = String(ruleId)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return safe ? `jp-${safe}` : 'jp-mark';
}
