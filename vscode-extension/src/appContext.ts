import * as vscode from 'vscode';
import * as kuromoji from 'kuromoji';
import { RuleEngineData, loadData, resolveDataRoot } from './dataLoader';
import { ProviderInput, ProviderKind, ProviderOutput, ProvidersConfig } from './providerModel';
import {
    callProvider as callProviderWithRuntime,
    isProviderEnabled as isProviderEnabledIn,
    loadProviderConfig,
} from './provider';
import { TokenizerCache, createTokenizerCache } from './tokenizer';
import {
    DefinitionEntry,
    DictionaryIndex,
    dictionaryFiles,
    loadDictionary,
    lookup as lookupInDictionary,
} from './dictionary';

/**
 * 宿主侧共享上下文：**可变事实的唯一持有者**（否命题 A10 / issue #7）。
 *
 * 持有：当前规则表、数据根、kuromoji 词典路径、Provider 密钥存储、单词本面板。
 * 以前这些散在 extension.ts / providerSecrets.ts / engineLoader.ts 各自一份，
 * 于是"同一个事实被多条路径各自持有"，也是"一件事被实现三遍"的温床。
 *
 * 约定：需要这些事实的模块**通过参数接收**，不要再新增模块级 let。
 * 新增一个可变事实时，先问：它是不是属于这里？
 *
 * 它同时是"改 rules_config.json 就生效"的实现点：数据是数据，变了就重新加载，
 * 不要求用户 Reload Window。
 */

let current: RuleEngineData | null = null;
let root = '';
let dictionaryDir = '';
let secretStore: vscode.SecretStorage | null = null;
let wordbook: { refresh(): void } | null = null;
let highlightTimer: ReturnType<typeof setTimeout> | null = null;
let providerCfg: ProvidersConfig = {};

/**
 * tokenizer 缓存的唯一持有者。
 * 用 const 对象（身份不变、内部状态由工厂闭包管理）而不是模块级 let，
 * 是为了让"缓存在哪"只有一处答案 —— 而不是散在各个调用模块里各存一份。
 */
const tokenizers: TokenizerCache = createTokenizerCache();

let extensionDir = '';

/** 词典缓存（懒加载）：外部数据，缓存只由 ctx 持有 */
let dictIndex: DictionaryIndex | null = null;
let dictLoadedFrom = '';

/**
 * 阅读视图的会话状态（打开的面板、看的是哪篇文档、首屏是否已渲染、待执行的防抖）。
 *
 * 以前它散在 readingView.ts 的模块级 let 里。移到 ctx 的理由：
 * "当前打开的是哪个阅读面板"是一个**应用级事实**——单词本刷新、数据热重载、
 * 预览插件都要用到它；散在功能模块里就会出现多份各自认为正确的副本。
 *
 * 用对象而不是散落的 let：对象身份不变，字段是会话状态，
 * 这样"会话状态只有一份"在读代码时一眼可见。
 */
export const readingSession = {
    panel: null as vscode.WebviewPanel | null,
    docUri: undefined as vscode.Uri | undefined,
    ready: false,
    debounce: null as ReturnType<typeof setTimeout> | null,
};

/** 读配置（配置读取留在宿主侧：dataLoader 是纯的，不认识 vscode，见否命题 A1） */
function configuredDataRoot(): string {
    return String(vscode.workspace.getConfiguration('jpReader').get<string>('dataRoot', '') || '').trim();
}

/**
 * 重新加载规则/词库，并把问题提示出来。
 * 错误不是 dataLoader 自己去弹窗，而是以 problems 数组返回，由这里决定怎么展示。
 */
export function loadEngineData(): RuleEngineData {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    root = resolveDataRoot(ws, configuredDataRoot());
    const result = loadData(root);
    current = result.data;
    providerCfg = loadProviderConfig(root);

    // 只弹前几条，避免刷屏；完整摘要进状态栏
    for (const problem of result.problems.slice(0, 3)) {
        vscode.window.showWarningMessage(`JP Reader: ${problem}`);
    }
    vscode.window.setStatusBarMessage(`JP Reader: ${result.summary}`, 4000);
    return result.data;
}

/** 当前数据（惰性加载；不做任何 IO 以外的副作用以外的动作） */
export function ensureData(): RuleEngineData {
    return current ?? loadEngineData();
}

/** 只读快照：给渲染回调用，避免在渲染路径上触发加载 */
export function currentData(): RuleEngineData | null {
    return current;
}

export function dataRootPath(): string {
    return root;
}

/** kuromoji 词典目录（activate 时确定一次） */
/** 词典路径（设置 jpReader.dictionaryPath；可以是单个文件，也可以是一个目录）。仅本模块使用。 */
function dictionaryFilePath(): string {
    return String(
        vscode.workspace.getConfiguration('jpReader').get<string>('dictionaryPath', '') || ''
    ).trim();
}

/**
 * 查词释义。词典懒加载，路径变了就重载。
 *
 * loaded=false 表示"没有配置词典"——调用方据此决定要不要提示用户。
 * 坏行/坏格式只报 problem 不抛异常：词典是外部数据，不该因为它写错一个字就查不到任何词。
 */
export function lookupDefinitions(term: string): {
    entries: DefinitionEntry[];
    loaded: boolean;
    problems: string[];
} {
    const configured = dictionaryFilePath();
    if (!configured) {
        return { entries: [], loaded: false, problems: [] };
    }
    if (!dictIndex || dictLoadedFrom !== configured) {
        const files = dictionaryFiles(configured);
        dictIndex = loadDictionary(files);
        dictLoadedFrom = configured;
        if (files.length === 0) {
            vscode.window.showWarningMessage(
                `JP Reader: 词典路径不存在，或目录里没有词典文件：${configured}`
            );
        }
        for (const problem of dictIndex.problems.slice(0, 3)) {
            vscode.window.showWarningMessage(`JP Reader 词典: ${problem}`);
        }
    }
    return {
        entries: lookupInDictionary(dictIndex, term),
        loaded: true,
        problems: dictIndex.problems,
    };
}

