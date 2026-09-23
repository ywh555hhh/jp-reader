import * as http from 'http';
import * as https from 'https';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { buildHttpBody, DEFAULT_RESPONSE_PATH } from './providerModel';
import {
    KindConfig,
    ProviderInput,
    ProviderKind,
    ProviderOptionConfig,
    ProviderOutput,
    ProvidersConfig,
    ProviderType,
} from './providerModel';

/**
 * Provider 层 = **唯一出网出口**（否命题 A2），而且**不持有状态**。
 *
 * 配置（providers_config.json 的内容）和密钥读取器都由调用方通过 ProviderRuntime 传进来，
 * 持有者是 appContext —— 这样"用哪份配置、密钥从哪来"只有一个答案（否命题 A10 / #7）。
 *
 * 为什么必须唯一：出网散开就必然出现"两套配置、两套错误处理、两套 prompt 逻辑"，
 * 而开关也会互相骗人（在本项目里真实发生过：providers_config.json 里关掉 AI 讲解，
 * 命令面板那条路径照旧发请求）。所以除了这里，任何模块都不得 import node:http(s)。
 *
 * Provider 来源三种，配置写在 providers_config.json：
 *   builtin  内置实现（google 翻译 / google TTS / openai 兼容）
 *   http     用户自己的 HTTP 服务（支持 promptTemplate / bodyTemplate / responsePath）
 *   command  用户写的脚本（stdin/stdout JSON）
 */

interface Provider {
    id: string;
    kind: ProviderKind;
    invoke(input: ProviderInput): Promise<ProviderOutput>;
}

// ---------- 内置实现 ----------

function googleTranslate(text: string): Promise<string> {
    const url =
        'https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=zh-CN&dt=t&q=' +
        encodeURIComponent(text);
    return new Promise((resolve, reject) => {
        https
            .get(url, (res) => {
                let raw = '';
                res.on('data', (d) => (raw += d));
                res.on('end', () => {
                    try {
                        const j = JSON.parse(raw);
                        const seg = (j[0] || []).map((x: any[]) => (x && x[0]) || '').join('');
                        resolve(seg.trim() || raw.slice(0, 300));
                    } catch {
                        resolve(raw.slice(0, 300));
                    }
                });
            })
            .on('error', (e) => reject(new Error('翻译请求失败: ' + e.message)));
    });
}

function googleTtsUrl(text: string): string {
    return (
        'https://translate.google.com/translate_tts?ie=UTF-8&tl=ja&client=tw-ob&q=' +
        encodeURIComponent(text)
    );
}

// ---------- 密钥 ----------

export interface ProviderRuntime {
    config: ProvidersConfig;
    /** SecretStorage 读取器（provider 层不 import vscode，由宿主注入） */
    secrets?: { get(key: string): Promise<string | undefined> };
}

/** 先查密钥存储，再回退到明文 apiKey（明文只是兼容旧配置） */
async function resolveApiKey(
    cfg: ProviderOptionConfig,
    secrets?: ProviderRuntime['secrets']
): Promise<string> {
    if (cfg.apiKeySecret && secrets) {
        const stored = await secrets.get(cfg.apiKeySecret);
        if (stored) {
            return stored;
        }
    }
    return cfg.apiKey || '';
}

// ---------- HTTP（唯一出网实现） ----------

const DEFAULT_OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function httpRequest(
    id: string,
    kind: ProviderKind,
    cfg: ProviderOptionConfig,
    input: ProviderInput,
    secrets?: ProviderRuntime['secrets'],
    urlOverride?: string
): Promise<ProviderOutput> {
    const url = urlOverride || cfg.url || '';
    if (!url) {
        return Promise.reject(new Error(`${id}: 没配置 url`));
    }
    return resolveApiKey(cfg, secrets).then((apiKey) => {
        if (cfg.apiKeySecret && !apiKey) {
            return Promise.reject(
                new Error(
                    `未找到密钥 ${cfg.apiKeySecret}。请运行命令「JP Reader: 设置 Provider 密钥」写入。`
                )
            );
        }
        return new Promise<ProviderOutput>((resolve, reject) => {
            const body = buildHttpBody(cfg, input, kind);
            const u = new URL(url);
            const isHttps = u.protocol === 'https:';
            const headers: Record<string, string | number> = {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                ...(cfg.headers || {}),
            };
            if (apiKey && !headers.Authorization) {
                headers.Authorization = `Bearer ${apiKey}`;
            }
            const req = (isHttps ? https : http).request(
                {
                    hostname: u.hostname,
                    port: u.port || (isHttps ? 443 : 80),
                    path: u.pathname + u.search,
                    method: (cfg.method || 'POST').toUpperCase(),
                    headers,
                },
                (res) => {
                    let raw = '';
                    res.on('data', (d) => (raw += d));
                    res.on('end', () => {
                        try {
                            const parsed = JSON.parse(raw);
                            const value = (cfg.responsePath || DEFAULT_RESPONSE_PATH[kind] || 'content')
                                .split('.')
                                .reduce((acc: any, k) => (acc ? acc[k] : undefined), parsed);
                            resolve({
                                content:
                                    typeof value === 'string'
                                        ? value
                                        : JSON.stringify(parsed).slice(0, 500),
                                meta: parsed,
                            });
                        } catch {
                            resolve({ content: raw.slice(0, 500) });
                        }
                    });
                }
            );
            req.on('error', (e) => reject(new Error(`${id} 请求失败: ${e.message}`)));
            req.write(body);
            req.end();
        });
    });
}

