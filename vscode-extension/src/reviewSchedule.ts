/**
 * 复习调度（SM-2 的简化版）。
 *
 * 纯函数：不读文件、不认识 vscode、"今天"由调用方传入 ——
 * 所以能被确定性地单测（tests/reviewSchedule.test.mjs），也不会因为时区/系统时间
 * 在测试里飘。
 *
 * 为什么不是"加权随机池"：随机抽词的复习量与实际记忆强度无关，会出现
 * "熟悉的词反复出现、生词永远不出现"。间隔重复的核心是**每个词有独立的下次到期日**，
 * 到期才复习、答对就拉长间隔、答错就回到当天。
 */

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy';

export interface ReviewState {
    lemma: string;
    /** 下次到期日（YYYY-MM-DD） */
    due: string;
    /** 间隔天数（0 表示今天还要再看一次） */
    intervalDays: number;
    /** 难度因子：越小说明这个词对你越难 */
    ease: number;
    /** 连续答对次数 */
    reps: number;
    /** 遗忘次数 */
    lapses: number;
    /** 上次复习日期（YYYY-MM-DD）；空串 = 从未复习过（新词） */
    lastReviewed: string;
}

/** @public 难度因子初值；供测试与文档引用 */
export const INITIAL_EASE = 2.5;
/** @public 难度因子下界；tests/reviewSchedule.test.mjs 钉住它 */
export const MIN_EASE = 1.3;
/** @public 难度因子上界；tests/reviewSchedule.test.mjs 钉住它 */
export const MAX_EASE = 3.0;
/** 新词每日上限的默认值（可用 jpReader.newWordsPerDay 覆盖） */
export const DEFAULT_NEW_LIMIT = 10;

/**
 * 复习是"按天"的概念，所以用**本地**日期而不是 UTC —— 否则晚上复习会被算到明天。
 *
 * @public 日期工具是纯函数，被 tests/reviewSchedule.test.mjs 直接验证（本项目里没有第二个日期实现）
 */
export function toDateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function todayKey(now: Date = new Date()): string {
    return toDateKey(now);
}

/**
 * 在 YYYY-MM-DD 上加天数（按本地时间做，避免夏令时把日期推偏）。
 *
 * @public 被测试直接验证
 */
export function addDays(dateKey: string, days: number): string {
    const [y, m, d] = dateKey.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    date.setDate(date.getDate() + days);
    return toDateKey(date);
}

/**
 * 两个日期之间相差的天数（b - a）。
 *
 * @public 被测试直接验证
 */
export function daysBetween(a: string, b: string): number {
    const [ay, am, ad] = a.split('-').map(Number);
    const [by, bm, bd] = b.split('-').map(Number);
    const ms = new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime();
    return Math.round(ms / 86400000);
}

export function newState(lemma: string, today: string): ReviewState {
    return {
        lemma,
        due: today,
        intervalDays: 0,
        ease: INITIAL_EASE,
        reps: 0,
        lapses: 0,
        lastReviewed: '',
    };
}

/**
 * 到期（含已过期）；YYYY-MM-DD 的字符串比较等价于日期比较。
 *
 * @public 被测试直接验证
 */
export function isDue(state: ReviewState, today: string): boolean {
    return state.due <= today;
}

function clampEase(ease: number): number {
    return Math.min(MAX_EASE, Math.max(MIN_EASE, Number(ease.toFixed(2))));
}

/**
 * 打一个分，返回**新的**状态（不改原对象）。
 *
 *   again 忘了   → 回到当天、难度 +，进入下一次队列
 *   hard  模糊   → 间隔只小幅增长，难度略 +
 *   good  记住了 → 标准增长（1 天 → 3 天 → interval × ease）
 *   easy  太简单 → 增长更多，难度 −
 */