/** 词典摘要（给「检查词典」命令用） */
export function dictionarySummary(): string {
    const configured = dictionaryFilePath();
    if (!configured) {
        return '未配置词典。设置 jpReader.dictionaryPath 指向 TSV / Yomichan term_bank / JMdict-simplified 文件或目录。';
    }
    const files = dictionaryFiles(configured);
    if (!dictIndex || dictLoadedFrom !== configured) {
        dictIndex = loadDictionary(files);
        dictLoadedFrom = configured;
    }
    return (
        `${files.length} 个文件 ｜ ${dictIndex.entries.size} 个词条` +
        (dictIndex.problems.length > 0 ? ` ｜ ${dictIndex.problems.length} 个问题` : '') +
        ` ｜ 来源：${dictIndex.sources.slice(0, 3).join(', ') || '无'}`
    );
}

export function setDictionaryDir(dir: string): void {
    dictionaryDir = dir;
}

/** 单词本面板：注册后放进来，数据变化时统一由这里刷新 */
export function setWordbook(panel: { refresh(): void } | null): void {
    wordbook = panel;
}

/**
 * Provider 调用入口。
 * 调用方不再关心"配置从哪来、密钥从哪来"——那是 ctx 的事。
 */
export function callProvider(kind: ProviderKind, input: ProviderInput): Promise<ProviderOutput> {
    return callProviderWithRuntime({ config: providerCfg, secrets: secretReader() }, kind, input);
}

export function isProviderEnabled(kind: ProviderKind): boolean {
    return isProviderEnabledIn(providerCfg, kind);
}

/** 扩展安装目录（activate 时一次）：阅读视图要用它读共享 CSS */
export function setExtensionDir(dir: string): void {
    extensionDir = dir;
}

export function extensionDirPath(): string {
    return extensionDir;
}

/** 阅读视图重渲染的防抖调度 */
export function scheduleReadingRender(task: () => void, delayMs = 400): void {
    if (readingSession.debounce) {
        clearTimeout(readingSession.debounce);
    }
    readingSession.debounce = setTimeout(task, delayMs);
}

/** 取分词器（用 ctx 持有的词典目录与缓存） */
export function getTokenizer(): Promise<kuromoji.Tokenizer> {
    return tokenizers.get(dictionaryDir);
}

/** 已就绪的分词器（未就绪返回 null）——渲染路径用它 */
export function readyTokenizer(): kuromoji.Tokenizer | null {
    return tokenizers.ready();
}

/**
 * 防抖调度一次编辑器高亮刷新。
 * 由 ctx 持有这个待执行状态（而不是扩展入口），因为它是"应用还有一件事没做完"的全局事实。
 */
export function scheduleHighlightRefresh(task: () => void, delayMs = 400): void {
    if (highlightTimer) {
        clearTimeout(highlightTimer);
    }
    highlightTimer = setTimeout(task, delayMs);
}

export function refreshWordbook(): void {
    if (wordbook) {
        wordbook.refresh();
    }
}

export function initSecrets(store: vscode.SecretStorage): void {
    secretStore = store;
}

/** 给 provider 层用的读取器（仅本模块内部使用）；未初始化时返回 undefined */
function secretReader(): { get(key: string): Promise<string | undefined> } | undefined {
    const store = secretStore;
    return store ? { get: (key: string) => Promise.resolve(store.get(key)) } : undefined;
}

/**
 * 一次性迁移：把旧的明文 jpReader.aiApiKey 搬进 SecretStorage。
 * 迁移后提示用户清空设置，并把配置改成 apiKeySecret。
 */
export async function migrateLegacyAiKey(): Promise<void> {
    if (!secretStore) {
        return;
    }
    const legacy = String(
        vscode.workspace.getConfiguration('jpReader').get<string>('aiApiKey', '') || ''
    ).trim();
    if (!legacy) {
        return;
    }
    const name = 'jpReader.aiApiKey';
    if (await secretStore.get(name)) {
        return;
    }
    await secretStore.store(name, legacy);
    vscode.window.showWarningMessage(
        'JP Reader: 已把明文 API Key 从设置迁移到密钥存储（SecretStorage）。' +
            `请清空设置里的 jpReader.aiApiKey，并在 providers_config.json 里改用 "apiKeySecret": "${name}"。`
    );
}

/** 让用户把密钥写进 SecretStorage（键名对应 providers_config.json 的 apiKeySecret） */
export async function setProviderSecret(): Promise<void> {
    if (!secretStore) {
        return;
    }
    const name = await vscode.window.showInputBox({
        title: 'JP Reader: 设置 Provider 密钥',
        prompt: '密钥名称（与 providers_config.json 里的 apiKeySecret 一致，例如 jpReader.deepseek）',
        ignoreFocusOut: true,
    });
    if (!name) {
        return;
    }
    const value = await vscode.window.showInputBox({
        title: `JP Reader: ${name}`,
        prompt: '密钥内容（只保存在本机密钥存储里，不写入任何配置文件）',
        password: true,
        ignoreFocusOut: true,
    });
    if (!value) {
        return;
    }
    await secretStore.store(name.trim(), value.trim());
    vscode.window.showInformationMessage(`JP Reader: 已保存密钥 ${name.trim()}`);
}

