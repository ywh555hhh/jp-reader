# 架构与不变量

> 这份文档是这个仓库唯一「关于架构」的真相。**它不是描述，是约束。**
> 每一行都会有人检查——表格里没有执法者的约束不允许存在。

---

## 一分钟版

- 架构不是一个决定，是一组**会失败的检查**。
- 想要的架构必须写成**禁止式**（"X 不许依赖 Y"），而不是愿望式（"模块应该清晰"）。
- 检查分四层：`ast-grep`（写法）、`depcruise`（依赖图）、`metric`（数量预算）、`check`（护栏自身的完整性）。
- **任何"坏东西的数量"只降不升**；数字存在 `baseline/guardrails-baseline.json`。
- 数不清零可以，但**必须挂 issue**（`baseline.frozen`），否则 gate 直接失败。
- 相关决定记录在 `docs/adr/`。**改架构前先读 ADR**，否则你会把上一个 agent 已经讨论过的结论重新推翻一遍。

三条命令：

```bash
npm run setup                # 装上 pre-commit hook（每个开发者做一次）
npm run gate                 # 全量检查（= CI 跑的同一条命令）
npm run lint:file -- <文件>  # 编辑期只查改动文件
```

---

## 分层与数据流

```
宿主层（认识 VS Code）                          领域层（纯 Node，可单测）
  extension.ts        命令注册 / 高亮调度
  mdPlugin.ts         预览注入            ──▶     ruleEngine.ts    规则匹配（无 vscode）
  readingView.ts      自绘 webview                dataLoader.ts    词表/规则加载 ← 目前违规，见 A1
  wordbookView.ts     侧边单词本                  collection.ts    词条读写（无 vscode）
  highlighter.ts      编辑器装饰                  tokenizer.ts     kuromoji 封装（无 vscode）
  provider.ts         **唯一出网出口**            kuromoji.d.ts    类型声明
  tts.ts / translation.ts / aiExplain.ts  ← 需要收敛进 provider，见 A2
```

数据（纯文本，用户可 grep / diff / 手改）。⚠ **它们在数据根里，不在本仓库里**
（本仓库只放代码；`examples/minimal/` 是一份手写的示例数据根）：

```
rules_config.json          高亮规则（改这里就应该立即生效，不需要改 TS）
providers_config.json      翻译/朗读/讲解的 provider 选择
vocab/lemma_wtype.tsv      lemma → 語種
vocab/lemma_mapping.tsv    kuromoji lemma ↔ CEJC lemma
vocab/my_collection.tsv    个人收集词条（按"条目"：一个词可以有多条语境）
vocab/my_collection_lemmas.txt  派生文件：供规则引擎按文件加载
vocab/review_state.tsv     复习状态（按"lemma"：每个词只有一条，间隔重复的调度依据）
texts/                     课文
```

数据根的位置由 `jpReader.dataRoot` 决定，或由扩展从工作区向下探测（最多 3 层）。
真实词表（CEJC 派生）与个人收集词条属于「再配布不可 / 个人数据」，不要提交到公开仓库。

---

## 不变量（否命题）

执法者列只有四种合法前缀，每一种都能被机械解析到真实存在的东西：

| 前缀 | 含义 | 解析方式 |
|---|---|---|
| `astgrep:<rule-id>` | 写法级约束，编辑时内联报错 | `rules/ast-grep-rules/rules/**` 里的 `id:` |
| `depcruise:<rule-name>` | 依赖图约束 | `.dependency-cruiser.cjs` 里的 `name:` |
| `metric:<key>` | 数量预算，只降不升；违规计数非零必须挂 issue | `baseline.metrics` 的 key |
| `check:<check-id>` | 护栏自身的完整性 | `scripts/guard-rules.mjs` 里的检查 |

