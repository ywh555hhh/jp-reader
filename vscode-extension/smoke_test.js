// 冒烟测试：验证 kuromoji 分词 + lemma 映射 + wtype 查表 + 规则匹配管线。
// 在 VS Code 外独立运行，不依赖 vscode API。
//
// 解析部分直接复用 dataLoader —— 以前这里手抄了一份 loadSet / lemmaWtype / lemmaMapping
// 的解析逻辑，正是"数据层因为依赖 vscode 而无法复用"的症状（见 issue #3）。
const fs = require('fs');
const kuromoji = require('kuromoji');
const path = require('path');
const { loadData, readLemmaSet } = require('./out/dataLoader.js');

const DIC = path.join(__dirname, 'node_modules', 'kuromoji', 'dict');
const REPO = path.join(__dirname, '..');
// 本仓库只放代码：数据根默认在仓库外。仓库根没有 data root 时回落到示例数据根。
const ROOT = fs.existsSync(path.join(REPO, 'rules_config.json'))
    ? REPO
    : path.join(REPO, 'examples', 'minimal');
console.log('数据根:', ROOT);

const { data, problems, summary } = loadData(ROOT);
for (const problem of problems) {
    console.log('  ⚠', problem);
}
console.log('  ', summary);

const wagoSet = readLemmaSet(path.join(ROOT, 'vocab', 'wago_p99_wordlist_only.txt'));
const lemmaWtype = data.lemmaWtype;
const lemmaMapping = data.lemmaMapping;

kuromoji.builder({ dicPath: DIC }).build((err, tokenizer) => {
    if (err) { console.error('构建失败', err); process.exit(1); }
    const text = '毎朝、七時に起きます。そして、コーヒーを飲んで、電車で会社へ行きます。';
    const tokens = tokenizer.tokenize(text);
    console.log('=== 分词 + 标注 ===');
    for (const t of tokens) {
        const lemma = lemmaMapping.get(t.basic_form) || t.basic_form;
        const wtype = lemmaWtype.get(lemma) || '不明';
        const inWago = wagoSet.has(lemma);
        let tag = '-';
        if (inWago) tag = 'WAGO✓';
        else if (wtype === '漢' || wtype === '外') tag = '淡化';
        console.log(`  ${t.surface_form.padEnd(6, '　')} basic=${(t.basic_form || '').padEnd(4, '　')} →lemma=${lemma.padEnd(4, '　')} wtype=${wtype.padEnd(2)} ${tag}`);
    }
    console.log('\n=== 校验要点 ===');
    console.log('wago集合大小:', wagoSet.size, '| lemma_wtype:', lemmaWtype.size, '| mapping:', lemmaMapping.size);
    const checkOk = tokens.some(t => wagoSet.has(lemmaMapping.get(t.basic_form) || t.basic_form));
    console.log('存在和语命中:', checkOk);
});
