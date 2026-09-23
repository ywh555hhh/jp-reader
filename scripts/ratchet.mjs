#!/usr/bin/env node
/**
 * 架构指标棘轮（ratchet）。
 *
 * 作用：所有"坏东西的数量"只允许下降，不允许上升。
 *   - 上升            → exit 1，并要求修代码；不接受"我这次特殊"
 *   - 非零且没挂 issue → exit 1（见 baseline.frozen；这是唯一的申请通道）
 *   - 指标集合漂移     → exit 2，要求显式登记
 *
 * 用法：
 *   node scripts/ratchet.mjs              校验（npm run gate 会调用）
 *   node scripts/ratchet.mjs --update     接受当前值（必须在 PR 里写清理由）
 *   node scripts/ratchet.mjs --no-tools   只算语义指标，跳过需要外部工具的收集器
 *
 * 设计要点：任何一步失败都不打印"操作建议"，只打印**事实和目标文件**——
 * 报告是给下一个 agent 看的，模糊的鼓励没有信息量。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  BASELINE_PATH,
  collectMetaMetrics,
  collectSemanticMetrics,
  describeMetric,
  guardCheckIds,
  isViolationMetric,
} from '../tests/architecture.metrics.mjs';

const UPDATE = process.argv.includes('--update');
const NO_TOOLS = process.argv.includes('--no-tools');
const baselineFile = path.join(ROOT, BASELINE_PATH);

function loadBaseline() {
  if (!fs.existsSync(baselineFile)) {
    return { version: 1, note: '由 `npm run gate:update-baseline` 生成。', metrics: {}, frozen: {} };
  }
  return JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
}

function run(bin, args, opts = {}) {
  return execFileSync(bin, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 128 * 1024 * 1024,
    ...opts,
  });
}

const local = (p) => path.join(ROOT, p);
const exists = (p) => fs.existsSync(local(p));

function skippedCollector(reason) {
  return { metrics: {}, skipped: reason, detail: [] };
}

/**
 * 收集器“装上了但跑不出结果”必须当作硬失败，不能静默跳过。
 * 踩过的坑：depcruise 因为 tsConfig 的路径解析问题返回 TS18003，
 * 输出解析不了 → 被当成 SKIP → 两条违规规则“看着有人管”实则无人查。
 */
const broken = [];
function brokenCollector(name, reason, hint) {
  broken.push(`${name}: ${reason}${hint ? `\n    ${hint.trim().split('\n').slice(0, 3).join('\n    ')}` : ''}`);
  return { metrics: {}, detail: [] };
}

/* ------------------------------------------------------------------ */
/* 收集器：每个收集器返回 { metrics, detail, skipped? }                */
/* ------------------------------------------------------------------ */

function collectTypecheck() {
  const bin = local('vscode-extension/node_modules/.bin/tsc');
  if (!exists('vscode-extension/node_modules/.bin/tsc')) {
    return skippedCollector('vscode-extension/node_modules 未安装（npm --prefix vscode-extension ci）');
  }
  let out = '';
  try {
    out = run(bin, ['-p', 'vscode-extension', '--noEmit']);
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));
  return {
    metrics: { typecheck_errors: errors.length },
    detail: errors.map((l) => `tsc: ${l.trim()}`),
  };
}

function collectKnip() {
  if (!exists('vscode-extension/node_modules/.bin/knip')) {
    return skippedCollector('knip 未安装（在 vscode-extension 下 npm install）');
  }
  let raw = '';
  try {
    raw = run(local('vscode-extension/node_modules/.bin/knip'), ['--no-progress', '--reporter', 'json'], {
      cwd: local('vscode-extension'),
    });
  } catch (err) {
    // knip 发现问题时以非零码退出，但 JSON 仍然完整地写在 stdout
    raw = `${err.stdout || ''}${err.stderr || ''}`;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return brokenCollector('collectKnip', 'knip --reporter json 输出无法解析（升级 knip 后请检查 reporters）', raw.slice(0, 400));
  }
  let total = 0;
  const detail = [];
  for (const issueFile of parsed.issues || []) {
    for (const [key, value] of Object.entries(issueFile)) {
      if (key === 'file' || !Array.isArray(value) || value.length === 0) {
        continue;
      }
      total += value.length;
      for (const item of value) {
        detail.push(`knip[${key}]: ${issueFile.file} ${typeof item === 'object' ? JSON.stringify(item) : item}`);
      }
    }
  }
  return { metrics: { knip_issues: total }, detail };
}

