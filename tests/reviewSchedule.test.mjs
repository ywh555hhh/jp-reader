/**
 * 复习调度的测试。
 *
 * 间隔重复是"学得进去还是白学"的核心，而它的数学一旦错了**不会报错** ——
 * 只会让词在错误的时间出现（或者永远不出现）。所以这里把序列钉死。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outFile = path.resolve(import.meta.dirname, '../vscode-extension/out/reviewSchedule.js');

if (!fs.existsSync(outFile)) {
  throw new Error(`未找到编译产物 ${path.relative(process.cwd(), outFile)}。请用 npm run test:unit。`);
}

const {
  addDays,
  buildQueue,
  computeStats,
  daysBetween,
  dueText,
  grade,
  isDue,
  newState,
  todayKey,
  toDateKey,
  MIN_EASE,
  MAX_EASE,
} = require(outFile);

const TODAY = '2026-03-10';

test('日期工具：本地日期、加减天数、差值（跨月跨年）', () => {
  assert.equal(toDateKey(new Date(2026, 0, 5)), '2026-01-05');
  assert.equal(todayKey(new Date(2026, 11, 31)), '2026-12-31');
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-10', 0), '2026-03-10');
  assert.equal(daysBetween('2026-03-10', '2026-03-13'), 3);
  assert.equal(daysBetween('2026-03-13', '2026-03-10'), -3);
});

test('新词：立即到期、从未复习', () => {
  const s = newState('起きる', TODAY);
  assert.equal(s.due, TODAY);
  assert.equal(s.lastReviewed, '');
  assert.equal(s.reps, 0);
  assert.equal(s.lapses, 0);
  assert.equal(isDue(s, TODAY), true);
});

test('「记住了」的间隔序列：1 → 3 → 8 → 20 天（ease 2.5）', () => {
  let s = newState('起きる', TODAY);
  const seen = [];
  for (let i = 0; i < 4; i += 1) {
    s = grade(s, 'good', TODAY);
    seen.push(s.intervalDays);
  }
  assert.deepEqual(seen, [1, 3, 8, 20]);
  assert.equal(s.reps, 4);
  assert.equal(s.ease, 2.5, '「记住了」不应该改变难度');
  assert.equal(s.due, addDays(TODAY, 20));
});

test('「忘了」：回到当天、连续次数清零、难度上升、遗忘次数 +1', () => {
  let s = grade(grade(newState('起きる', TODAY), 'good', TODAY), 'good', TODAY);
  assert.equal(s.reps, 2);

  const lapsed = grade(s, 'again', TODAY);
  assert.equal(lapsed.intervalDays, 0);
  assert.equal(lapsed.due, TODAY, '忘了当天还要再见一次');
  assert.equal(lapsed.reps, 0);
  assert.equal(lapsed.lapses, 1);
  assert.ok(lapsed.ease < s.ease, '难度因子应当上升（数值下降）');
});

test('「模糊」只小幅增长，「简单」增长更多且降低难度', () => {
  const base = grade(grade(newState('x', TODAY), 'good', TODAY), 'good', TODAY);
  assert.equal(base.intervalDays, 3);

  const hard = grade(base, 'hard', TODAY);
  assert.equal(hard.intervalDays, 4, '3 × 1.2 ≈ 4');
  assert.ok(hard.ease < base.ease);

  const easy = grade(base, 'easy', TODAY);
  assert.equal(easy.intervalDays, 10, '3 × 2.5 × 1.3 ≈ 10');
  assert.ok(easy.ease > base.ease);
});

test('难度因子有上下界，且不会因为连续按「简单」无限膨胀', () => {
  let s = newState('x', TODAY);
  for (let i = 0; i < 20; i += 1) {
    s = grade(s, 'easy', TODAY);
  }
  assert.equal(s.ease, MAX_EASE);

  let hard = newState('y', TODAY);
  for (let i = 0; i < 40; i += 1) {
    hard = grade(hard, 'again', TODAY);
  }
  assert.equal(hard.ease, MIN_EASE);
});

test('grade 不修改传入的状态（纯函数）', () => {
  const before = grade(newState('x', TODAY), 'good', TODAY);
  const snapshot = JSON.stringify(before);
  grade(before, 'again', TODAY);
  assert.equal(JSON.stringify(before), snapshot);
});

test('队列：到期的优先、新词受日限额约束、顺序可复现', () => {
  const states = new Map();
  // 两个到期（不同日期）、一个未来的、两个新词
  states.set('b語', { ...newState('b語', TODAY), lastReviewed: '2026-03-01', due: '2026-03-05', intervalDays: 4 });
  states.set('a語', { ...newState('a語', TODAY), lastReviewed: '2026-03-09', due: '2026-03-09', intervalDays: 1 });
  states.set('c語', { ...newState('c語', TODAY), lastReviewed: TODAY, due: '2026-03-20', intervalDays: 10 });

  const lemmas = ['c語', '新2語', 'a語', 'b語', '新1語'];
  const q = buildQueue(lemmas, states, TODAY, { newLimit: 1 });

  assert.deepEqual(q.due, ['b語', 'a語'], '到期早的排前面（b 是 03-05，a 是 03-09）');
  assert.deepEqual(q.fresh, ['新1語'], '新词受日限额约束，且排序稳定');
  assert.ok(!q.due.includes('c語'), '还没到期的词不该出现');

  // 同一个输入重复调用结果一致（队列可复现，便于排查）
  assert.deepEqual(buildQueue(lemmas, states, TODAY, { newLimit: 1 }), q);
});

test('统计：到期 / 新词 / 今日已复习 / 总数', () => {
  const states = new Map();
  states.set('a語', { ...newState('a語', TODAY), lastReviewed: TODAY, due: '2026-03-11', intervalDays: 1 });
  states.set('b語', { ...newState('b語', TODAY), lastReviewed: '2026-03-01', due: '2026-03-05', intervalDays: 4 });

  const stats = computeStats(['a語', 'b語', 'c語'], states, TODAY);
  assert.deepEqual(stats, { due: 1, fresh: 1, reviewedToday: 1, total: 3 });
});

test('dueText 的文案对得上日期差', () => {
  assert.equal(dueText(undefined, TODAY), '新词');
  assert.equal(dueText({ ...newState('x', TODAY) }, TODAY), '新词');
  assert.equal(dueText({ ...newState('x', TODAY), lastReviewed: TODAY, due: TODAY, intervalDays: 0 }, TODAY), '今天到期');
  assert.equal(dueText({ ...newState('x', TODAY), lastReviewed: TODAY, due: '2026-03-11', intervalDays: 1 }, TODAY), '明天复习');
  assert.equal(dueText({ ...newState('x', TODAY), lastReviewed: TODAY, due: '2026-03-13', intervalDays: 3 }, TODAY), '3 天后复习');
  assert.equal(dueText({ ...newState('x', TODAY), lastReviewed: '2026-03-01', due: '2026-03-08', intervalDays: 7 }, TODAY), '已到期 2 天');
});
