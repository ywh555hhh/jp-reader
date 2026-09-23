import { execFile } from 'child_process';
import {
    Provider,
    ProviderInput,
    ProviderKind,
    ProviderOptionConfig,
    ProviderOutput,
} from './providerModel';

/**
 * `command` 类型的 Provider：把工作交给用户自己的脚本（stdin/stdout JSON 协议）。
 *
 * 单独一个模块的理由：provider.ts 是**唯一出网口**（否命题 A2），
 * 而进程调用与网络无关；把它拆出来既让 provider.ts 回到 350 行以内（A19），
 * 也让"出网"这件事在 provider.ts 里更显眼。
 */

// ---------- command provider（外部 Python/Node 脚本）----------

export function makeCommand(id: string, kind: ProviderKind, cfg: ProviderOptionConfig): Provider {
    return {
        id,
        kind,
        invoke(input: ProviderInput): Promise<ProviderOutput> {
            return new Promise((resolve, reject) => {
                const payload = JSON.stringify({ text: input.text, context: input.context || {}, kind });
                const proc = execFile(
                    cfg.command || 'python',
                    cfg.args || [],
                    { timeout: 30000, maxBuffer: 1024 * 1024 },
                    (err, stdout, stderr) => {
                        if (err) {
                            reject(new Error(`命令插件错误: ${err.message} ${stderr.slice(0, 200)}`));
                            return;
                        }
                        try {
                            const j = JSON.parse(stdout.trim());
                            resolve({ content: j.content ?? String(j), audioUrl: j.audioUrl, meta: j.meta });
                        } catch {
                            resolve({ content: stdout.trim().slice(0, 500) });
                        }
                    }
                );
                proc.stdin?.write(payload);
                proc.stdin?.end();
            });
        },
    };
}