function collectDepcruise() {
  if (!exists('node_modules/.bin/depcruise')) {
    return skippedCollector('dependency-cruiser 未安装（仓库根目录 npm ci）');
  }
  let raw = '';
  let stderr = '';
  try {
    raw = run(local('node_modules/.bin/depcruise'), [
      'vscode-extension/src/**/*.ts',
      '--output-type',
      'json',
    ]);
  } catch (err) {
    // 有违规时 depcruise 以非零码退出，但 JSON 仍然写在 stdout
    raw = `${err.stdout || ''}`;
    stderr = `${err.stderr || ''}`;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return brokenCollector('collectDepcruise', 'depcruise 输出无法解析', stderr || raw.slice(0, 400));
  }
  const metrics = {};
  const detail = [];
  for (const v of parsed.summary?.violations || []) {
    const key = `depcruise:${v.rule.name}`;
    metrics[key] = (metrics[key] || 0) + 1;
    detail.push(`depcruise[${v.rule.name}]: ${v.from} -> ${v.to}`);
  }
  for (const rule of ['domain-purity', 'single-http-entry', 'no-circular', 'no-orphan-module']) {
    if (!(`depcruise:${rule}` in metrics)) {
      metrics[`depcruise:${rule}`] = 0;
    }
  }
  return { metrics, detail };
}

function collectAstgrep() {  if (!exists('node_modules/.bin/ast-grep')) {
    return skippedCollector('@ast-grep/cli 未安装（仓库根目录 npm ci）');
  }
  let raw = '';
  try {
    raw = run(local('node_modules/.bin/ast-grep'), ['scan', '--json=compact']);
  } catch (err) {
    raw = `${err.stdout || ''}${err.stderr || ''}`;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return brokenCollector('collectAstgrep', 'ast-grep 输出无法解析（确认 sgconfig.yml 与规则 YAML 语法）', raw.slice(0, 400));
  }
  const metrics = {};
  const detail = [];
  for (const hit of parsed) {
    const key = `astgrep:${hit.ruleId}`;
    metrics[key] = (metrics[key] || 0) + 1;
    detail.push(`astgrep[${hit.ruleId}]: ${hit.file}:${hit.range.start.line + 1} ${hit.text.split('\n')[0]}`);
  }
  for (const id of ['jp-no-ruleid-switch', 'jp-no-indexof-position-lookup', 'jp-no-date-as-identity', 'jp-no-empty-catch']) {
    if (!(`astgrep:${id}` in metrics)) {
      metrics[`astgrep:${id}`] = 0;
    }
  }
  return { metrics, detail };
}

/**
 * 规则自身的测试：valid 里的写法必须不命中，invalid 里的必须命中。
 * 没有这一层，收紧或放宽一条规则就是在无人察觉的情况下改约束（否命题 A14）。
 */
