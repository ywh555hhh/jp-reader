// 验证 M2/M3：更新状态、删除、按 lemma 分组、复习隐藏逻辑
const os = require('os');
const fs = require('fs');
const path = require('path');
const col = require('./out/collection.js');
// loadEntries 已不再对外暴露；按 lemma 分组后展平即得全部条目（保持文件顺序）
const allEntries = (root) => Array.from(col.groupByLemma(root).values()).flat();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-reader-m2-'));
fs.mkdirSync(path.join(tmp, 'vocab'), { recursive: true });

// 准备 3 条数据
col.addEntry(tmp, { lemma:'起きる', surfaceForm:'起き', wtype:'和', pos:'動詞_自立', sentence:'毎朝、七時に起きます。', source:'a.md', status:'new', note:'' });
col.addEntry(tmp, { lemma:'起きる', surfaceForm:'起きて', wtype:'和', pos:'動詞_自立', sentence:'早く起きてください。', source:'b.md', status:'new', note:'' });
col.addEntry(tmp, { lemma:'コーヒー', surfaceForm:'コーヒー', wtype:'外', pos:'名詞_普通名詞', sentence:'コーヒーを飲んでいます。', source:'a.md', status:'new', note:'' });

let entries = allEntries(tmp);
console.log('初始条数:', entries.length);

// 更新状态
const id1 = entries[0].id;
const r1 = col.updateEntryStatus(tmp, id1, 'mastered');
console.log('更新状态 mastered:', r1);
// 更新笔记
const r2 = col.updateEntryNote(tmp, id1, '常考动词');
console.log('更新笔记:', r2);

// 分组（词条详情：一个词多条语境）
const groups = col.groupByLemma(tmp);
console.log('\n=== 按 lemma 分组 ===');
for (const [lemma, list] of groups) {
  console.log(`  ${lemma}: ${list.length} 条语境`);
  for (const e of list) console.log(`      [${e.status}] ${e.sentence} | note=${e.note || '(空)'}`);
}

// 删除
const idDel = entries[2].id;
const remain = col.deleteEntry(tmp, idDel);
console.log('\n删除后剩余条数:', remain);
console.log('lemmas 文件(去重后):');
console.log(fs.readFileSync(path.join(tmp,'vocab','my_collection_lemmas.txt'),'utf-8'));

// 隐藏逻辑（复习）：隐藏表层形式
function hideSurfaces(sentence, surface){
  if(!sentence||!surface) return sentence;
  return sentence.split(surface).join('＿＿');
}
console.log('\n=== 复习隐藏测试 ===');
console.log('原句:', '毎朝、七時に起きます。');
console.log('隐藏后:', hideSurfaces('毎朝、七時に起きます。','起き'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n临时目录已清理。');