export function grade(state: ReviewState, grade: ReviewGrade, today: string): ReviewState {
    const next: ReviewState = { ...state, lastReviewed: today, reps: state.reps + 1 };

    switch (grade) {
        case 'again':
            next.reps = 0;
            next.lapses = state.lapses + 1;
            next.ease = clampEase(state.ease - 0.2);
            next.intervalDays = 0;
            break;
        case 'hard':
            next.intervalDays = state.intervalDays < 1 ? 1 : Math.max(1, Math.round(state.intervalDays * 1.2));
            next.ease = clampEase(state.ease - 0.15);
            break;
        case 'good':
            if (state.intervalDays < 1) {
                next.intervalDays = 1;
            } else if (state.intervalDays === 1) {
                next.intervalDays = 3;
            } else {
                next.intervalDays = Math.round(state.intervalDays * state.ease);
            }
            break;
        case 'easy':
            next.intervalDays =
                state.intervalDays < 1
                    ? 3
                    : Math.max(4, Math.round(state.intervalDays * state.ease * 1.3));
            next.ease = clampEase(state.ease + 0.15);
            break;
    }

    next.due = addDays(today, next.intervalDays);
    return next;
}

export interface ReviewQueue {
    /** 到期的词（先复习这些） */
    due: string[];
    /** 还没学过的新词（按日限额补充） */
    fresh: string[];
}

export interface QueueOptions {
    newLimit?: number;
    reviewLimit?: number;
}

/**
 * 组队列：到期的优先，不足时按日限额补新词。
 * 传入的是"你收集过的所有 lemma"，所以没进过复习的词会被当作新词 —— 而不是被漏掉。
 */
export function buildQueue(
    lemmas: Iterable<string>,
    states: Map<string, ReviewState>,
    today: string,
    options: QueueOptions = {}
): ReviewQueue {
    const due: string[] = [];
    const fresh: string[] = [];
    for (const lemma of lemmas) {
        const state = states.get(lemma);
        if (!state || state.lastReviewed === '') {
            fresh.push(lemma);
        } else if (isDue(state, today)) {
            due.push(lemma);
        }
    }
    // 到期早的先来；都是同一天到期时按 lemma 排序，保证队列可复现（便于测试与排查）
    due.sort((a, b) => {
        const sa = states.get(a);
        const sb = states.get(b);
        const da = sa ? sa.due : today;
        const db = sb ? sb.due : today;
        return da === db ? a.localeCompare(b) : da.localeCompare(db);
    });
    fresh.sort((a, b) => a.localeCompare(b));

    return {
        due: due.slice(0, options.reviewLimit ?? 200),
        fresh: fresh.slice(0, options.newLimit ?? DEFAULT_NEW_LIMIT),
    };
}

export interface ReviewStats {
    /** 今天到期的词数 */
    due: number;
    /** 还没学过的新词数 */
    fresh: number;
    /** 今天已经复习过的词数（按 lastReviewed 统计） */
    reviewedToday: number;
    /** 全部已收集的词数 */
    total: number;
}

export function computeStats(
    lemmas: Iterable<string>,
    states: Map<string, ReviewState>,
    today: string
): ReviewStats {
    let due = 0;
    let fresh = 0;
    let reviewedToday = 0;
    let total = 0;
    for (const lemma of lemmas) {
        total += 1;
        const state = states.get(lemma);
        if (!state || state.lastReviewed === '') {
            fresh += 1;
            continue;
        }
        if (isDue(state, today)) {
            due += 1;
        }
        if (state.lastReviewed === today) {
            reviewedToday += 1;
        }
    }
    return { due, fresh, reviewedToday, total };
}

/** 给界面用的"下次复习"文案 */
export function dueText(state: ReviewState | undefined, today: string): string {
    if (!state || state.lastReviewed === '') {
        return '新词';
    }
    const diff = daysBetween(today, state.due);
    if (diff < 0) {
        return `已到期 ${-diff} 天`;
    }
    if (diff === 0) {
        return '今天到期';
    }
    if (diff === 1) {
        return '明天复习';
    }
    return `${diff} 天后复习`;
}
