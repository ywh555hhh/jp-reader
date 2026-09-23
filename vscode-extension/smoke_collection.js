// 验证 collection 模块：写入 my_collection.tsv 与刷新 lemma 文件
const os = require('os');
const fs = require('fs');
const path = require('path');
const col = require('./out/collection.js');
const { addEntry, refreshLemmasFile, groupByLemma } = col;

// loadEntries 已不再对外暴露；按 lemma 分组后展平即得全部条目（保持文件顺序）
const allEntries = (root) => Array.from(groupByLemma(root).values()).flat();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-reader-test-'));
fs.mkdirSync(path.join(tmp, 'vocab'), { recursive: true });

// 模拟第一次收集
const ok1 = addEntry(tmp, {
    lemma: '起きる', surfaceForm: '起き', wtype: '和', pos: '動詞_自立',
    sentence: '毎朝、七時に起きます。', source: 'C:/texts/lesson01.md', status: 'new', note: ''
});
const ok2 = addEntry(tmp, {
    lemma: 'コーヒー', surfaceForm: 'コーヒー', wtype: '外', pos: '名詞_普通名詞',
    sentence: 'コーヒーを飲んでいます。', source: 'C:/texts/lesson01.md', status: 'new', note: ''
});
const ok3 = addEntry(tmp, {
    lemma: '起きる', surfaceForm: '起きて', wtype: '和', pos: '動詞_自立',
    sentence: '早く起きてください。', source: 'C:/texts/lesson02.md', status: 'new', note: ''
});

console.log('写入成功:', ok1, ok2, ok3);
console.log('=== my_collection.tsv ===');
console.log(fs.readFileSync(path.join(tmp, 'vocab', 'my_collection.tsv'), 'utf-8'));

const entries = allEntries(tmp);
console.log('读取条目数:', entries.length);

console.log('=== my_collection_lemmas.txt（去重后供高亮规则）===');
console.log(fs.readFileSync(path.join(tmp, 'vocab', 'my_collection_lemmas.txt'), 'utf-8'));

// 清理
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n临时目录已清理，真实词库未受影响。');
