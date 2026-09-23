/**
 * 复习状态持久化的测试。
 *
 * 这份文件是用户的复习进度（唯一的副本），所以三件事都要钉住：
 *   1. 写盘原子（不留临时文件、整体替换）
 *   2. 读的时候宽容：坏行只跳过并报 problem，不能让一处手抖毁掉全部进度
 *   3. 往返一致（存进去什么，读出来就是什么）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outDir = path.resolve(import.meta.dirname, '../vscode-extension/out');
const storeFile = path.join(outDir, 'reviewStore.js');

if (!fs.existsSync(storeFile)) {
  throw new Error(`未找到编译产物 ${path.relative(process.cwd(), storeFile)}。请用 npm run test:unit。`);
}

const { loadReviewStates, saveReviewStates, reviewStatePath, stateOf } = require(storeFile);
const { newState, grade } = require(path.join(outDir, 'reviewSchedule.js'));

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-reader-review-'));
  fs.mkdirSync(path.join(root, 'vocab'), { recursive: true });
  return root;
}

test('文件不存在时返回空表，且不报问题', () => {
  const root = makeRoot();
  const { states, problems } = loadReviewStates(root);
  assert.equal(states.size, 0);
  assert.deepEqual(problems, []);
});

test('往返一致：存进去什么，读出来就是什么', () => {
  const root = makeRoot();
  const states = new Map();
  states.set('起きる', grade(newState('起きる', '2026-03-10'), 'good', '2026-03-10'));
  states.set('コーヒー', grade(newState('コーヒー', '2026-03-10'), 'again', '2026-03-10'));

  saveReviewStates(root, states);
  const loaded = loadReviewStates(root);

  assert.deepEqual(loaded.problems, []);
  assert.deepEqual([...loaded.states.keys()].sort(), ['コーヒー', '起きる']);
  for (const [lemma, state] of states) {
    assert.deepEqual(loaded.states.get(lemma), state, `${lemma} 应当逐字段一致`);
  }
});

test('读的时候宽容：坏行只跳过并报问题，好行照常加载', () => {
  const root = makeRoot();
  fs.writeFileSync(
    reviewStatePath(root),
    [
      'lemma\tdue\tinterval_days\tease\treps\tlapses\tlast_reviewed',
      '起きる\t2026-03-11\t1\t2.5\t1\t0\t2026-03-10',
      '字段不够\t2026-03-11',
      '',
      '# 注释行被忽略',
      '\t2026-03-11\t1\t2.5\t1\t0\t2026-03-10',
      '食べる\t2026-03-12\t2\t2.4\t2\t0\t2026-03-10',
    ].join('\n'),
    'utf8'
  );

  const { states, problems } = loadReviewStates(root);
  assert.deepEqual([...states.keys()].sort(), ['たべる'.replace('たべる', '食べる'), '起きる'].sort());
  assert.equal(states.size, 2, '两条好行都要加载');
  assert.equal(problems.length, 2, '两条坏行各报一个问题');
  assert.ok(problems.every((p) => p.includes('review_state.tsv 第')), problems.join(' | '));
});

test('数值字段坏掉时退回默认值而不是 NaN', () => {
  const root = makeRoot();
  fs.writeFileSync(
    reviewStatePath(root),
    'lemma\tdue\tinterval_days\tease\treps\tlapses\tlast_reviewed\n起きる\t2026-03-11\t错\t错\t错\t错\t2026-03-10\n',
    'utf8'
  );
  const s = loadReviewStates(root).states.get('起きる');
  assert.equal(s.intervalDays, 0);
  assert.equal(s.ease, 2.5);
  assert.equal(s.reps, 0);
  assert.ok(Number.isFinite(s.ease));
});

test('写盘是原子的：整体替换且不留临时文件', () => {
  const root = makeRoot();
  const file = reviewStatePath(root);
  saveReviewStates(root, new Map([['a語', newState('a語', '2026-03-10')]]));
  const inodeBefore = fs.statSync(file).ino;

  saveReviewStates(root, new Map([['a語', grade(newState('a語', '2026-03-10'), 'good', '2026-03-10')]]));
  const inodeAfter = fs.statSync(file).ino;

  assert.notEqual(inodeAfter, inodeBefore, '应当通过 rename 整体替换');
  assert.deepEqual(
    fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp')),
    []
  );
});

test('lemma 里的制表符不会破坏表结构', () => {
  const root = makeRoot();
  saveReviewStates(root, new Map([['a\tb', newState('a\tb', '2026-03-10')]]));
  const loaded = loadReviewStates(root);
  assert.equal(loaded.problems.length, 0);
  assert.equal(loaded.states.size, 1, '一条记录必须只占一行、字段数正确');
});

test('stateOf：没有状态时给一个"新词"，但不写盘', () => {
  const root = makeRoot();
  const { states } = loadReviewStates(root);
  const s = stateOf(states, '未复习', '2026-03-10');
  assert.equal(s.lastReviewed, '');
  assert.equal(s.due, '2026-03-10');
  assert.equal(fs.existsSync(reviewStatePath(root)), false, '没有真正复习过就不该产生文件');
});
