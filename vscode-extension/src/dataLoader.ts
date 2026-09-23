import * as path from 'path';
import { HighlightStyle } from './highlightStyle';
import * as fs from 'fs';

/**
 * JP Reader 数据类型与数据加载。
 *
 * ⚠ 本模块**不依赖 vscode**（否命题 A1，depcruise:domain-purity）。
 * 它只认磁盘上的文件，不读配置、不弹提示、不写状态栏：
 *   · 配置值（jpReader.dataRoot）由宿主读出来后当参数传进来
 *   · 出错不弹窗，而是收集成 problems 数组返回；由宿主决定怎么展示
 * 这样它能在纯 Node 里跑，也被 tests/dataLoader.test.mjs 覆盖，
 * smoke_test.js 也不必再手抄一份解析逻辑。
 *
 * dataRoot 定位顺序：
 *   1) configuredRoot（宿主从配置里读到的 jpReader.dataRoot，绝对路径）
 *   2) 工作区根目录直接含 rules_config.json
 *   3) 工作区根目录/<某层子目录> 含 rules_config.json（自动探测，最多往下 3 层）
 *   4) 插件目录内置 data/（发布时打包）
 */
export interface JpToken {
    surface: string;       // 表层文本
    basicForm: string;     // kuromoji 原形
    reading: string;
    pos: string;           // 词性（pos + pos_detail_1）
    lemma: string;         // 映射后 CEJC lemma
    wtype: string;         // 和/漢/外/固/混/記号/不明
}

interface RuleMatch {
    lemma_in_file?: string;
    wtype?: string[];
}

interface HighlightRule {
    id: string;
    name: string;
    enable: boolean;
    match: RuleMatch;
    style: HighlightStyle;
    priority: number;
}

export interface LoadedRule extends HighlightRule {
    lemmaSet?: Set<string>;
    styleKey: string; // 用于合并相同样式
}

export interface RuleEngineData {
    rules: LoadedRule[];
    lemmaWtype: Map<string, string>;
    lemmaMapping: Map<string, string>;
    dataRoot: string;
}

export function isJapaneseChar(ch: string): boolean {
    const c = ch.charCodeAt(0);
    return (
        (c >= 0x3040 && c <= 0x30ff) || // 平假名/片假名
        (c >= 0x3400 && c <= 0x9fff) || // CJK 汉字
        (c >= 0x4e00 && c <= 0x9fff)    // CJK 统一汉字（与上重叠，保留）
    );
}

/**
 * 从纯 lemma 文本文件读取集合（每行一个 lemma，跳过注释与空行）。
 *
 * @public 同时被内部（lemma_in_file 规则）与 smoke_test.js 使用
 */
export function readLemmaSet(filePath: string): Set<string> {
    const s = new Set<string>();
    if (!fs.existsSync(filePath)) {
        return s;
    }
    const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        // TSV 取第一列（防误读带制表符的行）
        s.add(line.split('\t')[0].trim());
    }
    return s;
}

/**
 * 探测包含 rules_config.json 的数据根目录。
 * configuredRoot 是宿主读到的 jpReader.dataRoot —— 本模块自己去读配置就违反 A1 了。
 */
export function resolveDataRoot(workspaceRoot: string | undefined, configuredRoot = ''): string {
    // 1) 配置优先
    const cfgRoot = String(configuredRoot || '').trim();
    if (cfgRoot && fs.existsSync(path.join(cfgRoot, 'rules_config.json'))) {
        return cfgRoot;
    }
    // 2) 工作区探测
    if (workspaceRoot) {
        // 直接是根
        if (fs.existsSync(path.join(workspaceRoot, 'rules_config.json'))) {
            return workspaceRoot;
        }
        // 向下探测 jp-station 等子目录（最多3层）
        const candidates = collectDirsWithConfig(workspaceRoot, 3);
        if (candidates.length > 0) {
            return candidates[0];
        }
        // 向上探测父目录（覆盖在 jp-station/vscode-extension 内打开的情况）
        let up = path.dirname(workspaceRoot);
        for (let i = 0; i < 3 && up && up !== path.dirname(up); i++, up = path.dirname(up)) {
            if (fs.existsSync(path.join(up, 'rules_config.json'))) {
                return up;
            }
        }
    }
    // 3) 插件内置 data/
    const bundled = path.join(__dirname, '..', 'data');
    return bundled;
}

