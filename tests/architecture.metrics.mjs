/**
 * 语义否命题的「计数层」。
 *
 * 这里只把仓库现状量成一组数字，不做断言。断言在 tests/architecture.test.mjs
 * （不得超过 baseline），棘轮在 scripts/ratchet.mjs（只降不升）。
 * 两侧共用同一份 baseline/guardrails-baseline.json —— 所以每条规则只写一次。
 *
 * 新增一条否命题的流程：
 *   1. 在 docs/architecture.md 的表格里加一行，执法者写 `metric:<新 key>`
 *   2. 在这里把 <新 key> 算出来（或由 scripts/ratchet.mjs 的工具收集器产出）
 *   3. npm run gate:update-baseline   （然后 npm run gate 必须为绿）
 *   4. 若新 key 的当前值 > 0，必须同时往 baseline.frozen 里加 issue 编号和理由
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

export const SRC_DIR = 'vscode-extension/src';
export const ARCH_DOC = 'docs/architecture.md';
export const BASELINE_PATH = 'baseline/guardrails-baseline.json';
export const ASTRGREP_RULE_DIR = 'rules/ast-grep-rules/rules';
export const DEPCRUISE_CONFIG = '.dependency-cruiser.cjs';

/** A15：单个源文件的行数硬上限。超过就该拆模块，而不是调大这个数。 */
export const MAX_SOURCE_FILE_LINES = 500;

/**
 * A19：模块变胖的预警线。
 *
 * 这里用「超过阈值的文件数」而不是「总行数 / 最大文件行数」，是故意的：
 * 后两者在任何一次正常加代码时都会上升，于是每次 PR 都得跑一次 update-baseline——
 * 那等于把棘轮变成背景噪音，所有人（包括 agent）会养成「红了就 update」的习惯。
 * 阈值计数只会在跨越边界时变化，因此既稳定又真的在守边界。
 */
export const SOFT_FILE_LINES = 350;

/**
 * A11：一个能力只允许一处实现。
 * 登记「能力 → 该能力的 URL 特征」；同一特征出现在第 2 个文件里就算多一份实现。
 */
export const CAPABILITY_URL_MARKERS = [
  { capability: 'translate', marker: 'translate.googleapis.com' },
  { capability: 'tts', marker: 'translate.google.com/translate_tts' },
  { capability: 'explain', marker: 'api.openai.com' },
];

/** A9：裸写文件的调用形态（必须集中在唯一一个模块里） */
export const RAW_WRITE_RE = /\b(writeFileSync|appendFileSync|createWriteStream|writeFile)\s*\(/;

/** A10：模块级可变状态 */
export const MODULE_LEVEL_STATE_RE = /^(export\s+)?(let|var)\s/;

/** 每个 metric 的含义，用于失败时打印人话 */
export const METRIC_MEANING = {
  files_with_raw_writes: '允许裸写文件的模块数（应恒为 1，且必须是唯一的数据落盘层）',
  files_with_module_level_state: '含模块级 let/var 的文件数（可变单例应当收敛到唯一一个上下文对象）',
  capability_url_extra_copies: '同一能力被第 2 份及以后实现占用的次数（每个 >0 都是重复实现）',
  source_files_over_500_lines: '超过 500 行的源文件数（硬上限，必须为 0）',
  files_over_350_lines: '超过 350 行的源文件数（模块变胖的预警线，只降不升）',
  frozen_metrics_without_issue: '非零但没有挂 issue 的指标数（必须为 0）',
  invariants_without_enforcer: '文档里没有可执行执法者的否命题数（必须为 0）',
  typecheck_errors: 'TypeScript 类型检查错误数（必须为 0）',
  knip_issues: '死代码/未用依赖类问题数（未使用文件、导出、依赖）',
  jscpd_clones: '重复代码块数量',
  jscpd_duplicated_lines: '重复代码行数（只降不升）',
  astgrep_rule_test_failures: 'ast-grep 规则自身的测试失败数（规则改坏了却没人发现的地方，必须为 0）',
};

/**
 * 「违规计数」类的指标：语义就是「有多少处违规」，所以非零必须挂 issue。
 * 其余指标是「预算」类（体积、重复行数），只要求只降不升，允许非零。
 * 这条判定靠命名约定，不靠配置文件——否则把 key 从列表里删掉就能绕过去。
 */
export function isViolationMetric(key) {
  return (
    /^(depcruise|astgrep):/.test(key) ||
    key === 'knip_issues' ||
    key === 'typecheck_errors' ||
    key === 'astgrep_rule_test_failures'
  );
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(p));
    } else if (/\.ya?ml$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 把指标 key 翻译成人话；depcruise / ast-grep 规则里已经有 message/comment，直接复用 */
export function describeMetric(key, root = ROOT) {
  if (METRIC_MEANING[key]) {
    return METRIC_MEANING[key];
  }
  const bare = key.split(':').pop();
  if (METRIC_MEANING[bare]) {
    return METRIC_MEANING[bare];
  }
  if (key.startsWith('astgrep:')) {
    const id = key.slice('astgrep:'.length);
    for (const file of walkFiles(path.join(root, ASTRGREP_RULE_DIR))) {
      const text = fs.readFileSync(file, 'utf8');
      if (new RegExp(`^id:\\s*${id}\\s*$`, 'm').test(text)) {
        const msg = text.match(/^message:\s*(.+)$/m);
        return msg
          ? `${msg[1].replace(/^['"]|['"]$/g, '')}  (${path.relative(root, file)})`
          : `ast-grep 规则 ${id}`;
      }
    }
  }
  if (key.startsWith('depcruise:')) {
    const name = key.slice('depcruise:'.length);
    const file = path.join(root, DEPCRUISE_CONFIG);
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      const at = text.indexOf(`name: '${name}'`);
      if (at >= 0) {
        const comment = text.slice(at).match(/comment:\s*\n?\s*'([^']*)'/);
        if (comment) {
          return comment[1].trim();
        }
      }
    }
  }
  return null;
}

