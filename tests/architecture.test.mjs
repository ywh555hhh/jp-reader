#!/usr/bin/env node
/**
 * 语义否命题的断言层。
 *
 * 和 scripts/ratchet.mjs 的分工：
 *   - ratchet：跑外部工具（tsc / knip / depcruise / ast-grep / jscpd），比较工具产出的计数
 *   - 本文件：不跑工具，只断言"从仓库本身量出来的语义指标"没有超过 baseline，
 *             以及"文档 / 规则 / 指标三者是否自洽"
 *
 * 两者共用 baseline/guardrails-baseline.json，所以同一条约束不需要在两边各写一遍。
 * 运行：node --test tests/architecture.test.mjs   （npm run test:arch）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT,
  BASELINE_PATH,
  ARCH_DOC,
  MAX_SOURCE_FILE_LINES,
  astgrepRuleIds,
  collectAllSemanticMetrics,
  countLines,
  depcruiseRuleNames,
  describeMetric,
  guardCheckIds,
  isViolationMetric,
  listSourceFiles,
  parseInvariants,
  resolveEnforcer,
} from './architecture.metrics.mjs';

const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, BASELINE_PATH), 'utf8'));
const checkIds = guardCheckIds(ROOT);
const semantic = collectAllSemanticMetrics(ROOT, baseline, { checkIds });

test('语义指标不得超过 baseline（只降不升）', () => {
  const failures = [];
  for (const [key, now] of Object.entries(semantic)) {
    const was = baseline.metrics[key];
    if (was === undefined) {
      failures.push(`${key} = ${now} 未登记进 baseline.metrics`);
      continue;
    }
    if (now > was) {
      failures.push(`${key}: 基线 ${was} → 现在 ${now}\n      ${describeMetric(key, ROOT) || '（无说明）'}`);
    }
  }
  assert.deepEqual(
    failures,
    [],
    `以下语义指标变差了：\n  - ${failures.join('\n  - ')}\n` +
      '要么把代码改回去，要么按 docs/architecture.md 的流程正式上调 baseline（并在 PR 里说明理由）。'
  );
});

test('非零的"违规计数"必须挂 issue（baseline.frozen 是唯一的申请通道）', () => {
  const missing = [];
  for (const [key, value] of Object.entries(baseline.metrics)) {
    if (!isViolationMetric(key) || !(Number(value) > 0)) {
      continue;
    }
    const entry = baseline.frozen[key];
    if (!entry || !Number.isInteger(entry.issue)) {
      missing.push(key);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `以下违规计数非零但没挂 issue：${missing.join(', ')}\n` +
      '先建 issue，再往 baseline.frozen 里加 { issue, reason, unfreeze_when }。'
  );
});

test('每个 frozen 条目都必须写清 reason 与 unfreeze_when', () => {
  const incomplete = [];
  for (const [key, entry] of Object.entries(baseline.frozen || {})) {
    if (!entry || typeof entry.reason !== 'string' || entry.reason.length < 10) {
      incomplete.push(`${key}: 缺 reason`);
    }
    if (!entry || typeof entry.unfreeze_when !== 'string' || entry.unfreeze_when.length < 10) {
      incomplete.push(`${key}: 缺 unfreeze_when`);
    }
    if (!Number.isInteger(entry.issue)) {
      incomplete.push(`${key}: 缺 issue`);
    }
  }
  assert.deepEqual(incomplete, [], `以下 frozen 条目信息不全：\n  - ${incomplete.join('\n  - ')}`);
});

test(`docs/architecture.md 里的每条否命题都指向真实存在的执法者`, () => {
  const invariants = parseInvariants(ROOT);
  assert.ok(
    invariants.length > 0,
    `没有从 ${ARCH_DOC} 解析到任何否命题。表格必须是 | ID | 否命题 | 为什么 | 执法者 | 四列。`
  );
  const ctx = {
    astgrep: astgrepRuleIds(ROOT),
    depcruise: depcruiseRuleNames(ROOT),
    metricKeys: baseline.metrics,
    checks: checkIds,
  };
  const broken = [];
  for (const inv of invariants) {
    const res = resolveEnforcer(inv.enforcer, ctx);
    if (!res.ok) {
      broken.push(`${inv.id}（${inv.rule}）→ ${inv.enforcer}：${res.reason}`);
    }
  }
  assert.deepEqual(
    broken,
    [],
    `以下否命题没有可执行的执法者：\n  - ${broken.join('\n  - ')}\n` +
      '不允许存在"写在文档里但没有人检查"的约束——那种约束三个月后必然失效。'
  );
});

test(`没有源文件超过 ${MAX_SOURCE_FILE_LINES} 行`, () => {
  const offenders = [];
  for (const file of listSourceFiles(ROOT)) {
    const count = countLines(fs.readFileSync(file, 'utf8'));
    if (count > MAX_SOURCE_FILE_LINES) {
      offenders.push(`${path.relative(ROOT, file)}: ${count} 行`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下文件超长，请拆模块而不是调大 MAX_SOURCE_FILE_LINES：\n  - ${offenders.join('\n  - ')}`
  );
});

test('类型检查与死代码必须归零', () => {
  assert.equal(baseline.metrics.typecheck_errors, 0, 'typecheck_errors 必须为 0');
  assert.equal(baseline.metrics.knip_issues, 0, 'knip_issues 必须为 0');
});

/*
 * 以下是"运行期"才暴露的问题，静态规则查不出来。
 * #1（词条主键唯一性）已修 → tests/collection.test.mjs
 * #5（阅读视图用真实 offset 定位）已修 → tests/readingSource.test.mjs
 * 新增运行期断言时请开新文件（tests/*.test.mjs 都会被 npm run test:unit 跑到），
 * 不要把断言塞回这个文件：这里只做"从仓库本身量出来的语义指标"。
 */
