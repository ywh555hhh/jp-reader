/**
 * 依赖图约束（否命题 A1–A4，见 docs/architecture.md）
 *
 * 这里只表达"谁不许依赖谁"。它不检查代码风格，也不检查调用点——
 * 调用级的约束在 rules/ast-grep-rules/ 和 tests/architecture.test.mjs。
 *
 * 运行：npx depcruise vscode-extension/src  （或 npm run gate）
 * 新增规则前请先读 docs/architecture.md，并同步更新那张表的"执法者"列。
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-purity',
      severity: 'error',
      comment:
        'A1 领域层不得依赖宿主。dataLoader / ruleEngine / collection / tokenizer 必须能在纯 Node 下运行与单测，' +
        '禁止 import 或 require("vscode")。需要配置或提示时，由上层把值传进来。',
      from: {
        path: '^vscode-extension/src/(dataLoader|ruleEngine|collection|tokenizer)\\.ts$',
      },
      to: { path: '^vscode$' },
    },
    {
      name: 'single-http-entry',
      severity: 'error',
      comment:
        'A2 出网只有一个出口：provider.ts。其它模块一律调用 callProvider(kind, input)，' +
        '不得自己 import node:http(s) —— 否则同一能力会出现第二套配置、第二套错误处理。',
      from: { pathNot: '^vscode-extension/src/provider\\.ts$' },
      to: { path: '^(node:https|node:http|https|http)$' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'A3 禁止循环依赖。循环依赖是模块边界失效的第一个信号。',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-orphan-module',
      severity: 'error',
      comment:
        'A4 不允许存在无人引用的模块（死代码）。若某模块只被测试引用，请把它加入 knip 的 entry，' +
        '而不是让它悄悄留在 src/ 里。',
      from: { orphan: true, pathNot: '\\.d\\.ts$' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: 'node_modules|\\.d\\.ts$' },
    // 刻意不设 options.tsConfig。
    //
    // 踩过的坑：一开始指向 vscode-extension/tsconfig.json，而那个文件的 include 是
    // ["src"]（相对它自己的目录）。当 depcruise 从仓库根运行时，tsc 会报
    // TS18003 No inputs were found，收集器一句话不吭地 SKIP 掉，于是两条违规则
    // “看起来有人管”，实际根本没人查。
    //
    // 去掉它之后，acorn 模式能正确解析全部 21 个模块、54 条依赖（含 node 内置模块、
    // vscode 与全部相对导入），结果与手查一致。好处是：**全仓只有一份 tsconfig**，
    // 不再存在“第二个 tsconfig 描述同一批文件”这种漂移面。
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
      extensions: ['.ts', '.js'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
