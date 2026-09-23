#!/usr/bin/env node
/**
 * 护栏的护栏（guard the guards）。
 *
 * 前面所有的规则都可以被"改配置"绕过：删掉一条 ast-grep 规则、给 tsconfig 去掉 noUnusedLocals、
 * 在文件顶部加 @ts-nocheck、把 metrics 从 baseline 里删掉……这个脚本就是防这些的。
 *
 * 它只做一件事：检查护栏本身是否被削弱。业务代码的问题不归它管。
 * 用法：node scripts/guard-rules.mjs        （npm run gate 的第一步）
 *
 * 注意：这里的阈值只允许加严。要放松任何一条，必须先写 ADR（docs/adr/），因为这属于改架构决定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ROOT,
  BASELINE_PATH,
  SRC_DIR,
  ARCH_DOC,
  ASTRGREP_RULE_DIR,
  DEPCRUISE_CONFIG,
  astgrepRuleIds,
  depcruiseRuleNames,
  listSourceFiles,
  parseInvariants,
} from '../tests/architecture.metrics.mjs';

export const MIN_ASTRGREP_RULES = 4;
export const MIN_DEPCRUISE_RULES = 4;
export const MIN_INVARIANTS = 12;
/** 每条 ast-grep 规则都应当有自己的 valid/invalid 测试（改规则时才知道自己改了啥） */
export const MIN_RULE_TESTS = 1;
export const MAX_SUPPRESSIONS = 0;

export const REQUIRED_TSCONFIG_FLAGS = [
  'strict',
  'noUnusedLocals',
  'noUnusedParameters',
  'noImplicitOverride',
  'noFallthroughCasesInSwitch',
  'forceConsistentCasingInFileNames',
];

export const REQUIRED_SCRIPTS = [
  'setup',
  'gate',
  'gate:update-baseline',
  'guard',
  'lint:file',
  'test:arch',
  'test:unit',
  'typecheck',
  'deadcode',
];

export const REQUIRED_GATE_STEPS = [
  'scripts/guard-rules.mjs',
  'scripts/ratchet.mjs',
  'tests/architecture.test.mjs',
  'test:unit',
];

const SUPPRESSION_RE = /(@ts-ignore|@ts-expect-error|@ts-nocheck|eslint-disable)/;

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}

/* ------------------------------------------------------------------ */
/* 每项检查都有稳定的 id，docs/architecture.md 用 check:<id> 引用它     */
/* ------------------------------------------------------------------ */

