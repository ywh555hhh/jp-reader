/**
 * Provider 请求体构造的测试（否命题 A2 的回归测试）。
 *
 * 被钉住的是一个真实故障：请求体原先只在 openaiCompatible() 里构造，
 * http provider 是另一条路径、无条件只发 {text, context}。
 * 于是 providers_config.json 里自带的那份 http provider 配了 promptTemplate 却被静默忽略
 * —— prompt 丢失，直接把日文原文 POST 给模型，而且不报错。
 *
 * 运行：npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const outFile = path.join(ROOT, 'vscode-extension/out/providerModel.js');

if (!fs.existsSync(outFile)) {
  throw new Error(`未找到编译产物 ${path.relative(process.cwd(), outFile)}。请用 npm run test:unit。`);
}

const { buildHttpBody, renderTemplate, DEFAULT_PROMPTS, DEFAULT_RESPONSE_PATH } = require(outFile);

const providerOut = path.join(ROOT, 'vscode-extension/out/provider.js');
const { loadProviderConfig, isProviderEnabled } = require(providerOut);

const input = { text: '起きる', context: { sentence: '毎朝、七時に起きます。' } };

test('promptTemplate 必须真的生效（这就是当初被静默忽略的那条路径）', () => {
  const body = JSON.parse(
    buildHttpBody(
      { type: 'http', promptTemplate: '把{text}翻译成简体中文，只输出译文', model: 'deepseek-chat' },
      input,
      'translate'
    )
  );
  assert.equal(body.model, 'deepseek-chat');
  assert.match(body.messages.at(-1).content, /把起きる翻译成简体中文/);
  assert.doesNotMatch(
    body.messages.at(-1).content,
    /\{text\}/,
    '占位符必须被替换掉，不能原样发给模型'
  );
});

test('explain 的 promptTemplate 能同时用到 {text} 与 {sentence}', () => {
  const body = JSON.parse(
    buildHttpBody({ type: 'http', promptTemplate: '词「{text}」在「{sentence}」中', model: 'm' }, input, 'explain')
  );
  assert.match(body.messages.at(-1).content, /词「起きる」在「毎朝、七時に起きます。」中/);
});

test('没给 promptTemplate 但给了 model → 用该能力的默认提示词', () => {
  const body = JSON.parse(buildHttpBody({ type: 'http', model: 'gpt-4o-mini' }, input, 'explain'));
  assert.match(body.messages.at(-1).content, /起きる/);
  assert.doesNotMatch(body.messages.at(-1).content, /\{text\}/);
  assert.ok(DEFAULT_PROMPTS.explain.includes('{text}'), '默认提示词本身应当是模板');
});

test('什么都没配 → 发原始 {text, context}（给自定义服务的最小契约）', () => {
  const body = JSON.parse(buildHttpBody({ type: 'http' }, input, 'translate'));
  assert.deepEqual(body, { text: '起きる', context: { sentence: '毎朝、七時に起きます。' } });
});

test('bodyTemplate 优先级最高，且同样支持占位符', () => {
  const raw = buildHttpBody(
    { type: 'http', bodyTemplate: '{"q":"{text}","mode":"raw"}', promptTemplate: 'should-not-win' },
    input,
    'translate'
  );
  assert.deepEqual(JSON.parse(raw), { q: '起きる', mode: 'raw' });
});

test('renderTemplate：缺 sentence 时退回 text，不会留下空占位', () => {
  assert.equal(renderTemplate('{text}|{sentence}', { text: '語' }), '語|語');
  assert.equal(renderTemplate('{lemma}', { text: '語', context: { lemma: 'レンマ' } }), 'レンマ');
  assert.equal(renderTemplate('无占位', input), '无占位');
});

test('OpenAI 兼容接口有默认取值路径', () => {
  assert.equal(DEFAULT_RESPONSE_PATH.explain, 'choices.0.message.content');
  assert.equal(DEFAULT_RESPONSE_PATH.translate, 'choices.0.message.content');
});

const EXAMPLE_ROOT = path.join(ROOT, 'examples/minimal');

test('示例 providers_config.json：每个 http provider 都必须发出提示词', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(EXAMPLE_ROOT, 'providers_config.json'), 'utf8'));

  const httpOptions = [];
  for (const [kind, kc] of Object.entries(cfg)) {
    for (const [name, opt] of Object.entries(kc.options || {})) {
      if (opt.type === 'http') {
        httpOptions.push({ kind, name, opt });
      }
    }
  }
  assert.ok(httpOptions.length > 0, '自带配置里应当有 http provider 作为示例');

  for (const { kind, name, opt } of httpOptions) {
    const body = JSON.parse(buildHttpBody(opt, input, kind));
    // 要么是 chat 形状（带 messages），要么是用户自己写了 bodyTemplate
    const hasPrompt =
      Array.isArray(body.messages) ||
      typeof opt.bodyTemplate === 'string' ||
      // 两者都没有时，至少不能声称自己配了 promptTemplate
      !opt.promptTemplate;
    assert.ok(hasPrompt, `providers_config.json 的 ${kind}.${name} 配了 promptTemplate 却没生效`);
    if (Array.isArray(body.messages)) {
      assert.doesNotMatch(
        JSON.stringify(body),
        /\{(text|sentence)\}/,
        `${kind}.${name} 的占位符没有被替换`
      );
    }
  }
});

test('loadProviderConfig 能读出示例配置（provider 层无状态，配置由调用方持有）', () => {
  const cfg = loadProviderConfig(EXAMPLE_ROOT);
  assert.ok(Object.keys(cfg).length > 0, '应当读到 providers_config.json');
  assert.equal(cfg.translate.active, 'google');
  // 无状态设计的一个直接好处：可以拿任意一份配置问"某个能力是否启用"
  assert.equal(isProviderEnabled(cfg, 'translate'), true);
  assert.equal(isProviderEnabled(cfg, 'explain'), false, 'explain.active = "off"');
  assert.equal(isProviderEnabled({}, 'translate'), true, '没配置时翻译有内置默认');
  assert.equal(isProviderEnabled({}, 'explain'), false, '没配置时讲解必须显式开启');
});

test('示例配置不使用明文 apiKey，改用 apiKeySecret', () => {
  const raw = fs.readFileSync(path.join(EXAMPLE_ROOT, 'providers_config.json'), 'utf8');
  assert.doesNotMatch(raw, /"apiKey"\s*:\s*"[^"]+"/, '配置里不允许出现明文密钥');
  assert.match(raw, /"apiKeySecret"/, '应当示范 apiKeySecret 的写法');
});