| ID | 否命题（禁止式） | 为什么 | 执法者 |
|---|---|---|---|
| A1 | 领域层不得 import / require `vscode` | 数据层一旦认识宿主，就无法单测，`smoke_test.js` 只能把同一份解析逻辑手抄一遍 | depcruise:domain-purity |
| A2 | 出网只允许 `provider.ts` | 两套出网实现 = 两套配置、两套错误处理、开关互相骗人 | depcruise:single-http-entry |
| A3 | 禁止循环依赖 | 循环依赖是模块边界失效的第一个信号 | depcruise:no-circular |
| A4 | 不允许存在无人引用的模块 | 死模块会被人当成"现成的实现"继续改（本项目已删过一个 `furigana.ts`） | depcruise:no-orphan-module |
| A5 | 渲染层不得对 `rule.id` 做 switch / 字符串比较 | 一旦渲染层认识具体 id，"改 JSON 就生效"的承诺就只对硬编码过的 id 成立 | astgrep:jp-no-ruleid-switch |
| A6 | 定位一次出现必须用真实 offset，禁止 `indexOf(surface)` 反查 | 反查只能拿到全文第一次出现，同词多次出现时会静默存错原句 | astgrep:jp-no-indexof-position-lookup |
| A7 | 禁止用当前时间当持久化主键（规则只看 id 语境；时间戳当普通字段是允许的） | 毫秒级时间戳在批量写入时必然撞 id，之后按 id 的更新/删除会一次命中多行 | astgrep:jp-no-date-as-identity |
| A8 | 禁止完全空的 `catch` 块 | 空 catch 是让报错消失的最短路径，也是同类 bug 反复复发的根因 | astgrep:jp-no-empty-catch |
| A9 | 裸写文件只允许出现在唯一一个模块 | 写文件散开就无法保证原子性。本项目曾经就是直接 `writeFileSync` 覆盖：崩在半路会丢掉整份词库 | metric:files_with_raw_writes |
| A10 | 模块级可变状态不得扩散 | 同一事实被多条路径各自持有，是"一件事被实现三遍"的根因 | metric:files_with_module_level_state |
| A11 | 同一能力不得有第二处实现 | 重复实现是屎山最常见的形态，且不会有人主动删 | metric:capability_url_extra_copies |
| A12 | 违规计数非零必须挂 issue | 无主债务等于永久债务；挂 issue 是唯一的"合法申请通道" | metric:frozen_metrics_without_issue |
| A13 | 文档里的每条否命题都必须有执法者 | "写在文档里但没人检查"的约束三个月后必然失效 | metric:invariants_without_enforcer |
| A14 | 护栏配置本身不得被削弱 | 否则 agent 的最优策略会变成改 lint 配置，而不是改代码 | check:guardrails-config-not-weakened |
| A15 | 单文件不得超过 500 行 | 超长文件是"拆不动"的直接信号，也是 agent 最容易堆代码的地方 | metric:source_files_over_500_lines |
| A16 | 类型检查必须零错误 | 类型错误数量一旦允许非零，就会永远非零 | metric:typecheck_errors |
| A17 | 死代码（未用文件/导出/依赖）必须为零 | 死导出会被下一个 agent 当成 API 来用 | metric:knip_issues |
| A18 | 重复代码行数只降不升 | 重复块会随功能一起演化，成本是平方级的 | metric:jscpd_duplicated_lines |
| A19 | 超过 350 行的源文件数只降不升 | 用阈值计数而不是总行数，避免"加一行就红"把棘轮变成背景噪音 | metric:files_over_350_lines |
| A20 | 写盘必须原子（临时文件 → fsync → rename），禁止 `fs.*` 形式的裸写 | 数据文件是用户的唯一副本；就地覆盖中途失败会把它截断，而 rename 在同一目录内是原子的 | astgrep:jp-no-raw-fs-write |
| A21 | 扩展声明的每个设置项都必须被代码读取 | 声明了却没人实现 = 假承诺：用户设了不会有任何反应（曾经有 5 个这种设置） | check:declared-settings-are-read |

---

## 怎么加一条新的否命题

