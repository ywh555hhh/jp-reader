/**
 * 覆盖率分析的测试。
 *
 * 这个模块的结论会直接影响"这篇课文现在读不读"的判断，
 * 所以数字必须可复现、可解释；排序不稳（同样的输入给出不同的生词顺序）会让用户以为结果随机。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outFile = path.resolve(import.meta.dirname, '../vscode-extension/out/coverage.js');

if (!fs.existsSync(outFile)) {
  throw new Error(`未找到编译产物 ${path.relative(process.cwd(), outFile)}。请用 npm run test:unit。`);
}

const { analyzeCoverage, countLemmas, summarize, MASTERED_INTERVAL_DAYS } = require(outFile);

const tokens = [
  { lemma: '私', count: 3 },
  { lemma: '毎朝', count: 2 },
  { lemma: '起きる', count: 2 },
  { lemma: 'コーヒー', count: 1 },
  { lemma: '飲む', count: 1 },
];

test('覆盖率 = 见过的词出现次数 / 总词数', () => {
  const r = analyzeCoverage(tokens, ['私', '毎朝', '起きる']);
  assert.equal(r.total, 9);
  assert.equal(r.unique, 5);
  assert.equal(r.knownTokens, 7, '私×3 + 毎朝×2 + 起きる×2');
  assert.equal(r.knownUnique, 3);
  assert.equal(r.unknownTokens, 2);
  assert.equal(r.unknownUnique, 2);
  assert.equal(Math.round(r.coverage * 1000) / 1000, 0.778);
});

test('生词按出现次数降序，同次数按 lemma 排序（结果可复现）', () => {
  const r = analyzeCoverage(
    [
      { lemma: 'b語', count: 1 },
      { lemma: 'a語', count: 1 },
      { lemma: 'c語', count: 5 },
    ],
    []
  );
  assert.deepEqual(
    r.unknown.map((u) => u.lemma),
    ['c語', 'a語', 'b語'],
    '码点序：同次数时 a語(U+0061) < b語(U+0062)'
  );
  // 重复调用结果一致
  const again = analyzeCoverage(
    [
      { lemma: 'c語', count: 5 },
      { lemma: 'a語', count: 1 },
      { lemma: 'b語', count: 1 },
    ],
    []
  );
  assert.deepEqual(again.unknown.map((u) => u.lemma), r.unknown.map((u) => u.lemma));
});

test('重点词表只影响标记，不影响覆盖率', () => {
  const r = analyzeCoverage(tokens, ['私'], [], ['コーヒー', '飲む']);
  assert.deepEqual(
    r.unknown.map((u) => [u.lemma, u.priority]),
    [
      ['毎朝', false],
      ['起きる', false],
      ['コーヒー', true],
      ['飲む', true],
    ]
  );
  assert.equal(r.coverage, 3 / 9, '重点词表不该改变分母');
});

test('已掌握的词单独统计（用于展示"记住了多少"）', () => {
  const r = analyzeCoverage(tokens, ['私', '毎朝', '起きる'], ['私', '毎朝']);
  assert.equal(r.masteredTokens, 5);
  assert.equal(r.knownTokens, 7);
});

test('空课文 / 全是未识别内容时的边界', () => {
  const empty = analyzeCoverage([], ['私']);
  assert.equal(empty.total, 0);
  assert.equal(empty.coverage, 1, '没有词时覆盖率按 100% 处理，避免除零');
  assert.deepEqual(empty.unknown, []);
  assert.match(summarize(empty), /没识别到日语词/);
});

test('忽略空 lemma 与非正数计数（分词噪声不该进统计）', () => {
  const r = analyzeCoverage(
    [
      { lemma: '', count: 5 },
      { lemma: '語', count: 0 },
      { lemma: '語', count: -1 },
      { lemma: '語', count: 2 },
    ],
    []
  );
  assert.equal(r.total, 2);
  assert.equal(r.unique, 1);
});

test('countLemmas 把词折成出现次数', () => {
  assert.deepEqual(countLemmas(['あ', 'い', 'あ', '', 'あ']), [
    { lemma: 'あ', count: 3 },
    { lemma: 'い', count: 1 },
  ]);
});

test('summarize 的文案包含词数、覆盖率与重点生词数', () => {
  const r = analyzeCoverage(tokens, ['私', '毎朝', '起きる'], [], ['コーヒー']);
  const text = summarize(r);
  assert.match(text, /本课 9 词/);
  assert.match(text, /见过 78%/);
  assert.match(text, /生词 2 个/);
  assert.match(text, /其中 1 个是重点词表里的/);
});

test('掌握判定阈值与复习调度一致（1 → 3 → 8 → 20 天）', () => {
  assert.equal(MASTERED_INTERVAL_DAYS, 21, '改成别的值时要同步 docs/architecture.md 与 README');
});
