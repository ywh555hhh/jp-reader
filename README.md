# JP Reader — 日语 Markdown 阅读扩展

[![gate](https://github.com/ywh555hhh/jp-reader/actions/workflows/gate.yml/badge.svg)](https://github.com/ywh555hhh/jp-reader/actions/workflows/gate.yml)

> 在你自己的 Markdown 课文里，边读边收集生词；用语境，不靠单词表。

> **给 agent 和贡献者**：这个仓库有可执行的架构约束。开工前先读 [`AGENTS.md`](./AGENTS.md)
> 与 [`docs/architecture.md`](./docs/architecture.md)，完成后跑 `npm run gate` 并粘贴输出。

## 开发约束（护栏）

这个仓库的架构不是写在文档里的约定，而是**一组会失败的检查**。19 条否命题写在
[`docs/architecture.md`](./docs/architecture.md)，每条都绑定一个可执行的执法者
（`astgrep:` / `depcruise:` / `metric:` / `check:` 四种前缀，可机械解析）。

```bash
npm install && npm --prefix vscode-extension install
npm run setup                 # 装上 pre-commit / commit-msg / pre-push hook（每个开发者一次）
npm run gate                  # 全量检查 = CI 跑的同一条命令
npm run lint:file -- <文件>   # 编辑期只查改动文件
```

| 机制 | 拦什么 |
|---|---|
| `rules/ast-grep-rules/` | 写法级否命题（渲染层不得按 id 分支、不得 `indexOf` 反查位置、不得用时间当主键、禁止空 catch）；同一批 YAML 同时用于 agent 编辑期内联诊断和 CI |
| `.dependency-cruiser.cjs` | 依赖图（领域层不得依赖宿主、出网只能走 `provider.ts`、无循环依赖、无死模块） |
| `baseline/guardrails-baseline.json` + `scripts/ratchet.mjs` | 所有"坏东西的数量"只降不升；违规计数非零必须挂 issue |
| `scripts/guard-rules.mjs` | 护栏自身：删规则、关 tsconfig 严格开关、加 `@ts-ignore` 都会让 gate 失败 |
| `.github/workflows/gate.yml` | CI 跑的就是 `npm run gate`，与本地完全同一条命令 |

**服务端强制已开启。** 这个仓库是**公开**的，所以 GitHub ruleset 可用（私有 + 免费账号时不可用）。
`main` 分支的 `guardrails` ruleset 要求：

1. 一律走 PR（不能直推默认分支）
2. `gate` 与 `pr-budget` 两个检查必须通过
3. 禁止删除默认分支、禁止强推

也就是说 **CI 红的时候 GitHub 会直接拒绝合并** —— 实测：

```
$ gh pr merge 1 --squash
X Pull request ywh555hhh/jp-reader#1 is not mergeable: the base branch policy prohibits the merge.
```

三层防线各管一段：本地 hook（秒级）→ `npm run gate`（本地与 CI 同一条命令）→ ruleset（服务端兼不可绕过）。
管理员保留紧急绕过权（ruleset 的 bypass actor），但**agent 一律走 PR**。

## 项目哲学

**课文是主体，词汇是阅读过程中收集的副产品。**

不是"先背单词再读课文"，而是"读课文时遇到生词，顺手存下它的语境"。每个词条都带着它出现过的完整原句和来源文件——这才是记住一个词的正确方式。

四条设计原则：

1. **语境优先，拒绝孤立背词**
   复习不是"看词想意思"，而是"看原句，在上下文里回忆"。句子是记忆的载体。

2. **数据纯文本，用户完全掌控**
   词库、规则、配置、课文，全部是本地 `.tsv` / `.json` / `.md` 文件。没有数据库，没有云端锁死。你可以随时备份、grep、diff、迁移。

3. **离线优先，联网可选**
   分词、高亮、规则引擎、词库——全部本地运行。朗读、翻译、AI 讲解是可选的联网功能，一键可关。

4. **高度模块化，一切可配置**
   翻译/朗读/AI讲解 都是 Provider——一个"吃文字、吐内容"的黑盒。你可以用内置的 Google，也可以换成自己的 HTTP 服务，甚至写一个 Python 脚本当插件。规则引擎同理：改 JSON 就能定义新的高亮规则，不用改代码。

## 核心功能

- **离线分词**：kuromoji.js 本地分词，lemma 归一（`食べた` / `食べて` → `食べる`）
- **可配置高亮规则引擎**：编辑 `rules_config.json`，按 lemma / 語種 / 词频 自定义高亮样式，支持优先级叠加
- **三套视图并存**：
  - 源码编辑器高亮
  - 官方 Markdown 预览高亮（通过 markdown-it 插件注入）
  - **独立阅读视图**：自建 Webview，划词悬浮工具栏（朗读/查词/翻译/AI讲解/语境收集）
- **语境收集**：选中词 + 完整原句 + 来源路径 → 写入 `my_collection.tsv`，自动变琥珀色高亮
- **单词本 + 语境复习**：侧边面板，按 lemma 聚合所有出现过的句子；复习模式隐藏目标词，在上下文里回忆
- **Provider 架构**：翻译/朗读/AI讲解 可插拔，支持 `builtin` / `http` / `command`（Python 脚本）三种来源

## 目录结构

**这个仓库只放代码。** 数据根（词表 / 课文 / 个人收集词条）**不在**本仓库里 —— 它有独立的生命周期，
而且可能包含不可再分发的语料库派生数据（见「代码与数据分开」）。

```
jp-reader/                        # 本仓库（公开）：只有代码
├─ vscode-extension/              # VS Code 插件源码
│  ├─ src/                        # 宿主层 + 领域层（domain 部分不依赖 vscode）
│  ├─ preview/jp-reader.css       # 预览与阅读视图共用的结构性样式
│  └─ smoke_*.js                  # 手工冒烟脚本
├─ examples/minimal/              # 可公开的最小示例数据根（手写，无 CEJC 内容）
│  ├─ rules_config.json           #   两条规则：按词表高亮 + 按語種淡化
│  ├─ providers_config.json       #   Provider 配置模板（无密钥）
│  ├─ vocab/                      #   示例词表 + lemma 映射
│  └─ texts/lesson-sample.md      #   自撰例句
├─ rules/ast-grep-rules/          # 架构否命题（编辑期内联生效 + CI 必跑）
├─ scripts/                       # gate / 棘轮 / 护栏自检 / 改动规模预算
├─ tests/                         # 可执行的否命题（语义 + 运行期）
├─ baseline/                      # 指标预算（只降不升）
└─ docs/                          # 架构约束与决定记录（ADR）
```

你自己的数据根长这样（默认被 `.gitignore`，不进任何公开仓库）：

```
<你的数据根>/
├─ rules_config.json              # 高亮规则
├─ providers_config.json          # Provider 配置
├─ vocab/
│  ├─ wago_p99_full.tsv           # CEJC 派生（再配布不可，⚠ 不要公开）
│  ├─ wago_p99_wordlist_only.txt  # 同上
│  ├─ lemma_wtype.tsv             # 同上
│  ├─ lemma_mapping.tsv           # kuromoji ↔ CEJC lemma 别名映射
│  ├─ my_collection.tsv           # 个人收集词条（扩展写入）
│  └─ my_collection_lemmas.txt    # 派生文件（供规则引擎按文件加载）
└─ texts/                         # 你的 Markdown 课文
```

指定数据根：设置 `jpReader.dataRoot`，或把数据根放在工作区里（扩展会自动向下探测 3 层）。

## 快速开始

### 安装

```bash
cd vscode-extension
npm install
npx vsce package --allow-missing-repository
code --install-extension jp-reader-0.2.0.vsix --force
```

### 使用

1. 打开任意日语 `.md` 课文
2. 点标题栏 📖 图标（或 `Ctrl+Shift+P` → `JP Reader: 打开阅读视图`）
3. 在阅读视图里划词 → 悬浮工具栏：🔊朗读 📖查词 🌐翻译 🤖AI讲解 ➕语境收集
4. 左边活动栏 JP Reader 面板 → 单词本 / 语境复习 / 设置

## Provider 配置（providers_config.json）

每个能力（translate / speak / explain）配置一个 active provider。三种来源：`builtin`（内置）、`http`（你自己的服务）、`command`（你自己的脚本）。

```json
{
  "translate": {
    "active": "google",
    "options": {
      "google": { "type": "builtin" },
      "my_deepseek": {
        "type": "http",
        "url": "https://api.deepseek.com/v1/chat/completions",
        "model": "deepseek-chat",
        "apiKeySecret": "jpReader.deepseek",
        "responsePath": "choices.0.message.content",
        "promptTemplate": "把{text}翻译成简体中文，只输出译文"
      },
      "my_python": {
        "type": "command",
        "command": "python",
        "args": ["C:/jp-plugins/translate.py"]
      }
    }
  },
  "explain": {
    "active": "off",
    "options": {
      "openai": { "type": "builtin", "model": "gpt-4o-mini", "apiKeySecret": "jpReader.openai" }
    }
  }
}
```

### 三条约定

1. **出网只有一个出口**（`provider.ts`）。翻译 / 朗读 / AI 讲解都走同一套配置与错误处理，
   所以 `explain.active = "off"` 对命令面板和阅读视图**同时**生效。
2. **密钥只放密钥存储。** 配置里写 `apiKeySecret`（键名），值用命令
   `JP Reader: 设置 Provider 密钥` 写入 VS Code 的 SecretStorage，不进 settings、不进配置文件。
3. **`promptTemplate` 对 http provider 也生效**（`{text}` / `{sentence}` / `{lemma}` 占位符）。
   需要完全控制请求体时用 `bodyTemplate`（给完整 JSON）。

**写一个 Python Provider**（stdin/stdout JSON 协议）：

```python
# translate.py
import sys, json
req = json.loads(sys.stdin.read())
text = req["text"]
# 你的翻译逻辑
result = {"content": f"[翻译] {text}"}
print(json.dumps(result))
```

## 高亮规则（rules_config.json）

```json
{
  "rules": [
    {
      "id": "wago_p99",
      "enable": true,
      "match": { "lemma_in_file": "./vocab/wago_p99_wordlist_only.txt" },
      "style": { "color": "#4ade80", "fontWeight": "500" },
      "priority": 10
    },
    {
      "id": "dim_kanji_gairaigo",
      "enable": true,
      "match": { "wtype": ["漢", "外"] },
      "style": { "color": "#888888" },
      "priority": 1
    }
  ]
}
```

## 代码与数据分开

本仓库**只放代码**。数据根（词表 / 课文 / 收集词条）有自己的生命周期，而且可能包含
**不可再分发的语料库派生数据**，所以它放在本仓库之外（本地目录或私有仓库）。

`.gitignore` 已经把根目录的 `vocab/`、`texts/`、`rules_config.json`、`providers_config.json` 挡在外面，
避免顺手把自己的数据提交进去。示例数据在 `examples/minimal/`（手写，可公开）。

### 为什么不能把词表一起公开

`vocab/lemma_wtype.tsv`、`vocab/wago_p99_full.tsv`、`vocab/wago_p99_wordlist_only.txt`
都是从 CEJC（『日本語日常会話コーパス』短単位語彙表，CEJC-WSD-frequency 2024.03）
**派生**出来的：

- `wago_p99_*`：按語種=和語 筛选、按見出し語聚合 token 频度后截取 P99 得到的词表
- `lemma_wtype.tsv`：对每个 lemma 取累计频度最高的語種

国立国語研究所的官方许可注明「**再配布は不可**」（禁止再分发），商业用途需另行咨询。
因此：

- 这三个文件**不要**提交到任何公开仓库
- 它们不随本仓库分发；生成脚本在私有数据仓库里（`vocab/build_lemma_wtype.py`、`cejc-wago-p99`），
  需自己从官方仓库下载原始数据后本地生成
- 引用时请注明出处：国立国語研究所 (2024)『日本語日常会話コーパス』短単位語彙表
  （分類語彙表番号つき）(CEJC-WSD-frequency version 2024.03)

另外 `examples/minimal/texts/lesson-sample.md` 是**自撰**例句，
不是任何教材的课文（教材课文同样有版权，不要提交）。
