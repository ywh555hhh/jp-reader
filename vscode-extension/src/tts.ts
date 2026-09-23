import { execFile } from 'child_process';
import { existsSync, unlinkSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { callProvider } from './appContext';
import { fetchToFile } from './provider';
import { missingPlayerHint, pickPlayer, PlayerCommand } from './audioPlayer';

/**
 * 日语朗读。
 *
 * 职责边界（两条否命题一起管着）：
 *   · 音频 URL 由 provider 给出，**下载也走 provider**（A2：出网只有一个出口）
 *   · 本模块只负责"怎么播"：按句切分 → 下载到临时目录 → 交给系统播放器
 *
 * 播放器按平台自动挑（`audioPlayer.ts`）：
 *   macOS   afplay（系统自带）
 *   Windows PowerShell + WinMM MCI（系统自带，且能阻塞到播完）
 *   Linux   mpv / ffplay / sox play / paplay，哪个装了用哪个
 * 一个都没有时**抛错并给出安装建议** —— 静默没声音比报错更难查。
 */

/** 按句末标点切分，控制单段长度（Google TTS 单次约 180 字以内）。仅供本模块使用。 */
function splitForTTS(text: string): string[] {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) {
        return [];
    }
    const parts = clean.split(/(?<=[。！？.!?…])/);
    const chunks: string[] = [];
    let buf = '';
    for (const p of parts) {
        if (!p) {
            continue;
        }
        if (buf && (buf + p).length > 180) {
            chunks.push(buf);
            buf = p;
        } else {
            buf += p;
        }
    }
    if (buf) {
        chunks.push(buf);
    }
    return chunks;
}

/**
 * 取朗读音频 URL。URL 由 provider 层给出；本模块不拼 URL。
 * 阅读视图需要它：webview 自己播（宿主播不了 webview 的音频）。
 */
export async function resolveTtsUrls(text: string): Promise<string[]> {
    const chunks = splitForTTS(text);
    const urls: string[] = [];
    for (const chunk of chunks) {
        const out = await callProvider('speak', { text: chunk });
        if (out.audioUrl) {
            urls.push(out.audioUrl);
        }
    }
    return urls;
}

/** 命令是否存在：直接在 PATH 上找，不起子进程、不缓存（本模块保持无状态） */
function commandExists(command: string): boolean {
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir) {
            continue;
        }
        for (const ext of exts) {
            if (existsSync(path.join(dir, command + ext))) {
                return true;
            }
        }
    }
    return false;
}

function run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve) => {
        execFile(command, args, { timeout: 120000 }, () => resolve());
    });
}

/** 用系统播放器顺序播放（每段播完再播下一段） */
async function playWith(player: PlayerCommand, files: string[]): Promise<void> {
    for (const file of files) {
        await run(player.command, player.args(file));
    }
}

/**
 * Windows：PowerShell + WinMM MCI。
 * 这里不再自己下载（下载已经由 provider 完成），所以脚本只管播本地文件。
 */
function buildWindowsScript(files: string[]): string {
    const cs = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Mci {
  [DllImport("winmm.dll")]
  public static extern int mciSendString(string command, StringBuilder buffer, int bufferSize, IntPtr callback);
}
`;
    const lines = [`Add-Type -TypeDefinition @'`, cs.trim(), `'@`];
    files.forEach((file, i) => {
        const safe = file.replace(/'/g, "''");
        lines.push(
            `[Mci]::mciSendString("open \"${safe}\" type mpegvideo alias jptts${i}", $null, 0, [IntPtr]::Zero) | Out-Null`
        );
        lines.push(
            `[Mci]::mciSendString("play jptts${i} wait", $null, 0, [IntPtr]::Zero) | Out-Null`
        );
        lines.push(`[Mci]::mciSendString("close jptts${i}", $null, 0, [IntPtr]::Zero) | Out-Null`);
    });
    return lines.join('\n');
}

function playWithWindows(files: string[]): Promise<void> {
    return new Promise((resolve) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', buildWindowsScript(files)],
            { timeout: 120000 },
            () => resolve()
        );
    });
}

/** 下载每一段到临时目录（失败时抛出，由调用方提示） */
async function downloadChunks(urls: string[]): Promise<string[]> {
    const files: string[] = [];
    for (let i = 0; i < urls.length; i += 1) {
        const file = path.join(os.tmpdir(), `jptts_${process.pid}_${Date.now()}_${i}.mp3`);
        await fetchToFile(urls[i], file);
        files.push(file);
    }
    return files;
}

function cleanup(files: string[]): void {
    for (const file of files) {
        try {
            unlinkSync(file);
        } catch {
            /* 临时文件删不掉不该影响朗读 */
        }
    }
}

/**
 * 朗读一段文本（编辑器命令用）。
 * 出错时抛异常，调用方负责给用户一句人话 —— 这里不认识 vscode。
 */
export async function speak(text: string): Promise<void> {
    const urls = await resolveTtsUrls(text);
    if (urls.length === 0) {
        return;
    }

    const files = await downloadChunks(urls);
    try {
        if (process.platform === 'win32') {
            await playWithWindows(files);
            return;
        }
        const player = pickPlayer(process.platform, commandExists);
        if (!player) {
            throw new Error(missingPlayerHint(process.platform));
        }
        await playWith(player, files);
    } finally {
        cleanup(files);
    }
}