function collectAstgrepRuleTests() {
  if (!exists('node_modules/.bin/ast-grep')) {
    return skippedCollector('@ast-grep/cli 未安装（仓库根目录 npm ci）');
  }
  let out = '';
  try {
    out = run(local('node_modules/.bin/ast-grep'), ['test', '--skip-snapshot-tests']);
  } catch (err) {
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const matched = out.match(/;\s*(\d+) failed/);
  const failed = matched ? Number(matched[1]) : /FAIL|Error:/.test(out) ? 1 : 0;
  return {
    metrics: { astgrep_rule_test_failures: failed },
    detail: failed
      ? [`ast-grep test: ${out.split('\n').filter((l) => /FAIL|Error|Wrong/i.test(l))[0] || '规则测试失败'}`]
      : [],
  };
}

function collectJscpd() {
  if (!exists('node_modules/.bin/jscpd')) {
    return skippedCollector('jscpd 未安装（仓库根目录 npm ci）');
  }
  const report = local('.reports/jscpd/jscpd-report.json');
  try {
    run(local('node_modules/.bin/jscpd'), ['--config', 'jscpd.json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    /* jscpd 在超过阈值时非零退出，报告仍然会写出来 */
  }
  if (!fs.existsSync(report)) {
    return brokenCollector('collectJscpd', 'jscpd 没有产出报告（检查 jscpd.json 的 output 字段）');
  }
  const parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
  const total = parsed.statistics?.total || {};
  const detail = (parsed.duplicates || []).map(
    (d) =>
      `jscpd: ${d.firstFile.name}:${d.firstFile.start} ↔ ${d.secondFile.name}:${d.secondFile.start} (${d.lines} 行)`
  );
  return {
    metrics: {
      jscpd_clones: Number(total.clones || 0),
      jscpd_duplicated_lines: Number(total.duplicatedLines || 0),
    },
    detail,
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

const baseline = loadBaseline();
const collectors = NO_TOOLS
  ? []
  : [collectTypecheck, collectKnip, collectDepcruise, collectAstgrep, collectAstgrepRuleTests, collectJscpd];

const current = {};
const details = [];
const skipped = [];
for (const collector of collectors) {
  let result;
  try {
    result = collector();
  } catch (err) {
    result = brokenCollector(collector.name, `收集器抛错：${err.message}`, err.stdout || err.stderr || '');
  }
  if (result.skipped) {
    skipped.push(`${collector.name}: ${result.skipped}`);
    continue;
  }
  Object.assign(current, result.metrics);
  details.push(...result.detail);
}

// 隐式指标必须在所有工具指标都收完之后再算——否则"新增一条否命题"会需要跑两次 update。
// 指称注册表 = 已登记的指标 ∪ 本次量出来的全部指标 ∪ 两个元指标自身。
const semantic = collectSemanticMetrics(ROOT);
const metricKeys = new Set([
  ...Object.keys(baseline.metrics || {}),
  ...Object.keys(current),
  ...Object.keys(semantic),
  'frozen_metrics_without_issue',
  'invariants_without_enforcer',
]);
Object.assign(
  current,
  semantic,
  collectMetaMetrics(ROOT, baseline, { checkIds: guardCheckIds(ROOT), metricKeys })
);

/* 指标集合漂移检测：baseline.metrics 是唯一的指标登记处 */
const registered = Object.keys(baseline.metrics || {});
const computed = Object.keys(current);
const unregistered = computed.filter((k) => !registered.includes(k));
const stale = registered.filter((k) => !computed.includes(k) && !NO_TOOLS);

if (UPDATE) {
  const next = {
    version: baseline.version || 1,
    note:
      '由 `npm run gate:update-baseline` 生成。metrics 里的每个数字都是"当前允许的最大值"，' +
      '只允许下降；要上调必须在 PR 里说明理由。frozen 里的 issue 编号是允许该指标非零的唯一依据。',
    metrics: Object.fromEntries(Object.entries(current).sort(([a], [b]) => a.localeCompare(b))),
    frozen: baseline.frozen || {},
  };
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  console.log(`已更新 ${BASELINE_PATH}（${Object.keys(next.metrics).length} 个指标）`);
  process.exit(0);
}

const rows = [];
let grew = 0;
let unknown = 0;
for (const key of Object.keys(current).sort()) {
  const now = current[key];
  const was = registered.includes(key) ? baseline.metrics[key] : undefined;
  let status = 'ok';
  if (was === undefined) {
    status = key in baseline.metrics ? 'ok' : 'UNREGISTERED';
    unknown += status === 'UNREGISTERED' ? 1 : 0;
  } else if (now > was) {
    status = 'GREW';
    grew += 1;
  } else if (now < was) {
    status = 'shrank';
  }
  rows.push({ key, was: was === undefined ? '-' : was, now, status });
}

const pad = (s, n) => String(s).padEnd(n);
console.log('指标棘轮（只降不升）');
console.log(`${pad('指标', 44)}${pad('基线', 6)}${pad('当前', 6)}状态`);
for (const r of rows) {
  console.log(`${pad(r.key, 44)}${pad(r.was, 6)}${pad(r.now, 6)}${r.status}`);
}
if (skipped.length > 0) {
  console.log('\n跳过（工具未安装；CI 必须全部装上，否则等于没检查）：');
  for (const s of skipped) {
    console.log(`  SKIP ${s}`);
  }
}

if (broken.length > 0) {
  console.log('\n收集器异常（工具装着但跑不出结果——这属于护栏故障，不是"跳过"）：');
  for (const b of broken) {
    console.log(`  BROKEN ${b}`);
  }
  console.log('修好收集器之前，这些指标处于无人看守状态。')
}

const missingIssue = [];
for (const [key, value] of Object.entries(baseline.metrics || {})) {
  if (!(Number(value) > 0) || NO_TOOLS || !isViolationMetric(key)) {
    continue;
  }
  const entry = (baseline.frozen || {})[key];
  if (!entry || !Number.isInteger(entry.issue)) {
    missingIssue.push(key);
  }
}

if (unregistered.length > 0) {
  console.log(`\n有 ${unregistered.length} 个指标没有登记进 baseline：`);
  for (const key of unregistered) {
    console.log(`  ${key} = ${current[key]}   ${describeMetric(key, ROOT) || ''}`);
  }
  console.log('\n处理方式（二选一）：');
  console.log('  1) 把它修到 0，然后运行：npm run gate:update-baseline');
  console.log('  2) 确实修不了：先建 issue，再在 baseline.frozen 里加 { issue, reason, unfreeze_when }，');
  console.log('     然后运行：npm run gate:update-baseline');
}

if (grew > 0) {
  console.log(`\n有 ${grew} 个指标比基线更差：`);
  for (const r of rows.filter((x) => x.status === 'GREW')) {
    console.log(`  ${r.key}: ${r.was} -> ${r.now}`);
    console.log(`    含义：${describeMetric(r.key, ROOT) || '（未登记含义）'}`);
  }
  if (details.length > 0) {
    console.log('\n原始明细（只显示前 40 条）：');
    for (const d of details.slice(0, 40)) {
      console.log(`  ${d}`);
    }
  }
  console.log('\n这不是"可以商量的警告"：把数量改回基线以内，或按上面的流程正式上调基线。');
}

if (missingIssue.length > 0) {
  console.log(`\n有 ${missingIssue.length} 个非零指标没有挂 issue：`);
  for (const key of missingIssue) {
    console.log(`  ${key} = ${baseline.metrics[key]}`);
  }
  console.log('非零的违规必须在 baseline.frozen 里写 { issue, reason, unfreeze_when }，否则就是无主债务。');
}

if (stale.length > 0) {
  console.log(`\n有 ${stale.length} 个基线指标已经算不出来了（收集器改名或规则被删）：`);
  for (const key of stale) {
    console.log(`  ${key}`);
  }
  console.log('删规则必须同步删基线指标，否则棘轮会保护一个已经不存在的约束。');
}

const exitCode =
  grew > 0 || missingIssue.length > 0 || broken.length > 0
    ? 1
    : unregistered.length > 0 || stale.length > 0
      ? 2
      : 0;
if (exitCode === 0) {
  console.log('\n棘轮：通过');
}
process.exit(exitCode);
