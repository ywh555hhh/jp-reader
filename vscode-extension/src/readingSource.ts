import { Tokenizer } from 'kuromoji';

/**
 * 源文定位：把"渲染出来的高亮 span"和"它在源文里的真实位置"对上。
 *
 * 为什么需要它：从表层形式反查位置（`fullText.indexOf(surface)`）只能拿到**全文第一次出现**，
 * 同一个词在课文里出现多次时，收集到的原句会是另一句，而且不报错、不崩溃，
 * 只是安静地存错数据（issue #5 / 否命题 A6）。
 *
 * 这个模块刻意不依赖 vscode，纯函数、可单测（见 tests/readingSource.test.mjs）。
 */

export interface SourceToken {
    /** 表层形式（与 kuromoji 一致） */
    surface: string;
    /** 在**源文**里的绝对字符偏移 */
    offset: number;
}

/**
 * 对整篇源文分词，得到"表层形式 → 绝对偏移"的索引。
 * kuromoji 的 word_position 就是源文里的字符位置，直接用，不做任何反查。
 */
export function buildSourceIndex(rawText: string, tokenizer: Tokenizer): SourceToken[] {
    return tokenizer
        .tokenize(rawText)
        .filter((t) => t.surface_form.trim() !== '')
        .map((t) => ({ surface: t.surface_form, offset: t.word_position }));
}

/**
 * 单调匹配器。
 *
 * markdown-it 渲染 inline 内容时顺序与源文一致（强调/链接只是去掉标记，正文顺序不变），
 * 所以可以"从上次命中的位置往后找下一个相同表层形式"来对齐。
 * 匹配不上就返回 null —— 宁可这个 span 没有 offset，也不要给它一个错的 offset：
 * 错的 offset 会安静地指向另一句，正是这个模块要消灭的 bug。
 */
export function createMatcher(index: SourceToken[]): (surface: string) => number | null {
    let cursor = 0;
    return function match(surface: string): number | null {
        for (let i = cursor; i < index.length; i += 1) {
            if (index[i].surface === surface) {
                cursor = i + 1;
                return index[i].offset;
            }
        }
        return null;
    };
}

/** 句子边界：句末标点与换行都算，但换行不作为"句子的一部分" */
const SENTENCE_DELIMITERS = /[。！？.!?\n\r]/;
/** 会被收进句子里的句末标点（换行不算） */
const SENTENCE_TERMINATORS = /[。！？.!?]/;

/**
 * 以 offset 为锚点取出完整句子。
 *
 * 编辑器路径（extension.ts）与阅读视图路径**共用这一个实现**：
 * 以前两边各有一份，规则不完全一致，同一处文本会得到不同的"原句"。
 *
 * 逗号（、，）不算边界；句末标点会包含进来（"起きます。" 比 "起きます" 更适合当复习语境）。
 * offset 非法时返回空串，由调用方给出明确提示，绝不退化成"猜一个位置"。
 */
export function sentenceAt(text: string, offset: number): string {
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
        return '';
    }
    let start = offset;
    while (start > 0 && !SENTENCE_DELIMITERS.test(text[start - 1])) {
        start -= 1;
    }
    let end = offset;
    while (end < text.length && !SENTENCE_DELIMITERS.test(text[end])) {
        end += 1;
    }
    if (end < text.length && SENTENCE_TERMINATORS.test(text[end])) {
        end += 1;
    }
    return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

// @ts-ignore
const probeSuppression = 1 as any;
