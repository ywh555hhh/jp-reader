/**
 * 运行期不变量测试。
 *
 * 为什么需要这一层：静态规则（ast-grep / depcruise / 类型检查）看不见"数据被写坏了"这类问题。
 * 比如"词条主键是否唯一"——它跑起来才知道。而它一旦坏掉不会报错，只会安静地删错行。
 *
 * 这一层直接读写磁盘上的 TSV：测的是**用户看得见的那个产物**，不是内部 API。
 *
 * 运行：npm run test:unit（会先编译 vscode-extension）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outFile = path.resolve(import.meta.dirname, '../vscode-extension/out/collection.js');

if (!fs.existsSync(outFile)) {
  throw new Error(
    `未找到编译产物 ${path.relative(process.cwd(), outFile)}。\n` +
      '请用 npm run test:unit（它会先跑 npm --prefix vscode-extension run compile）。'
  );
}

const col = require(outFile);

const HEADER =
  'id\ttimestamp\tlemma\tsurface_form\twtype\tpos\tsentence\tsource\tstatus\tnote';
const LEGACY_HEADER =
  'timestamp\tlemma\tsurface_form\twtype\tpos\tsentence\tsource\tstatus\tnote';

const COLLECTION = ['vocab', 'my_collection.tsv'];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-reader-runtime-'));
  fs.mkdirSync(path.join(root, 'vocab'), { recursive: true });
  return root;
}

function collectionFile(root) {
  return path.join(root, ...COLLECTION);
}

function readFile(root) {
  const raw = fs.readFileSync(collectionFile(root), 'utf8');
  const lines = raw.split('\n').filter((l) => l !== '');
  return {
    header: lines[0],
    rows: lines.slice(1).map((l) => l.split('\t')),
    raw,
  };
}

function add(root, i) {
  return col.addEntry(root, {
    lemma: `語${i}`,
    surfaceForm: `語${i}`,
    wtype: '和',
    pos: '名詞_普通名詞',
    sentence: `これは語${i}です。`,
    source: 'texts/lesson01.md',
    status: 'new',
    note: '',
  });
}

test('同一毫秒内的多次写入必须得到不同的 id（#1 的回归测试）', (t) => {
  const root = makeRoot();
  const N = 200;
  for (let i = 0; i < N; i += 1) {
    assert.equal(add(root, i), true, `第 ${i} 条写入失败`);
  }

  const { rows } = readFile(root);
  assert.equal(rows.length, N, `行数应为 ${N}`);

  const ids = rows.map((r) => r[0]);
  const timestamps = rows.map((r) => r[1]);

  // 测试有效性的证据：这台机器上确实发生了毫秒级时间戳重复。
  // 旧实现（id 就是 timestamp）在这种情况下必然产生重复主键。
  t.diagnostic(
    `时间戳去重后 ${new Set(timestamps).size}/${N} 个不同值` +
      `（${N - new Set(timestamps).size} 次同毫秒），id 去重后 ${new Set(ids).size}/${N}`
  );

  assert.equal(
    new Set(ids).size,
    N,
    '存在重复 id：主键必须唯一，否则按 id 更新/删除会一次命中多行'
  );
  assert.ok(
    ids.every((id) => id.length > 0),
    'id 不允许为空'
  );
});

test('按 id 更新状态只影响一条记录', () => {
  const root = makeRoot();
  for (let i = 0; i < 3; i += 1) {
    add(root, i);
  }
  const before = readFile(root).rows;
  const targetId = before[1][0];

  assert.equal(col.updateEntryStatus(root, targetId, 'mastered'), true);

  const after = readFile(root).rows;
  assert.equal(after.length, 3);
  const mastered = after.filter((r) => r[8] === 'mastered');
  assert.equal(mastered.length, 1, '必须只有一行被更新');
  assert.equal(mastered[0][0], targetId);
  assert.deepEqual(
    after.filter((r) => r[0] !== targetId).map((r) => r[8]),
    ['new', 'new'],
    '其它行必须原样保留'
  );
});

test('按 id 删除只影响一条记录', () => {
  const root = makeRoot();
  for (let i = 0; i < 3; i += 1) {
    add(root, i);
  }
  const targetId = readFile(root).rows[1][0];

  const remaining = col.deleteEntry(root, targetId);

  const after = readFile(root).rows;
  assert.equal(remaining, 2);
  assert.equal(after.length, 2);
  assert.ok(
    after.every((r) => r[0] !== targetId),
    '被删除的 id 不应再出现'
  );
  assert.deepEqual(
    after.map((r) => r[2]),
    ['語0', '語2'],
    '只应删掉目标那一条'
  );
});

test('旧 9 列格式可读且被透明迁移（不丢数据，并修复历史重复主键）', () => {
  const root = makeRoot();
  const legacy = [
    LEGACY_HEADER,
    '2026-01-01T00:00:00.000Z\t起きる\t起き\t和\t動詞_自立\t毎朝、七時に起きます。\ta.md\tnew\t',
    '2026-01-01T00:00:00.000Z\t食べる\t食べ\t和\t動詞_自立\t昼ご飯を食べます。\tb.md\tseen\t常考',
    '',
  ].join('\n');
  fs.writeFileSync(collectionFile(root), legacy, 'utf8');

  // 一次写入就会触发迁移
  assert.equal(add(root, 9), true);

  const { header, rows } = readFile(root);
  assert.equal(header, HEADER, '迁移后应使用新表头');

  const migrated = rows.filter((r) => r[2] === '起きる' || r[2] === '食べる');
  assert.equal(migrated.length, 2, '旧数据行数不能少');
  assert.equal(migrated[0][1], '2026-01-01T00:00:00.000Z', 'timestamp 字段原样保留');
  assert.equal(migrated[0][6], '毎朝、七時に起きます。', '原句不能丢');
  assert.equal(migrated[1][8], 'seen', 'status 不能丢');
  assert.equal(migrated[1][9], '常考', '笔记不能丢');

  // 关键：旧文件里两行 timestamp 完全相同，迁移后必须拿到不同的 id，
  // 否则"按 id 更新"仍然会一次命中两行（历史脏数据没有真正被治好）。
  assert.notEqual(migrated[0][0], migrated[1][0], '迁移后每行都要有唯一 id');
  const allIds = rows.map((r) => r[0]);
  assert.equal(new Set(allIds).size, allIds.length, '迁移后整个文件的主键必须唯一');

  // 迁移后的行仍然可以被精确定位
  assert.equal(col.updateEntryStatus(root, migrated[0][0], 'mastered'), true);
  const after = readFile(root).rows;
  assert.equal(after.filter((r) => r[8] === 'mastered').length, 1, '应只命中一行');
});

test('含换行与制表符的内容不会破坏 TSV 结构', () => {
  const root = makeRoot();
  assert.equal(
    col.addEntry(root, {
      lemma: '改行',
      surfaceForm: '改行',
      wtype: '和',
      pos: '名詞_普通名詞',
      sentence: '一行目\n二行目\tタブ',
      source: 'a.md',
      status: 'new',
      note: 'メモ\n改行',
    }),
    true
  );

  const { header, rows, raw } = readFile(root);
  assert.equal(header, HEADER);
  assert.equal(rows.length, 1, '一条记录必须只占一行');
  assert.equal(rows[0].length, 10, '字段数必须恒为 10');
  assert.ok(!raw.endsWith('\n\n'), '不应写出多余空行');
});
