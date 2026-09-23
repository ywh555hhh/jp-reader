/**
 * 本地词典的解析与查词测试。
 *
 * 词典是**外部数据**：格式由用户提供，坏行/坏格式是常态而不是异常。
 * 所以这里重点钉三件事：
 *   1. 三种格式都能解析（TSV / Yomichan term_bank / JMdict-simplified）
 *   2. 坏行只报问题并跳过 —— 一行写错不能让整本词典查不到
 *   3. 安全边界：超大文件要拒绝（扩展宿主不能被指错的文件撑爆）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outFile = path.resolve(import.meta.dirname, '../vscode-extension/out/dictionary.js');

if (!fs.existsSync(outFile)) {
  throw new Error(`未找到编译产物 ${path.relative(process.cwd(), outFile)}。请用 npm run test:unit。`);
}

const {
  MAX_DICTIONARY_BYTES,
  cleanGloss,
  dictionaryFiles,
  emptyIndex,
  loadDictionary,
  loadDictionaryFile,
  lookup,
  parseJmdict,
  parseTsvDictionary,
  parseYomichanBank,
} = require(outFile);

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jp-reader-dict-'));
}

test('TSV：多行=多义项，释义里用 ；分隔，注释与空行跳过', () => {
  const { entries, problems } = parseTsvDictionary(
    [
      '# 注释',
      '',
      '起きる\tおきる\t動詞\t起床，起来；发生',
      '起きる\tおきる\t動詞\t（事情）发生',
      '天気\tてんき\t名詞\t天气',
      '字段不够',
      '\t\t\t没有词条',
    ].join('\n'),
    'sample.tsv'
  );

  assert.deepEqual(problems, [
    'sample.tsv 第 6 行字段数不足 4（term/reading/pos/meaning），已跳过',
    'sample.tsv 第 7 行没有词条，已跳过',
  ]);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0].glosses, ['起床，起来', '发生']);
  assert.equal(entries[0].reading, 'おきる');
  assert.equal(entries[0].source, 'sample.tsv');
});

test('Yomichan term bank：能解析嵌套的 glossary 结构，并去掉 HTML', () => {
  const bank = [
    ['起きる', 'おきる', 'v1', '', 0, ['<b>起床</b>', { type: 'text', text: '发生' }, { type: 'structured-content', content: ['起床する'] }], 1, []],
    ['短い', 'みじかい', 'adj', '', 0, '很短'],
    '这不是数组',
  ];
  const { entries, problems } = parseYomichanBank(bank, 'term_bank_1.json');

  assert.deepEqual(problems, []);
  assert.equal(entries.length, 2, '非数组的行直接跳过，不算问题');
  assert.deepEqual(entries[0].glosses.slice(0, 3), ['起床', '发生', '起床する']);
  assert.equal(entries[1].glosses[0], '很短');
});

test('Yomichan：文件本身不是数组时报问题', () => {
  const { entries, problems } = parseYomichanBank({ nope: true }, 'term_bank_1.json');
  assert.equal(entries.length, 0);
  assert.match(problems[0], /不是 Yomichan term bank/);
});

test('JMdict-simplified：按 kanji 建词条，kana 作读音，gloss 汇总', () => {
  const jmdict = {
    words: [
      {
        kanji: [{ text: '起きる' }],
        kana: [{ text: 'おきる' }],
        sense: [{ partOfSpeech: ['v1'], gloss: [{ text: 'to get up' }, { text: 'to occur' }] }],
      },
      { kanji: [], kana: [{ text: 'かなだけ' }], sense: [] },
    ],
  };
  const { entries, problems } = parseJmdict(jmdict, 'jmdict.json');

  assert.deepEqual(problems, []);
  assert.equal(entries.length, 1, '没有 kanji 的条目跳过（本工具按汉字/写法查词）');
  assert.equal(entries[0].term, '起きる');
  assert.equal(entries[0].reading, 'おきる');
  assert.equal(entries[0].pos, 'v1');
  assert.deepEqual(entries[0].glosses, ['to get up', 'to occur']);
});

test('格式按扩展名 + 内容嗅探：TSV / gz / 不认识的 JSON 都要给出人话', () => {
  const dir = tmpDir();

  const tsv = path.join(dir, 'mini.tsv');
  fs.writeFileSync(tsv, '猫\tねこ\t名詞\t猫\n', 'utf8');
  assert.equal(loadDictionaryFile(tsv).entries.length, 1);

  // .gz 也要能读
  const gz = path.join(dir, 'mini.tsv.gz');
  fs.writeFileSync(gz, zlib.gzipSync(Buffer.from('犬\tいぬ\t名詞\t狗\n', 'utf8')));
  assert.equal(loadDictionaryFile(gz).entries[0].term, '犬');

  const weird = path.join(dir, 'weird.json');
  fs.writeFileSync(weird, '{"nope":1}', 'utf8');
  assert.match(loadDictionaryFile(weird).problems[0], /格式不认识/);

  const broken = path.join(dir, 'broken.json');
  fs.writeFileSync(broken, '{不是 JSON', 'utf8');
  assert.match(loadDictionaryFile(broken).problems[0], /不是合法 JSON/);
});

test('查词：按写法查；重复的义项都返回；查不到就是空（不模糊匹配）', () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, 'a.tsv'),
    ['起きる\tおきる\t動詞\t起床', '起きる\tおきる\t動詞\t发生'].join('\n'),
    'utf8'
  );
  const index = loadDictionary(dictionaryFiles(dir));

  const hits = lookup(index, '起きる');
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.glosses[0]), ['起床', '发生']);
  assert.deepEqual(lookup(index, '存在しない'), []);
});

test('查词：保守的活用候选（買っ → 買る，サーバ → サーバー）', () => {
  const index = emptyIndex();
  index.entries.set('買る', [{ term: '買る', reading: '', pos: '', glosses: ['买'], source: 'x' }]);
  assert.equal(lookup(index, '買っ').length, 1);

  const index2 = emptyIndex();
  index2.entries.set('サーバー', [{ term: 'サーバー', reading: '', pos: '', glosses: ['服务器'], source: 'x' }]);
  assert.equal(lookup(index2, 'サーバ').length, 1);
});

test('目录解析：只收词典文件，顺序稳定；路径不存在时返回空', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'b.tsv'), 'x\n');
  fs.writeFileSync(path.join(dir, 'a.tsv'), 'y\n');
  fs.writeFileSync(path.join(dir, 'readme.md'), 'ignored\n');
  const files = dictionaryFiles(dir).map((f) => path.basename(f));
  assert.deepEqual(files, ['a.tsv', 'b.tsv'], '排序稳定，且忽略非词典扩展名');

  assert.deepEqual(dictionaryFiles(path.join(dir, '不存在')), []);
  assert.deepEqual(dictionaryFiles(''), []);
});

test('安全边界：超过大小上限的文件被拒绝，并给出可执行的建议', () => {
  const dir = tmpDir();
  const huge = path.join(dir, 'huge.json');
  fs.writeFileSync(huge, '');
  fs.truncateSync(huge, MAX_DICTIONARY_BYTES + 1); // 稀疏文件，不真占盘

  const { entries, problems } = loadDictionaryFile(huge);
  assert.equal(entries.length, 0);
  assert.match(problems[0], /超过 64MB 上限/);
  assert.match(problems[0], /TSV|\.json\.gz/, '提示要给出替代做法，而不是只说失败');
});

test('cleanGloss：去标签、压空白、截断', () => {
  assert.equal(cleanGloss('  <b>起きる</b>\n  、 起来 '), '起きる 、 起来');
  assert.equal(cleanGloss('<ruby>漢<rt>かん</rt></ruby>字').length > 0, true);
  assert.equal(cleanGloss('x'.repeat(500)).length, 300);
});