/** 精确行数：不把文件末尾的换行算成一行 */
export function countLines(text) {
  if (text === '') {
    return 0;
  }
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

export function listSourceFiles(root = ROOT) {
  const dir = path.join(root, SRC_DIR);
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => path.join(dir, f));
}

/** 量出所有「不需要跑外部工具」的语义指标 */
export function collectSemanticMetrics(root = ROOT) {
  const files = listSourceFiles(root);
  const metrics = {};
  let rawWriteFiles = 0;
  let stateFiles = 0;
  let overHardLimit = 0;
  let overSoftLimit = 0;
  const capabilityFiles = new Map();

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const lineCount = countLines(text);
    if (lineCount > MAX_SOURCE_FILE_LINES) {
      overHardLimit += 1;
    }
    if (lineCount > SOFT_FILE_LINES) {
      overSoftLimit += 1;
    }
    if (RAW_WRITE_RE.test(text)) {
      rawWriteFiles += 1;
    }
    if (text.split('\n').some((line) => MODULE_LEVEL_STATE_RE.test(line))) {
      stateFiles += 1;
    }
    for (const { capability, marker } of CAPABILITY_URL_MARKERS) {
      if (text.includes(marker)) {
        capabilityFiles.set(capability, (capabilityFiles.get(capability) || 0) + 1);
      }
    }
  }

  let extraCopies = 0;
  for (const count of capabilityFiles.values()) {
    extraCopies += Math.max(0, count - 1);
  }

  metrics.files_with_raw_writes = rawWriteFiles;
  metrics.files_with_module_level_state = stateFiles;
  metrics.capability_url_extra_copies = extraCopies;
  metrics.source_files_over_500_lines = overHardLimit;
  metrics.files_over_350_lines = overSoftLimit;
  return metrics;
}

