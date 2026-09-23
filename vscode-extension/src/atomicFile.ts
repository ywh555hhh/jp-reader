import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

/**
 * 原子写文件：写同目录临时文件 → fsync → rename 覆盖。
 *
 * 为什么必须原子：数据文件（`my_collection.tsv`、课文的词表……）是用户的**唯一副本**。
 * 直接 `writeFileSync` 覆盖时，一旦中途失败（断电、进程被杀、磁盘满），
 * 原文件已经被截断 —— 整份词库就没了。rename 在同一目录内是原子的：
 * 要么看见旧内容，要么看见新内容，永远不会看见"写了一半"的文件。
 *
 * 约定（否命题 A9 / A20）：**全仓只有这一个模块可以调用写盘 API**。
 * 其它模块一律 `import { atomicWrite }`；`fs.writeFileSync` / `fs.appendFileSync`
 * 这类"裸写"被 ast-grep 规则 `jp-no-raw-fs-write` 拦住。
 *
 * 注意本文件用**具名导入**而不是 `fs.xxx`：规则匹配的正是 `fs.` 成员调用形式，
 * 这样"唯一允许写盘的模块"这件事在规则层面是显式的，而不是靠豁免清单。
 */
export function atomicWrite(file: string, content: string): void {
    writeAtomically(file, content, 'utf-8');
}

/**
 * 二进制内容（例如朗读用的音频）也走同一套原子写。
 *
 * @public 给 provider.ts 的 fetchToFile 用 —— 下载到临时文件同样是"写盘"，
 * 不该因为"它只是缓存"就绕过唯一写入模块（A9/A20 管的是"写盘只有一处"，不是"只有数据文件算写盘"）。
 */
export function atomicWriteBuffer(file: string, data: Buffer): void {
    writeAtomically(file, data);
}

function writeAtomically(file: string, content: string | Buffer, encoding?: BufferEncoding): void {
    const dir = dirname(file);
    const tmp = join(dir, `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);

    let fd: number | null = null;
    try {
        fd = openSync(tmp, 'w');
        if (typeof content === 'string') {
            writeFileSync(fd, content, encoding ?? 'utf-8');
        } else {
            writeFileSync(fd, content);
        }
        // 先落盘再改名：否则崩溃时可能 rename 了一个内容还在页缓存里的临时文件
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
    } catch (err) {
        if (fd !== null) {
            closeSync(fd);
        }
        try {
            unlinkSync(tmp);
        } catch {
            /* 临时文件没建成，忽略 */
        }
        throw err;
    }

    try {
        renameSync(tmp, file);
    } catch (err) {
        try {
            unlinkSync(tmp);
        } catch {
            /* 忽略：真正的失败原因在 err 里 */
        }
        throw err;
    }
}