export function runChecks(root = ROOT) {
  const checks = [];
  const add = (id, title, ok, detail) => checks.push({ id, title, ok: Boolean(ok), detail: detail || '' });

  // 1) ast-grep 规则没有被删掉或写残
  const ruleIds = astgrepRuleIds(root);
  const badRules = [];
  for (const entry of fs.existsSync(path.join(root, ASTRGREP_RULE_DIR))
    ? fs.readdirSync(path.join(root, ASTRGREP_RULE_DIR), { recursive: true })
    : []) {
    const rel = String(entry);
    if (!/\.ya?ml$/.test(rel)) {
      continue;
    }
    const text = fs.readFileSync(path.join(root, ASTRGREP_RULE_DIR, rel), 'utf8');
    for (const field of ['id:', 'language:', 'severity:', 'message:', 'rule:']) {
      if (!new RegExp(`^${field}`, 'm').test(text)) {
        badRules.push(`${rel} 缺少 ${field}`);
      }
    }
  }
  add(
    'astgrep-rules-present',
    `ast-grep 规则数 >= ${MIN_ASTRGREP_RULES} 且字段完整`,
    ruleIds.size >= MIN_ASTRGREP_RULES && badRules.length === 0,
    badRules.length > 0 ? badRules.join('; ') : `当前 ${ruleIds.size} 条`
  );

  // 2) 每条 ast-grep 规则都要有 valid/invalid 测试。
  // 没有这一层，改一条规则（例如把匹配条件收窄）就无人察觉地放宽了约束。
  const ruleTestDir = path.join(root, 'rules/ast-grep-rules/rule-tests');
  const ruleTests = fs.existsSync(ruleTestDir)
    ? fs.readdirSync(ruleTestDir).filter((f) => /\.ya?ml$/.test(f))
    : [];
  const untested = [...ruleIds].filter(
    (id) => !ruleTests.some((f) => f.startsWith(id))
  );
  add(
    'astgrep-rule-tests-present',
    `规则测试文件数 >= ${MIN_RULE_TESTS} 且未被测试的规则数为 0`,
    ruleTests.length >= MIN_RULE_TESTS && untested.length === 0,
    untested.length > 0
      ? `以下规则没有 rule-tests/<id>-test.yml：${untested.join(', ')}`
      : `当前 ${ruleTests.length} 个测试文件`
  );

  // 3) depcruise 规则没有被删掉，且每条都写了 comment（comment 就是给人看的"为什么"）
  const depNames = depcruiseRuleNames(root);
  const cfgPath = path.join(root, DEPCRUISE_CONFIG);
  const cfgText = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
  const commentCount = (cfgText.match(/comment:/g) || []).length;
  add(
    'depcruise-rules-present',
    `依赖图规则数 >= ${MIN_DEPCRUISE_RULES} 且每条都有 comment`,
    depNames.size >= MIN_DEPCRUISE_RULES && commentCount >= depNames.size,
    `规则 ${depNames.size} 条 / comment ${commentCount} 处`
  );

  // 3) tsconfig 的严格开关不许被关掉
  const tsconfig = readJson('vscode-extension/tsconfig.json');
  const opts = tsconfig.compilerOptions || {};
  const offFlags = REQUIRED_TSCONFIG_FLAGS.filter((f) => opts[f] !== true);
  add(
    'tsconfig-strict-flags',
    'tsconfig 严格开关全部为 true',
    offFlags.length === 0,
    offFlags.length > 0 ? `被关掉或缺失：${offFlags.join(', ')}` : REQUIRED_TSCONFIG_FLAGS.join(', ')
  );

  // 4) gate 本身没被改成空壳
  const pkg = readJson('package.json');
  const scripts = pkg.scripts || {};
  const missingScripts = REQUIRED_SCRIPTS.filter((s) => !scripts[s]);
  const gateSh = fs.existsSync(path.join(root, 'scripts/gate.sh'))
    ? fs.readFileSync(path.join(root, 'scripts/gate.sh'), 'utf8')
    : '';
  const missingSteps = REQUIRED_GATE_STEPS.filter((s) => !gateSh.includes(s));
  add(
    'gate-scripts-intact',
    'gate 脚本与 npm scripts 完整',
    missingScripts.length === 0 && missingSteps.length === 0,
    [missingScripts.length ? `缺 script：${missingScripts.join(', ')}` : '', missingSteps.length ? `gate.sh 缺步骤：${missingSteps.join(', ')}` : '']
      .filter(Boolean)
      .join('; ') || 'ok'
  );

  // 5) 抑制标记不许增加（@ts-ignore 是让报错消失的最短路径）
  const suppressions = [];
  for (const file of listSourceFiles(root)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (SUPPRESSION_RE.test(line)) {
        suppressions.push(path.relative(root, file));
      }
    }
  }
  add(
    'suppressions-within-budget',
    `源码里的抑制标记数 <= ${MAX_SUPPRESSIONS}`,
    suppressions.length <= MAX_SUPPRESSIONS,
    suppressions.length > 0 ? `出现在：${suppressions.join(', ')}（要抑制必须写 ADR，不要就地加标记）` : 'ok'
  );

  // 6) baseline 结构合法，且没有"幽灵指标"（规则删了、指标还在）
  const baseline = fs.existsSync(path.join(root, BASELINE_PATH)) ? readJson(BASELINE_PATH) : null;
  const shapeProblems = [];
  if (!baseline) {
    shapeProblems.push('baseline 文件不存在');
  } else {
    if (!Number.isInteger(baseline.version)) {
      shapeProblems.push('version 不是整数');
    }
    for (const [key, value] of Object.entries(baseline.metrics || {})) {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        shapeProblems.push(`metrics.${key} 不是数字`);
      }
      if (key.startsWith('astgrep:') && !ruleIds.has(key.slice('astgrep:'.length))) {
        shapeProblems.push(`幽灵指标 ${key}：对应 ast-grep 规则已不存在`);
      }
      if (key.startsWith('depcruise:') && !depNames.has(key.slice('depcruise:'.length))) {
        shapeProblems.push(`幽灵指标 ${key}：对应 depcruise 规则已不存在`);
      }
    }
    if (!baseline.frozen || typeof baseline.frozen !== 'object') {
      shapeProblems.push('frozen 不是对象');
    }
  }
  add('baseline-shape', 'baseline 结构合法且无幽灵指标', shapeProblems.length === 0, shapeProblems.join('; ') || 'ok');

  // 7) 架构文档还在，且否命题没有变少
  const invariants = parseInvariants(root);
  add(
    'architecture-doc-present',
    `${ARCH_DOC} 里的否命题数 >= ${MIN_INVARIANTS}`,
    invariants.length >= MIN_INVARIANTS,
    `当前 ${invariants.length} 条`
  );

  // 8) 声明的设置项必须真的被代码读取。
  //    声明了却没人实现 = 假承诺：用户设了不会有任何反应（本项目刚清理掉 5 个这种设置）。
  // ⚠ 要读的是扩展的 package.json，不是仓库根的（根那份没有 contributes）
  const extPkg = readJson('vscode-extension/package.json');
  const settings = Object.keys(extPkg.contributes?.configuration?.properties || {});
  const srcText = listSourceFiles(root)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  const unreadSettings = settings.filter((key) => {
    const short = key.replace(/^jpReader\./, '');
    return !new RegExp(`get(?:<[^>]*>)?\\(\\s*'${short}'`).test(srcText);
  });
  add(
    'declared-settings-are-read',
    '扩展 package.json 里声明的设置项都必须被代码读取',
    settings.length > 0 && unreadSettings.length === 0,
    unreadSettings.length > 0
      ? unreadSettings.length > 0
        ? `没有任何代码读取：${unreadSettings.join(', ')}（要么实现它，要么删掉声明）`
        : '没有解析到任何设置项声明 —— 说明这个检查自己坏了，不能算通过'
      : `当前 ${settings.length} 项都被读取`
  );

  // 8) 构建产物不许进版本库
  const gitignore = fs.existsSync(path.join(root, '.gitignore'))
    ? fs.readFileSync(path.join(root, '.gitignore'), 'utf8')
    : '';
  const missingIgnores = ['node_modules', '.reports'].filter((p) => !gitignore.includes(p));
  add(
    'gitignore-covers-artifacts',
    '.gitignore 覆盖构建/报告产物',
    missingIgnores.length === 0,
    missingIgnores.length > 0 ? `缺：${missingIgnores.join(', ')}` : 'ok'
  );

  const failed = checks.filter((c) => !c.ok);
  checks.push({
    id: 'guardrails-config-not-weakened',
    title: '（汇总）护栏配置未被削弱',
    ok: failed.length === 0,
    detail: failed.length === 0 ? `全部 ${checks.length - 1} 项通过` : `${failed.length} 项失败：${failed.map((c) => c.id).join(', ')}`,
  });
  return checks;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const checks = runChecks();
  console.log('护栏配置完整性检查');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(34)} ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log(`\n有 ${failed.length} 项护栏被削弱了。这不是代码问题，是"规则被改松了"——`);
    console.log('要么改回去，要么先写 ADR（docs/adr/）说明为什么这个决定变了。');
    process.exit(1);
  }
  console.log('\n护栏配置：通过');
}
