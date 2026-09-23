/**
 * 数据层的运行期测试（否命题 A1 的回归测试）。
 *
 * dataLoader 现在是不依赖 vscode 的纯模块：只读磁盘、出错返回 problems。
 * 这一层验证两件事：
 *   1. 它真的能在纯 Node 里跑起来（一旦有人再往里面塞 require('vscode')，这个文件会立刻炸）
 *   2. 出错时是"返回问题"而不是"抛异常 / 弹窗"——宿主才能决定怎么提示
 *
 * 运行：npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outFile = path.resolve(import.meta.dirname, '../vscode-extension/out/dataLoader.js');

if (!fs.existsSync(outFile)) {
  throw new Error(`未找到编译产物 ${path.relative(process.cwd(), outFile)}。请用 npm run test:unit。`);
}

const { loadData, resolveDataRoot, parseTwoColumnTsv, readLemmaSet, isJapaneseChar, resolveLemma } =
  require(outFile);

function makeRoot({ rules = null, wtype = null, mapping = null, wordlist = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-reader-data-'));
  fs.mkdirSync(path.join(root, 'vocab'), { recursive: true });
  if (rules !== null) {
    fs.writeFileSync(path.join(root, 'rules_config.json'), rules, 'utf8');
  }
  if (wtype !== null) {
    fs.writeFileSync(path.join(root, 'vocab', 'lemma_wtype.tsv'), wtype, 'utf8');
  }
  if (mapping !== null) {
    fs.writeFileSync(path.join(root, 'vocab', 'lemma_mapping.tsv'), mapping, 'utf8');
  }
  if (wordlist !== null) {
    fs.writeFileSync(path.join(root, 'vocab', 'wago_p99_wordlist_only.txt'), wordlist, 'utf8');
  }
  return root;
}

test('能在纯 Node 里加载数据（dataLoader 不认识 vscode）', () => {
  const root = makeRoot({
    rules: JSON.stringify({
      rules: [
        { id: 'wago', name: 'wago', enable: true, match: { lemma_in_file: './vocab/wago_p99_wordlist_only.txt' }, style: { color: '#4ade80' }, priority: 10 },
      ],
    }),
    wtype: '起きる\t和\nコーヒー\t外\n',
    mapping: '# 注释\nする\t為る\n',
    wordlist: '起きる\n食べる\n',
  });

  const result = loadData(root);

  assert.deepEqual(result.problems, [], '不该有问题');
  assert.equal(result.data.rules.length, 1);
  assert.equal(result.data.lemmaWtype.get('起きる'), '和');
  assert.equal(result.data.lemmaMapping.get('する'), '為る');
  assert.ok(result.data.rules[0].lemmaSet.has('起きる'), 'lemma_in_file 应该被解析成集合');
  assert.ok(result.data.rules[0].lemmaSet.has('食べる'));
  assert.match(result.summary, /已加载 1 条规则/);
});

test('缺文件时返回 problems，而不是抛异常（宿主决定怎么提示）', () => {
  const root = makeRoot(); // 空目录，什么都不放

  const result = loadData(root);

  assert.ok(result.problems.length > 0, '应该报告问题');
  assert.ok(
    result.problems.some((p) => p.includes('rules_config.json')),
    `应指出缺 rules_config.json，实际：${JSON.stringify(result.problems)}`
  );
  // 仍然返回可用的空结构，调用方不需要 try/catch
  assert.deepEqual(result.data.rules, []);
  assert.equal(result.data.lemmaWtype.size, 0);
});

test('rules_config.json 语法错误时只报告，不影响其它数据', () => {
  const root = makeRoot({ rules: '{ 这不是 JSON', wtype: '起きる\t和\n' });

  const result = loadData(root);

  assert.ok(result.problems.some((p) => p.includes('解析失败')), '应报告解析失败');
  assert.equal(result.data.rules.length, 0);
  assert.equal(result.data.lemmaWtype.get('起きる'), '和', '词表仍然应该被加载');
});

test('resolveDataRoot 的配置值由宿主传入（自己不读 vscode 配置）', () => {
  const configured = makeRoot({ rules: '{"rules":[]}' });
  const other = makeRoot({ rules: '{"rules":[]}' });

  // 配置优先
  assert.equal(resolveDataRoot(other, configured), configured);
  // 没配置时退回工作区探测
  assert.equal(resolveDataRoot(configured, ''), configured);
  // 配置指向一个不含 rules_config.json 的目录 → 不生效，继续探测工作区
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-reader-empty-'));
  assert.equal(resolveDataRoot(configured, empty), configured);
});

test('两列 TSV 解析：跳过空行与注释，容忍缺列', () => {
  const map = parseTwoColumnTsv('# 注释\n\nする\t為る\n只有一列\nある\t有る\n');
  assert.deepEqual([...map.entries()], [
    ['する', '為る'],
    ['ある', '有る'],
  ]);
});

test('readLemmaSet 跳过注释与空行，并只取第一列', () => {
  const root = makeRoot({ wordlist: '# 注释\n起きる\n\n食べる\textra\n' });
  const set = readLemmaSet(path.join(root, 'vocab', 'wago_p99_wordlist_only.txt'));
  assert.equal(set.size, 2, `只应有 2 个 lemma，实际：${JSON.stringify([...set])}`);
  assert.ok(set.has('起きる'));
  assert.ok(set.has('食べる'), '带制表符的行应只取第一列');
  assert.ok(!set.has('	extra'));
});

test('lemma 映射与語種查表的基本行为', () => {
  assert.equal(resolveLemma('する', new Map([['する', '為る']])), '為る');
  assert.equal(resolveLemma('未知', new Map()), '未知');
  assert.equal(isJapaneseChar('あ'), true);
  assert.equal(isJapaneseChar('漢'), true);
  assert.equal(isJapaneseChar('a'), false);
});
