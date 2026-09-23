import * as fs from 'fs';
import * as path from 'path';
import { atomicWrite } from './atomicFile';
import { ReviewState, newState } from './reviewSchedule';

/**
 * 复习状态的持久化：`vocab/review_state.tsv`
 *
 * 为什么单独一个文件而不是塞进 my_collection.tsv：
 *   · 收集词条是"词 + 语境"（一个词可以有多条，来自不同课文）
 *   · 复习状态是"这个词我背得怎么样"（每个 lemma 只有一条）
 * 两者的粒度不同，混在一张表里迟早会出现"同一个词两条记录状态不一致"。
 *
 * 落盘走 atomicWrite（否命题 A20）：这份文件也是用户的唯一副本。
 * 读的时候尽量宽容：坏行只报 problem 并跳过，不能让一个手抖的编辑毁掉整个复习进度。
 */

const HEADER = 'lemma\tdue\tinterval_days\tease\treps\tlapses\tlast_reviewed';

export interface ReviewStore {
    states: Map<string, ReviewState>;
    /** 解析时发现的问题（坏行、字段数不对……）。由宿主决定怎么提示 */
    problems: string[];
}

/**
 * 复习状态文件的位置。
 *
 * @public 被 tests/reviewStore.test.mjs 用来直接构造/检查文件
 */
export function reviewStatePath(dataRoot: string): string {
    return path.join(dataRoot, 'vocab', 'review_state.tsv');
}

function num(value: string | undefined, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export function loadReviewStates(dataRoot: string): ReviewStore {
    const file = reviewStatePath(dataRoot);
    const states = new Map<string, ReviewState>();
    const problems: string[] = [];
    if (!fs.existsSync(file)) {
        return { states, problems };
    }

    let lineNo = 0;
    for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
        lineNo += 1;
        const line = raw.replace(/\r$/, '');
        const t = line.trim();
        if (t === '' || t.startsWith('#') || t === HEADER) {
            continue;
        }
        const p = line.split('\t');
        if (p.length < 7) {
            problems.push(`review_state.tsv 第 ${lineNo} 行字段数不对（${p.length} < 7），已跳过`);
            continue;
        }
        const lemma = p[0].trim();
        if (!lemma) {
            problems.push(`review_state.tsv 第 ${lineNo} 行没有 lemma，已跳过`);
            continue;
        }
        states.set(lemma, {
            lemma,
            due: p[1].trim(),
            intervalDays: num(p[2], 0),
            ease: num(p[3], 2.5),
            reps: num(p[4], 0),
            lapses: num(p[5], 0),
            lastReviewed: p[6].trim(),
        });
    }
    return { states, problems };
}

/** 全量写回（原子）。词条数在个人规模下（千级）开销可忽略 */
export function saveReviewStates(dataRoot: string, states: Map<string, ReviewState>): void {
    const file = reviewStatePath(dataRoot);
    const rows = [...states.values()]
        .sort((a, b) => a.lemma.localeCompare(b.lemma))
        .map((s) =>
            [
                s.lemma,
                s.due,
                String(s.intervalDays),
                String(s.ease),
                String(s.reps),
                String(s.lapses),
                s.lastReviewed,
            ]
                .map((v) => String(v).replace(/\t/g, '　').replace(/\r?\n/g, ' '))
                .join('\t')
        );
    atomicWrite(file, `${HEADER}\n${rows.join('\n')}${rows.length ? '\n' : ''}`);
}

/** 取状态；没有就按"新词"造一个（但不写盘 —— 只有真正复习过才落盘） */
export function stateOf(
    states: Map<string, ReviewState>,
    lemma: string,
    today: string
): ReviewState {
    return states.get(lemma) ?? newState(lemma, today);
}
