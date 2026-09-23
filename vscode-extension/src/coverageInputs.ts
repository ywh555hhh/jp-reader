import { groupByLemma } from './collection';
import { MASTERED_INTERVAL_DAYS } from './coverage';
import { loadReviewStates } from './reviewStore';

/**
 * 组装覆盖率分析需要的三个集合。
 *
 * 单独一个模块的理由：`coverage.ts` 是纯计算（不认识文件），而这里需要读数据根 ——
 * 命令面板与阅读视图都要这套"什么是已见/已掌握/重点词"，所以只能有一份实现，
 * 否则两处会慢慢给出不同的结论（本项目最常见的坏味道）。
 */

export interface CoverageInputs {
    /** 见过的词：收集过的 lemma */
    known: string[];
    /** 已掌握的词：复习间隔达到阈值的 lemma */
    mastered: string[];
    /** 重点词表：rules_config.json 里所有按文件配置的词表并集 */
    priority: string[];
}

export function collectCoverageInputs(
    dataRoot: string,
    ruleLemmaSets: Iterable<Set<string> | undefined>
): CoverageInputs {
    const known = [...groupByLemma(dataRoot).keys()];

    const { states } = loadReviewStates(dataRoot);
    const mastered: string[] = [];
    for (const [lemma, state] of states) {
        if (state.lastReviewed !== '' && state.intervalDays >= MASTERED_INTERVAL_DAYS) {
            mastered.push(lemma);
        }
    }

    const priority = new Set<string>();
    for (const set of ruleLemmaSets) {
        if (set) {
            for (const lemma of set) {
                priority.add(lemma);
            }
        }
    }

    return { known, mastered, priority: [...priority] };
}
