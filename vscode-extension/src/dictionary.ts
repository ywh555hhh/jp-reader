import * as fs from 'fs';
import * as path from 'path';
import { gunzipSync } from 'zlib';

/**
 * 本地词典：查词时给释义，完全离线。
 *
 * 三种输入格式（都不需要联网、都不进本仓库）：
 *   1. 本项目自己的 TSV —— `term\treading\tpos\tmeaning`（多行 = 多个义项）
 *      这是**首选**：纯文本、可 grep、可只收你真正需要的词。
 *   2. Yomichan 的 term bank —— `term_bank_*.json`（每行一个数组）
 *   3. JMdict-simplified —— `{ words: [...] }` 的 JSON（体积大，建议用 .gz）
 *
 * 设计约束：
 *   · 本模块不依赖 vscode（可单测），也不缓存 —— 缓存由 appContext 持有（A10）
 *   · 读取有大小上限：词典是**外部数据**，不能因为用户指错文件就把扩展宿主撑爆
 *   · 坏行只记 problem 并跳过：用户手改 TSV 时不该因为一行写错就完全查不到词
 *
 * ⚠ 词典文件不要提交到本仓库：JMdict 是 CC-BY-SA 4.0，Yomichan 各词典有自己的许可，
 *   体积也远超代码仓库该有的量级。
 */

/**
 * 关于下面这些 `@public` 标记：解析函数（TSV / Yomichan / JMdict）与边界常量
 * 都是**纯函数**，由 tests/dictionary.test.mjs 直接验证；knip 把"只被测试引用"的导出
 * 当死代码，`@public` 就是"这是故意的"的声明（与 providerModel 的处理一致）。
 */
export interface DefinitionEntry {
    term: string;
    reading: string;
    pos: string;
    /** 释义（可能多条） */
    glosses: string[];
    /** 来自哪个文件，便于用户排查"为什么这个词没查到" */
    source: string;
}

export interface DictionaryIndex {
    entries: Map<string, DefinitionEntry[]>;
    sources: string[];
    problems: string[];
}

/** 单个文件的大小上限（压缩前/后都查）：防止指错文件把内存吃光 */
/** @public 单个文件上限；测试断言边界行为 */
export const MAX_DICTIONARY_BYTES = 64 * 1024 * 1024;
/** 解压后的上限（防压缩炸弹） */
/** @public 解压后上限（防压缩炸弹） */
export const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;

/** @public 空索引工厂；测试构造用例 */
export function emptyIndex(): DictionaryIndex {
    return { entries: new Map(), sources: [], problems: [] };
}

