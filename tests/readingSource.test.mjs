/**
 * 源文定位的运行期测试（#5 的回归测试）。
 *
 * 这一层测的是"按真实 offset 取句子"是否正确——静态规则看不见它，
 * 而它的失效方式是"安静地指向另一句"，只有断言能发现。
 *
 * 运行：npm run test:unit（会先编译 vscode-extension）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outFile = path.resolve(import.meta.dirname, '../vscode-extension/out/readingSource.js');

if (!fs.existsSync(outFile)) {
  throw new Error(
    `未找到编译产物 ${path.relative(process.cwd(), outFile)}。请用 npm run test:unit。`
  );
}

const { buildSourceIndex, createMatcher, sentenceAt } = require(outFile);

/** 极简假 tokenizer：只按给定分段返回 token（位置由我们自己算），用来隔离测试匹配逻辑 */
function fakeTokenizer(parts) {
  let pos = 0;
  const tokens = parts.map((surface) => {
    const word_position = pos;
    pos += surface.length;
    return { surface_form: surface, word_position };
  });
  return { tokenize: () => tokens };
}

test('索引记录的是源文里的绝对偏移', () => {
  const text = '毎朝、七時に起きます。';
  const index = buildSourceIndex(text, fakeTokenizer(['毎朝', '、', '七時', 'に', '起き', 'ます', '。']));
  assert.deepEqual(
    index.map((t) => t.surface),
    ['毎朝', '、', '七時', 'に', '起き', 'ます', '。']
  );
  // '七時' 在源文里的位置
  assert.equal(index.find((t) => t.surface === '七時').offset, text.indexOf('七時'));
  // 偏移必须能切回原文
  for (const t of index) {
    assert.equal(text.slice(t.offset, t.offset + t.surface.length), t.surface, `偏移与原文不符：${t.surface}`);
  }
});

test('同一个词出现多次时，匹配器给出的是各自的位置（这正是 indexOf 会搞错的地方）', () => {
  const text = '会社で働きます。そして、家でも会社のことを考えます。';
  const index = buildSourceIndex(text, fakeTokenizer(['会社', 'で', '働き', 'ます', '。', 'そして', '、', '家', 'で', 'も', '会社', 'の', 'こと', 'を', '考え', 'ます', '。']));
  const match = createMatcher(index);

  const first = match('会社');
  const second = match('会社');

  assert.notEqual(first, second, '两次出现必须拿到不同的 offset');
  assert.equal(text.slice(first, first + 2), '会社');
  assert.equal(text.slice(second, second + 2), '会社');
  assert.equal(first, text.indexOf('会社'));
  assert.equal(second, text.lastIndexOf('会社'));
});

test('匹配器只向前走：回退到前面的同名词不会被误配', () => {
  const text = '会社で働きます。そして、家でも会社のことを考えます。';
  const index = buildSourceIndex(text, fakeTokenizer(['会社', 'で', '働き', 'ます', '。', 'そして', '、', '家', 'で', 'も', '会社', 'の', 'こと', 'を', '考え', 'ます', '。']));
  const match = createMatcher(index);

  assert.equal(match('会社'), text.indexOf('会社'));
  assert.equal(match('考え'), text.indexOf('考え'));
  // '会社' 已经用尽（后面没有了），不允许退回第一个
  assert.equal(match('会社'), null);
});

test('匹配不上时返回 null，而不是猜一个位置', () => {
  const index = buildSourceIndex('会社です。', fakeTokenizer(['会社', 'です', '。']));
  const match = createMatcher(index);
  assert.equal(match('存在しない語'), null);
});

test('sentenceAt 取到的是包含该 offset 的那一句', () => {
  const text = '毎朝、七時に起きます。そして、コーヒーを飲みます。';

  const secondSentence = text.indexOf('コーヒー');
  assert.equal(sentenceAt(text, secondSentence), 'そして、コーヒーを飲みます。');

  const firstSentence = text.indexOf('七時');
  assert.equal(sentenceAt(text, firstSentence), '毎朝、七時に起きます。');

  // 第二个句子里的斜体/强调不会影响结果：offset 指向哪句就取哪句
  assert.equal(sentenceAt(text, text.indexOf('飲み')), 'そして、コーヒーを飲みます。');
});

test('sentenceAt 对非法 offset 返回空串（由调用方给出提示，绝不猜位置）', () => {
  const text = '会社です。';
  assert.equal(sentenceAt(text, -1), '');
  assert.equal(sentenceAt(text, text.length + 1), '');
  assert.equal(sentenceAt(text, Number.NaN), '');
  assert.equal(sentenceAt(text, undefined), '');
});

test('Markdown 标记不会让定位跑偏（真实课文的形态）', () => {
  const text = [
    '# 第 1 課',
    '',
    '**田中**：はじめまして、田中です。',
    '',
    '**佐藤**：こちらこそ、佐藤です。田中さんも学生ですか。',
  ].join('\n');

  // 同一个词出现在两处：必须各自取到自己那一句。
  // 注意第二处的锚点落在“……佐藤です。”之后，所以它所在的句子就是后半句。
  assert.equal(sentenceAt(text, text.indexOf('田中')), '**田中**：はじめまして、田中です。');
  assert.equal(sentenceAt(text, text.lastIndexOf('田中')), '田中さんも学生ですか。');
  // 第二句用句号分开了两小句，锚点落在哪小句就取哪小句
  assert.equal(sentenceAt(text, text.indexOf('佐藤')), '**佐藤**：こちらこそ、佐藤です。');
});
