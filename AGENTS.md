# AGENTS.md — 在这个仓库里工作的规则

> 这份文件是给 **agent** 看的契约，也是给人看的。Claude Code 读 `CLAUDE.md`（它只有一行：来看这里）。
> 无论你用哪个 agent（pi / Claude Code / Codex / Cursor），规则是同一套：**因为规则在仓库里，不在你的提示词里。**

## 这是什么

JP Reader：在 VS Code 里读日语 Markdown 课文的工具。数据（词表、规则、课文、个人词条）全是纯文本，
存在这个仓库里，用户可以直接 grep / diff / 手改。

```
vscode-extension/   扩展源码（TypeScript）
examples/minimal/   可公开的示例数据根（手写；真实数据根在仓库外）
rules/              ast-grep 架构规则（编辑时内联生效 + gate 期必跑）
scripts/            gate / 棘轮 / 护栏检查
tests/              可执行的否命题
baseline/           指标预算（只降不升）+ 挂 issue 的存量债务
docs/               架构约束（architecture.md）与决定记录（adr/）
```

## 动手之前先读三个文件

1. `docs/architecture.md` —— 19 条否命题，每一条都有执法者。**你写的代码会被这些规则挡下来。**
2. `docs/adr/` —— 已经做过的架构决定。不要在没有新信息的情况下推翻它们。
3. 你即将修改的那个模块本身。

## 唯一入口命令

```bash
npm install                  # 仓库根目录（工具链）
npm --prefix vscode-extension install
npm run setup                # 装上 pre-commit hook（一次即可）

npm run gate                 # 全量检查 = CI 跑的同一条命令
npm run lint:file -- <文件>  # 编辑期只查改动文件（秒级）
```

## Definition of Done

一个任务只有在下面五条**全部**成立时才算完成：

1. `npm run gate` 为绿。
2. 你的回复里**粘贴了 gate 的原始输出**（不是转述，不是"我跑过了"）。
3. 新代码没有引入新的 `baseline.metrics` 上升；如果确实上升了，是在 PR 描述里写清理由后上调的。
4. 新增的"坏东西数量"（违规计数）如果非零，**先建 issue**，再往 `baseline.frozen` 加 `{ issue, reason, unfreeze_when }`。
5. 如果这次改动触及了架构（分层、数据格式、对外接口、约束松紧），补一条 `docs/adr/`。

## 硬禁止（没有任何"这次特殊"）

| 禁止 | 为什么 | 谁会拦你 |
|---|---|---|
| 加 `@ts-ignore` / `@ts-expect-error` / `eslint-disable` | 让报错消失的最短路径，会让同类 bug 反复复发 | `check:suppressions-within-budget` |
| 删 / 改松 ast-grep 规则、depcruise 规则、tsconfig 严格开关 | 这是"改考卷"而不是"改答案" | `check:guardrails-config-not-weakened` |
| 直接手改 `baseline.metrics` 把数字调大 | 预算上调必须留理由，不能静默发生 | PR 模板 + review |
| 用 `git commit --no-verify` / `git push --no-verify` 跳过 hook | 跳过 gate 等于这次改动没有被检查 | `pre-commit` / `pre-push` |
| **在 CI 红的情况下合并 PR** | 这是本仓库唯一靠"人/agent 自觉"的环节——GitHub 的分支保护和 ruleset 在私有免费仓库上不可用，服务端拦不住你。规矩必须自己守：合并前先看 `gh pr checks <n>` | 只有你的自律（见下方“为什么这里要靠契约”）|
| 用当前时间当持久化主键 | 毫秒级时间戳批量写入必然撞 id，是静默数据损坏 | `astgrep:jp-no-date-as-identity` |
| 写空的 `catch {}` | 吞掉的异常应该留下痕迹 | `astgrep:jp-no-empty-catch` |
| 在渲染层按规则/类型 id 做 `switch` | 一旦渲染层认识具体 id，"改配置就生效"的承诺就断了 | `astgrep:jp-no-ruleid-switch` |
| 为了"让测试过"而改测试 | 测试是规格，不是障碍 | review |
| 一次 PR 里做多个不相关的概念 | 屎山来自"一次大改"，不可评审的 diff 等于没有评审 | `pr-budget` |

