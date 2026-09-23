import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';

/**
 * 个人收集词库读写：my_collection.tsv
 *
 * 列：id, timestamp, lemma, surface_form, wtype, pos, sentence, source, status, note
 *
 * id 是唯一主键，timestamp 只是普通字段。
 * 为什么不能拿 timestamp 当主键：它只有毫秒分辨率，而批量收集是在一个同步循环里
 * 连续调 addEntry 的，实测连续 300 次写入有 224 次落在同一毫秒——于是
 * "按 id 更新状态 / 删除"会一次命中多行，属于静默数据损坏。
 *
 * 旧格式（9 列、没有 id 列）会被透明迁移：旧 timestamp 直接充当 id，
 * 因此既有数据的 update/delete 仍然可用。
 */
export interface CollectionEntry {
    id: string;
    timestamp: string;
    lemma: string;
    surfaceForm: string;
    wtype: string;
    pos: string;
    sentence: string;
    source: string;
    status: 'new' | 'seen' | 'mastered';
    note: string;
}

const HEADER =
    'id\ttimestamp\tlemma\tsurface_form\twtype\tpos\tsentence\tsource\tstatus\tnote';
const LEGACY_HEADER =
    'timestamp\tlemma\tsurface_form\twtype\tpos\tsentence\tsource\tstatus\tnote';
const COLUMN_COUNT = 10;

/**
 * 一行 TSV → 词条。
 *
 * 旧格式（9 列，没有 id 列）会被分配一个新的唯一 id：
 * 旧 timestamp 不能拿来做主键——它本来就会重复（这正是 #1 修的问题），
 * 沿用它等于把历史脏数据继承下来。timestamp 字段本身原样保留。
 */
function parseAnyRow(line: string): CollectionEntry | null {
    const p = line.split('\t');
    if (p.length >= COLUMN_COUNT) {
        return {
            id: p[0] || '',
            timestamp: p[1] || '',
            lemma: p[2] || '',
            surfaceForm: p[3] || '',
            wtype: p[4] || '',
            pos: p[5] || '',
            sentence: p[6] || '',
            source: p[7] || '',
            status: (p[8] || 'new') as CollectionEntry['status'],
            note: p[9] || '',
        };
    }
    if (p.length === COLUMN_COUNT - 1) {
        return {
            id: randomUUID(),
            timestamp: p[0] || '',
            lemma: p[1] || '',
            surfaceForm: p[2] || '',
            wtype: p[3] || '',
            pos: p[4] || '',
            sentence: p[5] || '',
            source: p[6] || '',
            status: (p[7] || 'new') as CollectionEntry['status'],
            note: p[8] || '',
        };
    }
    return null;
}

/** 单元格里的制表符/换行会破坏 TSV 结构，落盘前替换成全角空格 */
function cell(value: string): string {
    return String(value).replace(/\t/g, '　').replace(/\r?\n/g, ' ');
}

function serializeRow(e: CollectionEntry): string {
    return [
        e.id,
        e.timestamp,
        e.lemma,
        e.surfaceForm,
        e.wtype,
        e.pos,
        e.sentence,
        e.source,
        e.status,
        e.note,
    ]
        .map(cell)
        .join('\t');
}

function collectionPath(dataRoot: string): string {
    return path.join(dataRoot, 'vocab', 'my_collection.tsv');
}

function lemmasPath(dataRoot: string): string {
    return path.join(dataRoot, 'vocab', 'my_collection_lemmas.txt');
}

/**
 * 拆成数据行。
 *
 * ⚠ 这里绝不能对整行做 trim：最后两列（status / note）完全可能为空，
 * 行尾的制表符一旦被吃掉，10 列就变成 9 列，然后被 parseRow 当成旧格式解析——
 * 结果是「只更新一行」会把所有行的列整体错位。运行时测试（tests/collection.test.mjs）
 * 抓到过这个 bug，别把 trim 加回来。
 */
function bodyLines(content: string): string[] {
    return content
        .split('\n')
        .map((l) => l.replace(/\r$/, ''))
        .filter((l) => {
            const t = l.trim();
            return t !== '' && !t.startsWith('#') && t !== HEADER && t !== LEGACY_HEADER;
        });
}

function writeRows(fp: string, entries: CollectionEntry[]): void {
    const body = entries.map(serializeRow).join('\n');
    fs.writeFileSync(fp, `${HEADER}\n${body}${entries.length ? '\n' : ''}`, 'utf-8');
}

