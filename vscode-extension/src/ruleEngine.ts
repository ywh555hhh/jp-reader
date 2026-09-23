import { JpToken, RuleEngineData, LoadedRule, resolveLemma, getWtype, isJapaneseChar } from './dataLoader';
import { KuromojiToken } from 'kuromoji';

/** 将 kuromoji token 转成 JP Reader 内部 token，并应用 lemma 映射 + wtype 查表 */
export function toJpTokens(tokens: KuromojiToken[], data: RuleEngineData): JpToken[] {
    const out: JpToken[] = [];
    for (const t of tokens) {
        // 跳过纯标点/非日语
        if (t.surface_form.trim() === '') {
            continue;
        }
        if (!isJapaneseChar(t.surface_form[0])) {
            continue;
        }
        const lemma = resolveLemma(t.basic_form, data.lemmaMapping);
        out.push({
            surface: t.surface_form,
            basicForm: t.basic_form,
            reading: t.reading || '',
            pos: t.pos_detail_1 ? `${t.pos}_${t.pos_detail_1}` : t.pos,
            lemma,
            wtype: getWtype(lemma, data.lemmaWtype),
        });
    }
    return out;
}

/** 规则匹配：对 token 应用启用的规则，返回按 priority 降序命中的规则列表 */
export function matchRules(token: JpToken, data: RuleEngineData): LoadedRule[] {
    const hits: LoadedRule[] = [];
    for (const rule of data.rules) {
        if (!rule.enable) {
            continue;
        }
        if (matchRule(token, rule)) {
            hits.push(rule);
        }
    }
    hits.sort((a, b) => b.priority - a.priority);
    return hits;
}

function matchRule(token: JpToken, rule: LoadedRule): boolean {
    const m = rule.match;
    if (!m) {
        return false;
    }
    // lemma_in_file：lemma 命中集合
    if (m.lemma_in_file) {
        if (rule.lemmaSet && rule.lemmaSet.has(token.lemma)) {
            return true;
        }
        return false;
    }
    // wtype：token 语种命中
    if (m.wtype && m.wtype.length > 0) {
        return m.wtype.includes(token.wtype);
    }
    return false;
}
