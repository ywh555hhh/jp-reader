# 示例数据根（minimal）

这是一个**可以公开的**最小数据根，用来自演示 / 自测 JP Reader 的全部机制。
所有内容都是手写的示例，**不含任何语料库派生数据**。

```
examples/minimal/
├─ rules_config.json        两条规则：按词表高亮 + 按語種淡化
├─ providers_config.json    Provider 配置模板（无任何密钥）
├─ vocab/
│  ├─ wago_sample.txt       手写和语词表（15 个常见词）
│  ├─ lemma_wtype.tsv       上述词的 lemma→語種（和/漢/外）
│  └─ lemma_mapping.tsv     kuromoji ↔ CEJC lemma 的别名映射（手写）
├─ dict/
│  └─ sample.dict.tsv       手写示例词典（19 个词，让查词能显示释义）
└─ texts/
   └─ lesson-sample.md      自撰例句（不是任何教材的课文）
```

## 怎么用

在 VS Code 设置里把数据根指到这里（或者指到你自己那份完整数据根）：

```json
{
  "jpReader.dataRoot": "<仓库路径>/examples/minimal",
  "jpReader.dictionaryPath": "<仓库路径>/examples/minimal/dict/sample.dict.tsv"
}
```

第二条是可选的：不配词典时查词只显示词性/語種；配上就会多出行释义。
真实词典（Yomichan term_bank / JMdict-simplified / 你自己的 TSV）请放在仓库外
（根目录的 `dict/`、`dictionaries/` 已被 gitignore）。

## ⚠ 完整词表要自己生成，不要提交进仓库

本仓库**只放代码**。真实使用的数据根（含 CEJC 派生的和语 P99 词表、
你自己的课文与收集词条）应当放在**另一个私有位置**：

- 直接用本地目录（默认 `gitignore` 了根目录的 `vocab/`、`texts/`、`rules_config.json`、`providers_config.json`）
- 或放在一个私有仓库里

CEJC（『日本語日常会話コーパス』）的原始语料与词表的版权归国立国語研究所所有，
官方许可注明「再配布は不可」。所以：

- **不要**把 `wago_p99_*` / `lemma_wtype.tsv` 这类派生数据提交到任何公开仓库
- 生成方式见私有数据仓库里的 `vocab/build_lemma_wtype.py` 与
  `cejc-wago-p99`（都是从官方 `CEJC-WSD-frequency` 本地生成）

引用时请注明出处：国立国語研究所 (2024)『日本語日常会話コーパス』短単位語彙表（分類語彙表番号つき）
(CEJC-WSD-frequency version 2024.03)。