1. 在下面的机制里挑一个执法者：
   - 能写成"某个写法不许出现" → 加一条 ast-grep 规则到 `rules/ast-grep-rules/rules/arch/`，
     **并在 `rules/ast-grep-rules/rule-tests/` 里加对应的 valid / invalid 用例**（没有测试的规则不允许存在）
   - 能写成"某个模块不许依赖另一个模块" → 加一条 `forbidden` 规则到 `.dependency-cruiser.cjs`
   - 是"某个坏东西的数量" → 在 `tests/architecture.metrics.mjs` 里加一个收集器，或加一个工具收集器到 `scripts/ratchet.mjs`
   - 是运行期才暴露的问题（数据唯一性、迁移、落盘格式） → 在 `tests/*.test.mjs` 里写成真实断言（并在 `scripts/gate.sh` 里挂上运行它的步骤，需要先编译）
   - 是"护栏自身完整性" → 在 `scripts/guard-rules.mjs` 里加一项检查
2. 在上面的表里加一行，执法者列填对应的 token。
3. 跑 `npm run gate:update-baseline` 把当前值登记进去，再跑 `npm run gate` 确认是绿的。
4. 如果新指标当前值 > 0：**先建 issue**，再往 `baseline.frozen` 里加 `{ issue, reason, unfreeze_when }`。

第 4 步是故意设计的摩擦：它让"先欠着"变成一个有主、有期限、有解冻条件的决定，而不是一句"以后再修"。

---

## 编辑期 vs gate 期

| 通道 | 什么时候 | 跑什么 | 特点 |
|---|---|---|---|
| 编辑期（pi-lens 内联诊断） | agent 每次改文件 | `rules/ast-grep-rules/rules/**` 的项目规则 | 反馈最快；**只放"与文件路径无关"的规则**，否则会在合法文件上误报，反而教 agent 忽略告警 |
| 编辑期（手动） | 提交前 | `npm run lint:file -- <文件>` | ast-grep + depcruise，秒级 |
| 本地提交/推送 hook | `git commit` / `git push` | `npm run gate` | **本仓库的主要拦截手段**（`npm run setup` 安装） |
| 规则自身 | 改 ast-grep 规则时 | `rules/ast-grep-rules/rule-tests/` 里的 valid / invalid 用例 | 保证"收窄或放宽规则"这件事被测试过，而不是无人察觉 |
| 运行期 | gate 期（需先编译） | `npm run test:unit`（`tests/collection.test.mjs`） | **静态规则看不见的东西**：主键唯一性、旧数据迁移、落盘格式。修 #1 时正是这一层抓出了"每行被 trim 掉行尾制表符 → 10 列被当成 9 列 → 所有行列错位" |
| gate 期 | CI / 每个 PR | `npm run gate` | 唯一权威判定；CI 与本地跑的是同一条命令 |
| 服务端（ruleset） | 合并前 | `gate` / `pr-budget` + 要求走 PR + 禁止删除/强推 | **已开启**（仓库公开后 ruleset 可用）。CI 红时 GitHub 直接拒绝合并；管理员保留紧急绕过权 |

**为什么规则要分这两类**：pi-lens 只把规则的 `rule` 部分喂给 ast-grep 引擎，它不处理 `files:` / `ignores:` 这类路径条件。所以带路径豁免的约束（"除了 provider.ts 之外不许 import https"）必须写成 depcruise 规则或 metric，不能写成 ast-grep 规则——否则它在编辑期会对着合法代码一直报警，很快就会被无视。

---

## 跳模块约定

这些是修 #4 / #5 / #6 / #2 时定下来的，改对应代码前先看一眼：

1. **样式只有一份来源。** 规则的颜色/字重来自 `rules_config.json`，由 `highlightStyle.ts`
   翻成内联 CSS；`preview/jp-reader.css` 只放结构性样式（悬停、注音排版），
   预览与阅读视图共用它。不要在渲染层写 `switch (rule.id)`，也不要在 CSS 里写死具体规则的配色。
2. **所有日语词都带 `data-offset`**（不只是命中规则的词）。
   划词收集/讲解靠这个真实 offset 定位原句；没包 span 的词选不中，就又得回头用词形反查（A6）。
   对齐由 `readingSource.ts` 的单调匹配器完成，对不上时宁可不给 offset。