### 为什么这里要靠契约，而不是靠服务端

这个仓库是**私有仓库 + 免费个人账号**。GitHub 的分支保护和 ruleset 都需要 Pro：

```
$ gh api -X PUT repos/ywh555hhh/jp-reader/branches/master/protection ...
{"message":"Upgrade to GitHub Pro or make this repository public to enable this feature.","status":403}
```

所以：

- `.github/CODEOWNERS` 是**装饰性的**（没有分支保护就不会触发 code owner review）。
- `gate` / `pr-budget` 只能作为**可见信号**（CI 会红、PR 上会有 ×），不能机械拦住合并。
- 真正的拦截在本地：`npm run setup` 装的 `pre-commit` / `pre-push`。
- 升级为 GitHub Pro（或把仓库转为公开）后，把两个检查设为必需即可：

```bash
gh api -X POST repos/ywh555hhh/jp-reader/rulesets --input - <<'JSON'
{
  "name": "guardrails", "target": "branch", "enforcement": "active",
  "bypass_actors": [{ "actor_id": 5, "actor_type": "RepositoryRole", "bypass_mode": "always" }],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_status_checks",
      "parameters": { "required_status_checks": [{ "context": "gate" }, { "context": "pr-budget" }] } },
    { "type": "pull_request", "parameters": { "required_approving_review_count": 0 } }
  ]
}
JSON
```

## 该做，但很容易忘

- **本仓库只放代码，数据根不在里面。** `vocab/` / `texts/` / 根目录的 `rules_config.json` /
  `providers_config.json` 已被 `.gitignore` 挡住。不要为了让测试或演示“能用”而把真实词表、
  课文、个人收集词条提交进来 —— CEJC 派生数据是「再配布は不可」，教材课文有版权，个人词库含本地路径。
  需要示例就往 `examples/minimal/` 里加**自撰**内容。
- **重复实现是本仓库排名第一的坏味道。** 加新能力之前先问：这个能力已经有实现了吗？
  （本项目已经出现过三套出网实现、三份 `escapeHtml`、两份 `splitForTTS`。）
- **改数据格式必须写迁移。** `vocab/my_collection.tsv` 是用户的真实数据，不能被新代码读不出来。
- **写文件必须原子。** 现有实现是非原子 `writeFileSync`，崩溃就丢整个词库（见 A9）。
- **不要用 `indexOf` 反查位置**，用真实 offset（见 A6）。
- **状态不要挂成模块级 `let`**（见 A10），它正是"一件事被实现三遍"的根因。
- 报告失败时，写**事实 + 目标文件**，不要写鼓励性总结。

## 编辑期反馈

`rules/ast-grep-rules/rules/**` 是本仓库自己的规则目录。
pi-lens 会把它当项目规则加载，**你每次改文件就会看到内联告警**，不需要等 CI。
CI 用的是同一批 YAML（通过 `sgconfig.yml`），所以不存在"本地和 CI 规则不一致"。

⚠ 只有**与文件路径无关**的规则才放在那个目录。带路径豁免的约束（"除了 provider.ts 之外不许 import https"）
写在 `.dependency-cruiser.cjs` 或 `tests/architecture.metrics.mjs` 里——否则它会在合法代码上误报，
很快就没人看了。

## 必须停下来问人的情况

- 要改数据格式且无法保证向后兼容
- 要放宽任何一条否命题（等价于改架构决定）
- 要引入新的外部依赖、网络调用或需要用户凭据的东西
- 发现 `docs/architecture.md` 与实际代码矛盾（先报告，不要单方面改文档去迁就代码）

## 提交信息

第一行至少 8 个字符，写"改了什么"。不写 `wip` / `fix` / `temp`（`commit-msg` hook 会拦）。
正文里写"为什么"和"验证方式"（粘 gate 输出）。

## 当前已知缺口

存量债务在 `baseline/frozen` 里，每条都挂着 issue（#1–#7）。**不要顺手引入同类的新违规**——
棘轮只允许下降，新引入的那一处就是 gate 失败。