/** 把释义文本清一下：去 HTML 标签、压空白、限长 */
/** @public 释义清洗；测试直接验证 */
export function cleanGloss(text: string): string {
    return String(text)
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

function addEntry(index: DictionaryIndex, entry: DefinitionEntry): void {
    const key = entry.term;
    const existing = index.entries.get(key);
    const normalized: DefinitionEntry = { ...entry, glosses: entry.glosses.filter(Boolean) };
    if (existing) {
        existing.push(normalized);
    } else {
        index.entries.set(key, [normalized]);
    }
}

/**
 * 本项目自己的 TSV 格式：
 *
 *     # 注释
 *     起きる	おきる	動詞	起床，起来；发生
 *     起きる	おきる	動詞	（事情）发生      ← 同一词多行 = 多个义项
 *
 * 第 4 列里用 `；` 或 `;` 分隔的多个意思会被拆成多条释义。
 */
/** @public 本项目 TSV 解析；测试直接验证 */
export function parseTsvDictionary(text: string, source: string): {
    entries: DefinitionEntry[];
    problems: string[];
} {
    const entries: DefinitionEntry[] = [];
    const problems: string[] = [];
    let lineNo = 0;
    for (const raw of text.split('\n')) {
        lineNo += 1;
        const line = raw.replace(/\r$/, '');
        const t = line.trim();
        if (t === '' || t.startsWith('#')) {
            continue;
        }
        const p = line.split('\t');
        if (p.length < 4) {
            problems.push(`${source} 第 ${lineNo} 行字段数不足 4（term/reading/pos/meaning），已跳过`);
            continue;
        }
        const term = p[0].trim();
        if (!term) {
            problems.push(`${source} 第 ${lineNo} 行没有词条，已跳过`);
            continue;
        }
        const glosses = p.slice(3).join('\t').split(/[；;]/).map(cleanGloss).filter(Boolean);
        entries.push({
            term,
            reading: p[1].trim(),
            pos: p[2].trim(),
            glosses,
            source,
        });
    }
    return { entries, problems };
}

/** Yomichan term bank：每项是 [term, reading, defTags, rules, score, glossary, sequence, termTags] */
/** @public Yomichan term bank 解析；测试直接验证 */
export function parseYomichanBank(value: unknown, source: string): {
    entries: DefinitionEntry[];
    problems: string[];
} {
    const entries: DefinitionEntry[] = [];
    const problems: string[] = [];
    if (!Array.isArray(value)) {
        problems.push(`${source} 不是 Yomichan term bank（期望数组）`);
        return { entries, problems };
    }
    for (const row of value) {
        if (!Array.isArray(row) || row.length < 6) {
            continue;
        }
        const term = String(row[0] ?? '').trim();
        if (!term) {
            continue;
        }
        const glosses = extractStructuredText(row[5]).map(cleanGloss).filter(Boolean);
        entries.push({
            term,
            reading: String(row[1] ?? '').trim(),
            pos: String(row[2] ?? '').trim(),
            glosses: glosses.slice(0, 8),
            source,
        });
    }
    return { entries, problems };
}

/** Yomichan 的释义字段可能是字符串，也可能是 {type:'text', text} 这类结构（含嵌套） */
function extractStructuredText(value: unknown, depth = 0): string[] {
    if (depth > 4) {
        return [];
    }
    if (typeof value === 'string') {
        return [value];
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
        return [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((v) => extractStructuredText(v, depth + 1));
    }
    if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        const out: string[] = [];
        for (const key of ['text', 'content', 'glossary', 'items']) {
            if (key in obj) {
                out.push(...extractStructuredText(obj[key], depth + 1));
            }
        }
        return out;
    }
    return [];
}

/** JMdict-simplified：{ words: [{ kanji:[{text}], kana:[{text}], sense:[{partOfSpeech, gloss:[{text}]}] }] } */
/** @public JMdict-simplified 解析；测试直接验证 */
export function parseJmdict(value: unknown, source: string): {
    entries: DefinitionEntry[];
    problems: string[];
} {
    const entries: DefinitionEntry[] = [];
    const problems: string[] = [];
    const words = (value as { words?: unknown })?.words;
    if (!Array.isArray(words)) {
        problems.push(`${source} 不是 JMdict-simplified（缺少 words 数组）`);
        return { entries, problems };
    }
    for (const w of words) {
        const word = w as {
            kanji?: { text?: string }[];
            kana?: { text?: string }[];
            sense?: { partOfSpeech?: string[]; gloss?: { text?: string }[] }[];
        };
        const terms = (word.kanji ?? []).map((k) => String(k.text ?? '')).filter(Boolean);
        const readings = (word.kana ?? []).map((k) => String(k.text ?? '')).filter(Boolean);
        if (terms.length === 0) {
            continue;
        }
        const glosses = (word.sense ?? [])
            .flatMap((s) => (s.gloss ?? []).map((g) => String(g.text ?? '')))
            .map(cleanGloss)
            .filter(Boolean)
            .slice(0, 8);
        const pos = (word.sense ?? [])
            .flatMap((s) => s.partOfSpeech ?? [])
            .slice(0, 3)
            .join('/');
        for (const term of terms) {
            entries.push({ term, reading: readings[0] ?? '', pos, glosses, source });
        }
    }
    return { entries, problems };
}

function readMaybeGzip(file: string): string {
    const size = fs.statSync(file).size;
    if (size > MAX_DICTIONARY_BYTES) {
        throw new Error(
            `文件 ${path.basename(file)} 有 ${(size / 1048576).toFixed(0)}MB，超过 ${MAX_DICTIONARY_BYTES / 1048576}MB 上限。` +
                '请改用 TSV（只收需要的词）或 .json.gz。'
        );
    }
    const buf = fs.readFileSync(file);
    if (file.toLowerCase().endsWith('.gz')) {
        const unpacked = gunzipSync(buf, { maxOutputLength: MAX_UNPACKED_BYTES });
        return unpacked.toString('utf-8');
    }
    return buf.toString('utf-8');
}

/** 解析一个文件；格式按扩展名 + 内容嗅探决定 */
/** @public 单文件加载（含 gz 与格式嗅探）；测试直接验证 */
export function loadDictionaryFile(file: string): {
    entries: DefinitionEntry[];
    problems: string[];
} {
    const source = path.basename(file);
    try {
        const text = readMaybeGzip(file);
        const lower = file.toLowerCase();
        if (lower.endsWith('.tsv') || lower.endsWith('.tsv.gz') || lower.endsWith('.txt')) {
            return parseTsvDictionary(text, source);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (e) {
            return { entries: [], problems: [`${source} 不是合法 JSON：${(e as Error).message}`] };
        }
        if (Array.isArray(parsed)) {
            return parseYomichanBank(parsed, source);
        }
        if (parsed && typeof parsed === 'object' && 'words' in (parsed as object)) {
            return parseJmdict(parsed, source);
        }
        return {
            entries: [],
            problems: [`${source} 的格式不认识（支持 TSV、Yomichan term_bank、JMdict-simplified）`],
        };
    } catch (e) {
        return { entries: [], problems: [`${source} 读取失败：${(e as Error).message}`] };
    }
}

/** 把配置值解析成文件列表：可以是单个文件，也可以是一个目录（读其中所有词典文件） */
export function dictionaryFiles(configuredPath: string): string[] {
    const p = String(configuredPath || '').trim();
    if (!p) {
        return [];
    }
    try {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
            return fs
                .readdirSync(p)
                .filter((f) => /\.(tsv|txt|json)(\.gz)?$/i.test(f))
                .sort()
                .map((f) => path.join(p, f));
        }
        return [p];
    } catch {
        return [];
    }
}

export function loadDictionary(files: string[]): DictionaryIndex {
    const index = emptyIndex();
    for (const file of files) {
        const { entries, problems } = loadDictionaryFile(file);
        for (const entry of entries) {
            addEntry(index, entry);
        }
        index.problems.push(...problems);
        index.sources.push(path.basename(file));
    }
    return index;
}

/**
 * 查词：先按原样，再按去掉末尾送假名/片假名归一后的候选试一遍。
 * 不认识的写法就返回空 —— 不猜、不模糊匹配（模糊匹配会让释义看起来"对但其实是别的词"）。
 */
export function lookup(index: DictionaryIndex, term: string, limit = 3): DefinitionEntry[] {
    const candidates = [term, ...inflectionCandidates(term)];
    for (const candidate of candidates) {
        const hit = index.entries.get(candidate);
        if (hit && hit.length > 0) {
            return hit.slice(0, limit);
        }
    }
    return [];
}

/** 日语活用/送假名带来的常见写法差异（只做保守的几条规则，宁可查不到也不猜错） */
/** @public 活用候选；测试直接验证其保守性 */
export function inflectionCandidates(term: string): string[] {
    const out: string[] = [];
    const add = (s: string) => {
        if (s && s !== term && !out.includes(s)) {
            out.push(s);
        }
    };
    // 去末尾假名：食べ → 食べる 之类由分词器归一，这里只处理"词尾多一个活用语尾"的情况
    const last = term.slice(-1);
    if (last === 'っ') {
        add(`${term.slice(0, -1)}る`); // 買っ → 買る
    }
    if (last === 'し') {
        add(`${term.slice(0, -1)}す`);
    }
    if (last === 'き') {
        add(`${term.slice(0, -1)}く`);
    }
    // 片假名长音符的统一：サーバー ↔ サーバ
    if (term.endsWith('ー')) {
        add(term.slice(0, -1));
    } else {
        add(`${term}ー`);
    }
    return out;
}