3. **数据变了就重载，不要求用户 Reload Window。**
   `dataWatcher.ts` 监听 `rules_config.json` / `providers_config.json` / `vocab/*.tsv`，
   变更 → 重新加载 + 重画高亮 + 刷新单词本/阅读视图/预览。
   新增会被用户手改的数据文件时，记得把它加进监听范围。
4. **句子切分只有一个实现：`readingSource.sentenceAt()`。**
   编辑器命令（`jpSelection` 系）与阅读视图都调它；不要在任何地方再写一份。
   以前两边各有一份，规则不完全一致，同一处文本会得到不同的“原句”。
5. **出网与密钥：`provider.ts` 是唯一的出网口；密钥只进 SecretStorage。**
   URL 字面量、node:http(s) 的 import、Authorization 组装都只允许出现在 `provider.ts`
   （配置读写在 `providerModel.ts`，它是纯的）。所以**朗读也只向 provider 要 URL**，
   自己不再拼 URL —— 以前同一串 Google TTS URL 在三个文件里各写了一份。
   新增需要网络的能力时，先往 provider 里加一个 kind，不要在调用方直接发请求。
6. **复习调度是纯函数，复习状态是独立数据集。**
   `reviewSchedule.ts` 不读文件、不认识 vscode、"今天"由调用方传入（`todayKey()`）——
   所以间隔序列可以被确定性地单测（"记住了"的间隔是 1 → 3 → 8 → 20 天，写在测试里）。
   `reviewStore.ts` 把状态存在 `vocab/review_state.tsv`，与 `my_collection.tsv` **分开**：
   前者按 lemma（一个词一条），后者按条目（一个词多条语境）。粒度不同就别混一张表，
   否则迟早出现"同一个词两条记录状态不一致"。落盘走 `atomicWrite`（A20）。
   改调度算法时：先改 `tests/reviewSchedule.test.mjs` 里的序列断言，再改实现。
7. **可变状态只允许出现在 `appContext.ts`（否命题 A10）。**
   “当前是什么”这类事实——规则表、数据根、词典目录、密钥读取器、provider 配置、
   tokenizer 缓存、阅读视图会话——一律从 ctx 取；功能模块不要新增模块级 `let`。
   `provider.ts` 本身是**无状态**的（配置与密钥通过 `ProviderRuntime` 传入），
   因为 ctx 已经依赖 provider，反过来依赖会形成循环。
   新增一个可变事实时先问：它属于 ctx，还是其实应该当作参数传下去？
   （复习状态不在 ctx 里 —— 它是**数据**，存在数据根的 TSV 里，不是进程内状态。）

## 指标与预算

当前预算值不在这份文档里，它们是数据，在 `baseline/guardrails-baseline.json`：

```jsonc
{
  "version": 1,
  "metrics": { "astgrep:jp-no-date-as-identity": 1, ... },   // 当前允许的最大值，只降不升
  "frozen":  { "astgrep:jp-no-date-as-identity": { "issue": 1, "reason": "...", "unfreeze_when": "..." } }
}
```

两条硬规则：

1. **上升即失败。** 没有"这次特殊"。要合法上调，必须在 PR 描述里写理由，并保持 `gate` 为绿。
2. **违规计数（`depcruise:*` / `astgrep:*` / `knip_issues` / `typecheck_errors`）非零必须挂 issue。**
   其余指标（文件数、体积阈值、重复行数）是预算，允许非零，但仍然只降不升。

指标的选择有一条硬要求：**它不能在正常的加代码时自然上升。**
`jscpd_*` 是唯一会随重构浮动的指标——上升时要么消重，要么在 PR 里说明理由后 update-baseline。
反例（已被移除）：`source_total_lines` 在任何一次加代码时都会上升，
结果是每个 PR 都得跑一次 update-baseline，等于把棘轮变成背景噪音。

---

## ADR

`docs/adr/` 记录"为什么现在是这样"。改动架构、放宽任何约束、引入新的横切机制之前，先读一遍相关 ADR，
必要时写一条新的。判定标准很简单：**如果撤销这个决定需要重写代码，它就该有一条 ADR。**