function collectDirsWithConfig(root: string, maxDepth: number): string[] {
    const found: string[] = [];
    const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
        const { dir, depth } = queue.shift()!;
        let entries: fs.Dirent[] = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory()) {
                continue;
            }
            if (fs.existsSync(path.join(dir, e.name, 'rules_config.json'))) {
                found.push(path.join(dir, e.name));
            }
            if (depth < maxDepth) {
                queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
            }
        }
    }
    return found;
}

export interface LoadResult {
    data: RuleEngineData;
    /** 加载过程中的问题（缺文件、JSON 解析失败……）。由宿主决定怎么提示。 */
    problems: string[];
    /** 给状态栏用的一行摘要 */
    summary: string;
}

/** 加载所有数据，构建内存集合。纯函数：只读磁盘，不碰宿主接口。 */
export function loadData(dataRoot: string): LoadResult {
    const problems: string[] = [];

    // rules_config.json
    const rulesPath = path.join(dataRoot, 'rules_config.json');
    let rules: HighlightRule[] = [];
    if (fs.existsSync(rulesPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
            rules = parsed.rules || [];
        } catch (e) {
            problems.push(`rules_config.json 解析失败: ${(e as Error).message}`);
            rules = [];
        }
    } else {
        problems.push(`未找到 rules_config.json（dataRoot=${dataRoot}）`);
    }

    // lemma_wtype.tsv -> Map<lemma, wtype>
    const lemmaWtype = new Map<string, string>();
    const wtypePath = path.join(dataRoot, 'vocab', 'lemma_wtype.tsv');
    if (fs.existsSync(wtypePath)) {
        for (const [k, v] of parseTwoColumnTsv(fs.readFileSync(wtypePath, 'utf-8'))) {
            lemmaWtype.set(k, v);
        }
    } else {
        problems.push(`未找到 vocab/lemma_wtype.tsv（語種标注会全部变成"不明"）`);
    }

    // lemma_mapping.tsv -> Map<kuromoji_basic_form, cejc_lemma>
    const lemmaMapping = new Map<string, string>();
    const mapPath = path.join(dataRoot, 'vocab', 'lemma_mapping.tsv');
    if (fs.existsSync(mapPath)) {
        for (const [k, v] of parseTwoColumnTsv(fs.readFileSync(mapPath, 'utf-8'))) {
            lemmaMapping.set(k, v);
        }
    }

    // 组装规则（解析 lemma_in_file 为集合）
    const loadedRules: LoadedRule[] = [];
    for (const r of rules) {
        if (!r || typeof r.enable === 'undefined') {
            continue;
        }
        let lemmaSet: Set<string> | undefined;
        if (r.match && r.match.lemma_in_file) {
            const fp = path.resolve(dataRoot, r.match.lemma_in_file);
            lemmaSet = readLemmaSet(fp);
        }
        const styleKey = JSON.stringify(r.style || {});
        loadedRules.push({ ...r, lemmaSet, styleKey });
    }

    return {
        data: { rules: loadedRules, lemmaWtype, lemmaMapping, dataRoot },
        problems,
        summary: `已加载 ${loadedRules.length} 条规则 / ${lemmaWtype.size} lemma→wtype / dataRoot=${dataRoot}`,
    };
}

/**
 * 解析两列 TSV（左列 → 右列），跳过空行与 # 注释。供 lemma_wtype / lemma_mapping 共用。
 *
 * @public 导出给测试用（tests/dataLoader.test.mjs）——它仍然只被本模块内部和测试使用，
 * 不是对外 API。knip 会把未标注的导出当作死代码，标签是这里唯一的“这是故意的”声明。
 */
export function parseTwoColumnTsv(text: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) {
            continue;
        }
        const parts = line.split('\t');
        if (parts.length >= 2) {
            map.set(parts[0], parts[1]);
        }
    }
    return map;
}

export function resolveLemma(basicForm: string, mapping: Map<string, string>): string {
    const mapped = mapping.get(basicForm);
    return mapped ? mapped : basicForm;
}

export function getWtype(lemma: string, map: Map<string, string>): string {
    return map.get(lemma) || '不明';
}
