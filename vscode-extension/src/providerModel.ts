/**
 * Provider 模型：类型 + 请求体构造。
 *
 * 这里**没有任何网络调用**（那些在 provider.ts，唯一出网口，见否命题 A2），
 * 所以能被纯 Node 单测覆盖（tests/provider.test.mjs）。
 */
export type ProviderKind = 'translate' | 'speak' | 'explain' | 'lookup';

export interface ProviderInput {
    text: string;
    context?: {
        sentence?: string;
        source?: string;
        lemma?: string;
        surface?: string;
    };
}

export interface ProviderOutput {
    content: string;
    audioUrl?: string;
    meta?: Record<string, any>;
}

export type ProviderType = 'builtin' | 'command' | 'http';

/** Provider 的运行时形态（provider.ts 与 providerCommand.ts 共用） */
export interface Provider {
    id: string;
    kind: ProviderKind;
    invoke(input: ProviderInput): Promise<ProviderOutput>;
}

export interface ProviderOptionConfig {
    type: ProviderType;
    /** builtin 时选哪个内置实现（google_translate / google_tts / openai_compatible） */
    builtinId?: string;
    // command
    command?: string;
    args?: string[];
    // http
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    /** 直接替换整个请求体（JSON 字符串，支持 {text} / {sentence} / {lemma} 占位符），优先级最高 */
    bodyTemplate?: string;
    /** 取值路径，如 choices.0.message.content */
    responsePath?: string;
    // 通用
    /** 含 {text} / {sentence} / {lemma} 占位符的提示词模板 */
    promptTemplate?: string;
    /** ⚠ 明文密钥。仅为兼容旧配置保留，新配置请用 apiKeySecret */
    apiKey?: string;
    /** SecretStorage 里的键名（推荐）。密钥不落盘，也不进 settings */
    apiKeySecret?: string;
    model?: string;
}

export interface KindConfig {
    active: string;
    options: Record<string, ProviderOptionConfig>;
}

export type ProvidersConfig = Partial<Record<ProviderKind, KindConfig>>;

/**
 * 请求体 / 提示词的构造。
 *
 * 纯函数：不认识网络、不认识 vscode，所以能被单测（tests/provider.test.mjs）。
 *
 * 这个文件是被一次真实的故障逼出来的：请求体原先只在 provider.ts 的 openaiCompatible()
 * 里构造，而 http provider 是另一条路径、无条件只发 `{text, context}`。
 * 结果 providers_config.json 里自带的那份 http provider 配了 promptTemplate 却被**静默忽略**——
 * prompt 丢失，直接把日文原文 POST 给模型。现在两条路径共用这里的实现。
 */

/**
 * 各能力的默认提示词（配置里没给 promptTemplate 时使用）。
 *
 * @public 导出给 tests/provider.test.mjs —— knip 把未被 src 引用的导出当死代码，
 * 这个标签是"这是故意的"声明。
 */
export const DEFAULT_PROMPTS: Partial<Record<ProviderKind, string>> = {
    explain:
        '请用简体中文讲解这个日语词在其所在原句中的含义、语法和语感，控制在 120 字以内，并给出简短的中文翻译。\n单词：{text}\n原句：{sentence}',
    translate: '把{text}翻译成简体中文，只输出译文',
};

/** OpenAI 兼容接口的默认取值路径 */
export const DEFAULT_RESPONSE_PATH: Partial<Record<ProviderKind, string>> = {
    explain: 'choices.0.message.content',
    translate: 'choices.0.message.content',
};

/**
 * 提示词 / 请求体模板渲染。
 *
 * @public 导出给 tests/provider.test.mjs
 */
export function renderTemplate(template: string, input: ProviderInput): string {
    return template
        .replace(/\{text\}/g, input.text)
        .replace(/\{sentence\}/g, input.context?.sentence || input.text)
        .replace(/\{lemma\}/g, input.context?.lemma || '');
}

/**
 * 构造 HTTP 请求体。三种形态，按优先级：
 *   1. bodyTemplate —— 用户直接给完整 JSON（最自由）
 *   2. promptTemplate / model —— OpenAI 兼容的 chat 形状
 *   3. 默认 —— `{"text": ..., "context": ...}`（给自定义服务用）
 */
export function buildHttpBody(
    cfg: ProviderOptionConfig,
    input: ProviderInput,
    kind: ProviderKind
): string {
    if (cfg.bodyTemplate) {
        return renderTemplate(cfg.bodyTemplate, input);
    }
    if (cfg.promptTemplate || cfg.model) {
        const prompt = renderTemplate(cfg.promptTemplate || DEFAULT_PROMPTS[kind] || '{text}', input);
        return JSON.stringify({
            model: cfg.model || 'gpt-4o-mini',
            messages: [
                { role: 'system', content: '你是耐心的日语老师。' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.4,
            max_tokens: 300,
        });
    }
    return JSON.stringify({ text: input.text, context: input.context || {} });
}
