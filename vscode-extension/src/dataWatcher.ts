import * as vscode from 'vscode';

/**
 * 数据文件监听：规则 / provider 配置 / 词库变了就通知宿主重新加载。
 *
 * 为什么需要它：规则和词表是这个扩展的**数据**。之前只在激活时加载一次
 * （`if (!data)` 记忆化），于是"改 rules_config.json 就生效"这条核心承诺
 * 实际需要 Reload Window —— 承诺与实现不一致（issue #6）。
 *
 * 只做"何时该重载"，不关心"重载什么"：具体动作由调用方通过 onChange 决定。
 */
export function watchDataFiles(
    context: vscode.ExtensionContext,
    dataRoot: string,
    onChange: () => void,
    debounceMs = 300
): void {
    const pattern = new vscode.RelativePattern(
        vscode.Uri.file(dataRoot),
        '{rules_config.json,providers_config.json,vocab/*.tsv,vocab/*.txt}'
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(onChange, debounceMs);
    };
    watcher.onDidChange(schedule);
    watcher.onDidCreate(schedule);
    watcher.onDidDelete(schedule);
    context.subscriptions.push(watcher);
}
