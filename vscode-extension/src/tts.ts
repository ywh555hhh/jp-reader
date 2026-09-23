import { execFile } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { callProvider } from './appContext';

/**
 * 日语朗读。
 *
 * ⚠ 这个模块**只负责"怎么播"**：音频 URL 一律由 provider 层给出
 * （出网只有一个出口，见否命题 A2）。以前这里自己拼 Google TTS 的 URL，
 * 于是同一串 URL 在三个文件里各写了一份（provider / tts / webview 内联脚本）。
 *
 * 播放方式：把每段 mp3 下载到临时目录 → Windows WinMM MCI 依次播放（play wait 阻塞播完）。
 * 系统没有日语 SAPI 也能用；网络失败时提示。
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

/**
 * 生成 PowerShell 脚本：下载每段 mp3 → MCI 依次播放。
 * 整个流程在一个 powershell 进程里跑完，避免多次冷启动。
 */
function buildScript(urls: string[]): string {
    const tmpDir = os.tmpdir();
    // C# MCI P/Invoke
    const cs = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Mci {
  [DllImport("winmm.dll")]
  public static extern int mciSendString(string command, StringBuilder buffer, int bufferSize, IntPtr callback);
}
`;
    let lines: string[] = [
        `Add-Type -TypeDefinition @'`,
        cs.trim(),
        `'@`,
    ];
    urls.forEach((url, i) => {
        const file = path.join(tmpDir, `jptts_${Date.now()}_${i}.mp3`);
        const safeFile = file.replace(/'/g, "''");
        lines.push(`try {`);
        lines.push(
            `  Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -Headers @{'User-Agent'='Mozilla/5.0'} -OutFile '${safeFile}' -TimeoutSec 15`
        );
        lines.push(`} catch { exit 1 }`);
        lines.push(`[Mci]::mciSendString("open \\"${safeFile}\\" type mpegvideo alias jptts${i}", $null, 0, [IntPtr]::Zero) | Out-Null`);
        lines.push(`[Mci]::mciSendString("play jptts${i} wait", $null, 0, [IntPtr]::Zero) | Out-Null`);
        lines.push(`[Mci]::mciSendString("close jptts${i}", $null, 0, [IntPtr]::Zero) | Out-Null`);
        lines.push(`Remove-Item '${safeFile}' -ErrorAction SilentlyContinue`);
    });
    return lines.join('\n');
}

export async function speak(text: string): Promise<void> {
    const urls = await resolveTtsUrls(text);
    if (urls.length === 0) {
        return;
    }
    const script = buildScript(urls);
    return new Promise((resolve) => {
        execFile(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            { timeout: 60000 },
            () => resolve()
        );
    });
}
