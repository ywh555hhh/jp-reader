/**
 * 课文覆盖率分析。
 *
 * 回答的问题是：**这篇课文里，我还不认识的词有几个、值不值得现在读。**
 *
 * 纯函数：只吃"词 → 出现次数"和你自己的已知集合，不认识 vscode、不读文件 ——
 * 所以能被确定性单测，也能在阅读视图、命令面板、输出面板任何地方复用。
 *
 * 术语：
 *   · 覆盖率 = 你**见过**的词出现次数 / 总词数（"见没见过"比"记没记住"更适合当阅读门槛）
 *   · 生词   = 你没收集过的词
 *   · 重点生词 = 生词里同时出现在你配置的词表规则里的（例如 CEJC P99 和语表）——
 *                这些是"日常会话高频但你还不会"的词，优先学性价比最高
 */

// 用码点序而不是 localeCompare：后者的顺序随 ICU 版本/语言环境变化，
// 会让同一篇课文在不同机器上给出不同的生词顺序（用户会以为结果随机）。
const byCodepoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export interface TokenCount {
    lemma: string;
    /** 在课文里出现的次数 */
    count: number;
}

interface UnknownWord {
    lemma: string;
    count: number;
    /** 是否在你配置的重点词表里 */
    priority: boolean;
}

export interface CoverageReport {
    /** 总词数（按出现次数计） */
    total: number;
    /** 不同词数 */
    unique: number;
    /** 见过的词：出现次数 / 不同词数 */
    knownTokens: number;
    knownUnique: number;
    /** 已掌握（复习间隔 ≥ MASTERED_INTERVAL_DAYS）的出现次数 */
    masteredTokens: number;
    /** 生词：出现次数 / 不同词数 */
    unknownTokens: number;
    unknownUnique: number;
    /** 覆盖率 0~1（见过的词出现次数 / 总词数） */
    coverage: number;
    /** 生词表（按出现次数降序，同次数按 lemma 排序，保证可复现） */
    unknown: UnknownWord[];
}

/** 复习间隔达到这个天数就算"掌握"（与 reviewSchedule 的默认序列一致：1 → 3 → 8 → 20） */
export const MASTERED_INTERVAL_DAYS = 21;

/**
 * 从"lemma → 出现次数"统计覆盖率。
 *
 * @param tokens  课文里的词与出现次数（调用方负责分词与 lemma 归一）
 * @param known   你见过的 lemma（通常是收集过的词）
 * @param mastered 你已掌握的 lemma（可选；没给就按空集合算）
 * @param priority 重点词表（可选；通常是 rules_config.json 里配置的词表并集）
 */
export function analyzeCoverage(
    tokens: Iterable<TokenCount>,
    known: Iterable<string>,
    mastered: Iterable<string> = [],
    priority: Iterable<string> = []
): CoverageReport {
    const knownSet = new Set(known);
    const masteredSet = new Set(mastered);
    const prioritySet = new Set(priority);

    let total = 0;
    let unique = 0;
    let knownTokens = 0;
    let knownUnique = 0;
    let masteredTokens = 0;
    let unknownTokens = 0;
    const unknown: UnknownWord[] = [];

    for (const { lemma, count } of tokens) {
        if (!lemma || count <= 0) {
            continue;
        }
        total += count;
        unique += 1;
        if (knownSet.has(lemma)) {
            knownTokens += count;
            knownUnique += 1;
            if (masteredSet.has(lemma)) {
                masteredTokens += count;
            }
            continue;
        }
        unknownTokens += count;
        unknown.push({ lemma, count, priority: prioritySet.has(lemma) });
    }

    unknown.sort((a, b) => (b.count === a.count ? byCodepoint(a.lemma, b.lemma) : b.count - a.count));

    return {
        total,
        unique,
        knownTokens,
        knownUnique,
        masteredTokens,
        unknownTokens,
        unknownUnique: unknown.length,
        coverage: total === 0 ? 1 : knownTokens / total,
        unknown,
    };
}

/** 把分词结果折成"lemma → 出现次数" */
export function countLemmas(lemmas: Iterable<string>): TokenCount[] {
    const counts = new Map<string, number>();
    for (const lemma of lemmas) {
        if (!lemma) {
            continue;
        }
        counts.set(lemma, (counts.get(lemma) ?? 0) + 1);
    }
    return [...counts.entries()].map(([lemma, count]) => ({ lemma, count }));
}

/** 给界面用的一行摘要 */
export function summarize(report: CoverageReport): string {
    const pct = Math.round(report.coverage * 100);
    if (report.total === 0) {
        return '这篇课文里没识别到日语词。';
    }
    const priorityUnknown = report.unknown.filter((u) => u.priority).length;
    return (
        `本课 ${report.total} 词（${report.unique} 种）｜见过 ${pct}%｜` +
        `生词 ${report.unknownUnique} 个（其中 ${priorityUnknown} 个是重点词表里的）`
    );
}