/**
 * 确保文件存在且使用当前格式。
 *
 * 遇到旧表头（或空文件）时立刻就地迁移：旧行拿到新的唯一 id，其余字段一字不改。
 * 迁移只发生一次。写失败（例如文件只读）不应该导致读不到数据，所以这里吞掉异常——
 * 代价是那份文件每次读都会重新生成 id，而它本来就写不进去。
 */
function ensureFile(fp: string): void {
    try {
        if (!fs.existsSync(fp)) {
            writeRows(fp, []);
            return;
        }
        const content = fs.readFileSync(fp, 'utf-8');
        const firstLine = content.split('\n')[0].trim();
        if (firstLine === HEADER) {
            return;
        }
        if (firstLine === LEGACY_HEADER || firstLine === '') {
            writeRows(
                fp,
                bodyLines(content)
                    .map(parseAnyRow)
                    .filter((e): e is CollectionEntry => e !== null)
            );
        }
    } catch {
        /* 保持可读优先 */
    }
}

/** 读取全部收集词条（内部使用；对外请用 groupByLemma / update*） */
function loadEntries(dataRoot: string): CollectionEntry[] {
    const fp = collectionPath(dataRoot);
    if (!fs.existsSync(fp)) {
        return [];
    }
    // 先迁移再读，保证拿到的 id 是稳定的（否则旧格式每读一次就会换一批 id）
    ensureFile(fp);
    return bodyLines(fs.readFileSync(fp, 'utf-8'))
        .map(parseAnyRow)
        .filter((e): e is CollectionEntry => e !== null);
}

/** 追加一条收集词条，并刷新 my_collection_lemmas.txt */
export function addEntry(
    dataRoot: string,
    entry: Omit<CollectionEntry, 'id' | 'timestamp'>
): boolean {
    try {
        const fp = collectionPath(dataRoot);
        ensureFile(fp);
        const record: CollectionEntry = {
            id: randomUUID(),
            timestamp: new Date().toISOString(),
            ...entry,
        };
        fs.appendFileSync(fp, `${serializeRow(record)}\n`, 'utf-8');
        refreshLemmasFile(dataRoot);
        return true;
    } catch {
        return false;
    }
}

/**
 * 从 my_collection.tsv 汇总去重 lemma，写出供高亮规则使用的纯 lemma 文件。
 * 注意：这是派生文件，不是数据源——删掉它不会丢任何东西。
 */
export function refreshLemmasFile(dataRoot: string): void {
    const entries = loadEntries(dataRoot);
    const lemmas = new Set<string>();
    for (const e of entries) {
        if (e.lemma) {
            lemmas.add(e.lemma);
        }
    }
    const sorted = Array.from(lemmas).sort();
    fs.writeFileSync(lemmasPath(dataRoot), sorted.join('\n') + (sorted.length ? '\n' : ''), 'utf-8');
}

/** 将全部条目重写回文件（保持表头） */
function writeAllEntries(dataRoot: string, entries: CollectionEntry[]): void {
    writeRows(collectionPath(dataRoot), entries);
    refreshLemmasFile(dataRoot);
}

/** 按 id 更新复习状态；找不到返回 false */
export function updateEntryStatus(
    dataRoot: string,
    id: string,
    status: CollectionEntry['status']
): boolean {
    const entries = loadEntries(dataRoot);
    let hit = false;
    for (const e of entries) {
        if (e.id === id) {
            e.status = status;
            hit = true;
        }
    }
    if (hit) {
        writeAllEntries(dataRoot, entries);
    }
    return hit;
}

/** 按 id 更新笔记；找不到返回 false */
export function updateEntryNote(dataRoot: string, id: string, note: string): boolean {
    const entries = loadEntries(dataRoot);
    let hit = false;
    for (const e of entries) {
        if (e.id === id) {
            e.note = note;
            hit = true;
        }
    }
    if (hit) {
        writeAllEntries(dataRoot, entries);
    }
    return hit;
}

/** 按 id 删除词条；返回删除后剩余条数 */
export function deleteEntry(dataRoot: string, id: string): number {
    const entries = loadEntries(dataRoot).filter((e) => e.id !== id);
    writeAllEntries(dataRoot, entries);
    return entries.length;
}

/** 按 lemma 分组（词条详情：一个词的多条历史语境） */
export function groupByLemma(dataRoot: string): Map<string, CollectionEntry[]> {
    const map = new Map<string, CollectionEntry[]>();
    for (const e of loadEntries(dataRoot)) {
        const arr = map.get(e.lemma);
        if (arr) {
            arr.push(e);
        } else {
            map.set(e.lemma, [e]);
        }
    }
    return map;
}