// ---------- command provider（外部 Python/Node 脚本）----------

function makeCommand(id: string, kind: ProviderKind, cfg: ProviderOptionConfig): Provider {
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

// ---------- 工厂 ----------

function makeBuiltin(
    id: string,
    kind: ProviderKind,
    cfg: ProviderOptionConfig,
    secrets?: ProviderRuntime['secrets']
): Provider {
    return {
        id,
        kind,
        invoke(input: ProviderInput): Promise<ProviderOutput> {
            if (kind === 'translate') {
                return googleTranslate(input.text).then((content) => ({ content }));
            }
            if (kind === 'speak') {
                // 只负责给 URL，"怎么播"由调用方决定（webview 用 Audio，编辑器用系统播放器）
                return Promise.resolve({ content: input.text, audioUrl: googleTtsUrl(input.text) });
            }
            // openai 兼容不再是独立实现，只是 httpRequest 的一组默认配置
            return httpRequest(
                id,
                kind,
                {
                    ...cfg,
                    type: 'http',
                    responsePath: cfg.responsePath || DEFAULT_RESPONSE_PATH[kind],
                },
                input,
                secrets,
                cfg.url || DEFAULT_OPENAI_URL
            );
        },
    };
}

function makeHttp(
    id: string,
    kind: ProviderKind,
    cfg: ProviderOptionConfig,
    secrets?: ProviderRuntime['secrets']
): Provider {
    return {
        id,
        kind,
        invoke: (input: ProviderInput) => httpRequest(id, kind, cfg, input, secrets),
    };
}

function makeProvider(
    id: string,
    kind: ProviderKind,
    opt: ProviderOptionConfig,
    secrets?: ProviderRuntime['secrets']
): Provider | null {
    const type: ProviderType = opt.type;
    switch (type) {
        case 'builtin':
            return makeBuiltin(id, kind, opt, secrets);
        case 'command':
            return makeCommand(id, kind, opt);
        case 'http':
            return makeHttp(id, kind, opt, secrets);
        default:
            return null;
    }
}

// ---------- Registry ----------

/** 读取 provider 配置。纯函数：只读磁盘，不缓存（缓存由 appContext 持有）。 */
export function loadProviderConfig(root: string): ProvidersConfig {
    try {
        const file = path.join(root, 'providers_config.json');
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf-8'));
        }
    } catch {
        /* 配置坏了就按"没配置"处理：调用方会看到未启用的提示 */
    }
    return {};
}

function getActiveProvider(
    runtime: ProviderRuntime,
    kind: ProviderKind
): Provider | null {
    const kc: KindConfig | undefined = runtime.config[kind];
    if (!kc || !kc.active) {
        // 没配置时的默认：翻译与朗读有内置实现，其它能力必须显式配置
        if (kind === 'translate') {
            return makeBuiltin('default-google', kind, { type: 'builtin' }, runtime.secrets);
        }
        if (kind === 'speak') {
            return makeBuiltin('default-google-tts', kind, { type: 'builtin' }, runtime.secrets);
        }
        return null;
    }
    const opt = kc.options?.[kc.active];
    if (!opt) {
        return null;
    }
    return makeProvider(`${kind}/${kc.active}`, kind, opt, runtime.secrets);
}

export async function callProvider(
    runtime: ProviderRuntime,
    kind: ProviderKind,
    input: ProviderInput
): Promise<ProviderOutput> {
    const provider = getActiveProvider(runtime, kind);
    if (!provider) {
        throw new Error(`未配置 ${kind} provider（在 providers_config.json 中设置）`);
    }
    return provider.invoke(input);
}

export function isProviderEnabled(config: ProvidersConfig, kind: ProviderKind): boolean {
    const kc = config[kind];
    if (!kc) {
        // translate / speak 有内置默认，开箱即用
        return kind === 'translate' || kind === 'speak';
    }
    return !!kc.active && kc.active !== 'off';
}
