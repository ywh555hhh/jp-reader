/**
 * 选择"用哪个程序播放本地音频文件"。
 *
 * 纯函数：平台与"命令是否存在"都从外面传进来，所以能被确定性单测 ——
 * 而这正是这里唯一会出错的地方（选了不存在的命令 → 用户点了朗读没有声音，也不报错）。
 *
 * 为什么不直接把音频交给系统默认播放器：我们需要**顺序播完再播下一段**（按句切分），
 * 而默认播放器是异步的。所以按平台挑一个能阻塞/可等待的命令行播放器。
 */

export interface PlayerCommand {
    command: string;
    args: (file: string) => string[];
    /** 给用户看的名字（提示里会用到） */
    label: string;
}

/**
 * 该平台上的候选播放器，**按优先级**排列。
 *
 * @public 被 tests/audioPlayer.test.mjs 直接验证（顺序错一个就会选到不存在的命令）
 */
export function playerCandidates(platform: NodeJS.Platform): PlayerCommand[] {
    switch (platform) {
        case 'darwin':
            // afplay 是 macOS 自带的，必然可用
            return [{ command: 'afplay', args: (f) => [f], label: 'afplay' }];
        case 'win32':
            // Windows 走 PowerShell + WinMM MCI（下面用脚本播放；这里只作为兜底列表）
            return [{ command: 'powershell.exe', args: (f) => [f], label: 'PowerShell/WinMM' }];
        default:
            return [
                {
                    command: 'mpv',
                    args: (f) => ['--no-video', '--really-quiet', f],
                    label: 'mpv',
                },
                {
                    command: 'ffplay',
                    args: (f) => ['-nodisp', '-autoexit', '-loglevel', 'quiet', f],
                    label: 'ffplay（ffmpeg）',
                },
                { command: 'play', args: (f) => ['-q', f], label: 'sox play' },
                { command: 'paplay', args: (f) => [f], label: 'paplay（PulseAudio）' },
            ];
    }
}

/**
 * 选出第一个"这台机器上真的有"的播放器。
 * 一个都没有时返回 null —— 调用方必须给用户一句人话，而不是静默什么都没发生。
 */
export function pickPlayer(
    platform: NodeJS.Platform,
    commandExists: (command: string) => boolean
): PlayerCommand | null {
    for (const candidate of playerCandidates(platform)) {
        if (commandExists(candidate.command)) {
            return candidate;
        }
    }
    return null;
}

/** 没找到播放器时的提示文案（要说清怎么办，而不只是"失败"） */
export function missingPlayerHint(platform: NodeJS.Platform): string {
    switch (platform) {
        case 'darwin':
            return 'macOS 上没找到 afplay（系统自带命令）—— 可能被 PATH 改动影响。';
        case 'win32':
            return 'Windows 上没能调用 PowerShell —— 建议在阅读视图里使用朗读（走网页播放）。';
        default:
            return '这台机器上没找到可用的音频播放器。装一个即可：mpv（推荐）、ffmpeg 的 ffplay、sox、或 PulseAudio 的 paplay。';
    }
}