/** 文档里的否命题表：| ID | 否命题（禁止式）| 为什么 | 执法者 | */
export function parseInvariants(root = ROOT) {
  const file = path.join(root, ARCH_DOC);
  if (!fs.existsSync(file)) {
    return [];
  }
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\|\s*(A\d+)\s*\|([^|]+)\|([^|]*)\|\s*`?([^`|]+)`?\s*\|\s*$/);
    if (m) {
      rows.push({ id: m[1].trim(), rule: m[2].trim(), why: m[3].trim(), enforcer: m[4].trim() });
    }
  }
  return rows;
}

export function astgrepRuleIds(root = ROOT) {
  const dir = path.join(root, ASTRGREP_RULE_DIR);
  const ids = new Set();
  const walk = (d) => {
    if (!fs.existsSync(d)) {
      return;
    }
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(p);
      } else if (/\.ya?ml$/.test(entry.name)) {
        const m = fs.readFileSync(p, 'utf8').match(/^id:\s*(\S+)/m);
        if (m) {
          ids.add(m[1]);
        }
      }
    }
  };
  walk(dir);
  return ids;
}

export function depcruiseRuleNames(root = ROOT) {
  const file = path.join(root, DEPCRUISE_CONFIG);
  if (!fs.existsSync(file)) {
    return new Set();
  }
  const text = fs.readFileSync(file, 'utf8');
  return new Set([...text.matchAll(/\bname:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]));
}

export function guardCheckIds(root = ROOT) {
  const file = path.join(root, 'scripts/guard-rules.mjs');
  if (!fs.existsSync(file)) {
    return new Set();
  }
  return new Set(
    [...fs.readFileSync(file, 'utf8').matchAll(/id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1])
  );
}

/** 执法者 token 只有 4 种前缀，每一种都必须能被机械解析到真实存在的东西 */
export function resolveEnforcer(token, ctx) {
  const idx = token.indexOf(':');
  if (idx <= 0) {
    return { ok: false, reason: `不是合法的执法者 token（应为 astgrep:/depcruise:/metric:/check:），收到 "${token}"` };
  }
  const kind = token.slice(0, idx);
  const name = token.slice(idx + 1).trim();
  const knownMetric = (key) =>
    ctx.metricKeys instanceof Set
      ? ctx.metricKeys.has(key)
      : Object.prototype.hasOwnProperty.call(ctx.metricKeys, key);
  switch (kind) {
    case 'astgrep':
      return ctx.astgrep.has(name)
        ? { ok: true }
        : { ok: false, reason: `rules/ast-grep-rules/rules/ 下没有 id 为 "${name}" 的规则` };
    case 'depcruise':
      return ctx.depcruise.has(name)
        ? { ok: true }
        : { ok: false, reason: `.dependency-cruiser.cjs 里没有名为 "${name}" 的 forbidden 规则` };
    case 'metric':
      return knownMetric(name)
        ? { ok: true }
        : { ok: false, reason: `baseline.metrics 里没有登记指标 "${name}"（先让收集器产出它，再跑 gate:update-baseline）` };
    case 'check':
      return ctx.checks.has(name)
        ? { ok: true }
        : { ok: false, reason: `scripts/guard-rules.mjs 里没有 id 为 "${name}" 的检查` };
    default:
      return { ok: false, reason: `未知的执法者前缀 "${kind}"` };
  }
}

/**
 * 元指标：这两条是在检查"护栏本身是否自洽"，与业务代码无关。
 * 它们在 ratchet 和 arch test 里都能算出来（只需要 baseline + 文档），所以两边数字一致。
 */
export function collectMetaMetrics(root = ROOT, baseline = null, opts = {}) {
  const bl = baseline || JSON.parse(fs.readFileSync(path.join(root, BASELINE_PATH), 'utf8'));
  const metricKeys = opts.metricKeys || bl.metrics || {};
  const frozen = bl.frozen || {};

  let withoutIssue = 0;
  for (const [key, value] of Object.entries(metricKeys)) {
    if (!(Number(value) > 0)) {
      continue;
    }
    const entry = frozen[key];
    if (!entry || !Number.isInteger(entry.issue)) {
      withoutIssue += 1;
    }
  }

  const ctx = {
    astgrep: astgrepRuleIds(root),
    depcruise: depcruiseRuleNames(root),
    metricKeys,
    checks: opts.checkIds || guardCheckIds(root),
  };
  let withoutEnforcer = 0;
  for (const inv of parseInvariants(root)) {
    const res = resolveEnforcer(inv.enforcer, ctx);
    if (!res.ok) {
      withoutEnforcer += 1;
    }
  }

  return {
    frozen_metrics_without_issue: withoutIssue,
    invariants_without_enforcer: withoutEnforcer,
  };
}

/** 供 ratchet / test 共用的完整语义指标 */
export function collectAllSemanticMetrics(root = ROOT, baseline = null, opts = {}) {
  const bl = baseline || JSON.parse(fs.readFileSync(path.join(root, BASELINE_PATH), 'utf8'));
  const semantic = collectSemanticMetrics(root);
  // 指称注册表 = 已登记的指标 ∪ 本次量出来的指标 ∪ 两个元指标自身。
  // 必须先算出来再解析执法者，否则“新增一条否命题”会需要跑两次 update。
  const metricKeys = new Set([
    ...Object.keys(bl.metrics || {}),
    ...Object.keys(semantic),
    'frozen_metrics_without_issue',
    'invariants_without_enforcer',
  ]);
  const meta = collectMetaMetrics(root, bl, { checkIds: opts.checkIds, metricKeys });
  return { ...semantic, ...meta };
}
