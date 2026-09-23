# 0001. 用「可执行的否命题 + 指标棘轮」替代口头架构约定

- 状态：已采纳
- 日期：2026-09-23
- 关联：issue #1–#7、`docs/architecture.md` 全部条目

## 背景

这个仓库的第一版（M0–M3）是用 agent 写的。功能长出来了，但同一种坏味道出现了三次以上：

- **同一能力多份实现**：出网有三套（`provider.ts` / `translation.ts` / `aiExplain.ts`），
  `escapeHtml` 三份，`splitForTTS` 两份，Webview 里还有一份 Google TTS URL 拼接
- **承诺与实现不一致**：README 写「改 `rules_config.json` 就能定义新规则」，
  但预览路径按 `rule.id` 硬编码到 4 个 CSS class；README 写「优先级叠加」，代码是取最高优先级
- **死代码静默存活**：`furigana.ts` 整个文件没有被任何地方调用（它依赖的 API 其实不存在，被 try/catch 吞掉）
- **数据完整性**：词条主键用毫秒时间戳，实测连续 300 次写入有 224 次撞同一毫秒
- **模块级可变状态 7 处**，靠全局注入互相串联

根因不是 agent 写得差，而是**没有任何机制阻止"这次只加一点点"**。
每一次 diff 单看都合理，累积起来就是屎山。

同时，把架构写成文档也无效：文档不可执行，agent 不会读第二遍，改完也没人检查。

## 决定

架构用**否命题 + 棘轮**表达，而不是用文档描述：

1. 想要的架构写成**禁止式约束**（"X 不许依赖 Y"、"不许出现某种写法"），愿望式描述一律不算。
2. 每条约束必须绑定一个**可执行的执法者**，只有四种：`astgrep:` / `depcruise:` / `metric:` / `check:`。
3. 所有"坏东西的数量"进一份 baseline，**只降不升**；`npm run gate` 是唯一判定入口，CI 跑同一条命令。
4. 数量非零可以接受，但**必须挂 issue**（`baseline.frozen`），且必须写清 `unfreeze_when`。
5. 护栏自身也被检查（`scripts/guard-rules.mjs`）：删规则、关 tsconfig 开关、加 `@ts-ignore` 都会失败。
6. 架构决定写进 `docs/adr/`，防止下一个 agent 把已讨论过的结论重新推翻。

## 为什么不是别的选项

- **「把存量违规一次清零，然后要求零容忍」**：否决。第一天就要重写三套出网实现 + 数据格式迁移，
  这是一个不可评审的巨型 PR，而巨型 PR 正是我们想避免的东西。棘轮允许"先欠着"，但要挂 issue、有解冻条件。
- **「写更详细的架构文档 + 在 AGENTS.md 里叮嘱」**：否决。这是第一版已经在做的事，失败了。
  文档不能失败，规则才能失败。
- **「上 ESLint 全家桶 + 更多 lint 规则」**：否决作为主要手段。lint 管的是"这一行/这个函数"，
  架构是**图**和**熵**：依赖方向、重复实现、死代码、模块体积——lint 结构上看不见这些。
  lint 保留在卫生层（tsc 严格开关 + knip + jscpd），不承担架构职责。
- **「把架构规则塞进 Code Review 清单，靠人看」**：否决作为主要手段。人会在第 20 个 PR 上松懈，
  而且 agent 提交的 PR 常常没人真的逐行看。
- **「用 `files:`/`ignores:` 把带路径豁免的规则也写成 ast-grep」**：在编辑期否决。
  pi-lens 只把规则的 `rule` 部分交给 ast-grep 引擎，不处理路径条件，
  这类规则会在合法文件上持续误报，最后教出"忽略告警"的习惯。
  路径相关的约束改为 depcruise 规则或 metric。这条限制写进了 `docs/architecture.md`。

## 后果

**变好的地方**

- 架构约束会**失败**，不是"建议"。agent 在编辑期就能看到部分反馈（不等 CI）。
- 存量债务第一次有了主（每条都有 issue 编号）和期限（`unfreeze_when`）。
- "先欠着"变成一个有意识的决定，而不是一句"以后再修"。
- 想放松约束的成本被显式提到"需要写 ADR"，而不是改一行配置。

**付出的代价**

- 多了一个需要维护的工具链（ast-grep / dependency-cruiser / knip / jscpd / 自定义棘轮）。
- 第一次 `npm run gate` 需要把 baseline 建起来；新增一条否命题时要跑一次 `gate:update-baseline`。
- 阈值被写死在 `scripts/guard-rules.mjs` 里，改阈值要改代码——这是故意的：
  改代码比改一个 YAML 字段更容易被 review 注意到。

**接受的风险**

- 棘轮只能防"变多"，防不住"设计本身是错的"。它是一道地板，不是建筑师。
- `metric:capability_url_extra_copies` 靠 URL 特征识别重复实现，
  换一个不外露 URL 的重复实现（例如复制一个函数）只能靠 jscpd 和 review。

## 怎么验证这条决定还活着

- `check:guardrails-config-not-weakened` 必须为绿——它一旦被绕过，整套机制就退化成装饰。
- `metric:invariants_without_enforcer` 必须为 0——它保证不存在"写在文档里但没人检查"的约束。
- `metric:frozen_metrics_without_issue` 必须为 0——它保证不存在无主债务。
- 每次 `npm run gate` 都会打印完整的指标表，涨了就是 `GREW`。
