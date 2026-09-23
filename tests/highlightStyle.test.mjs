/**
 * 样式翻译层的测试（否命题 A5 的核心）。
 *
 * 这一层是"改 rules_config.json 就能定义新规则、不用改代码"的唯一实现点：
 * 渲染层不认识任何 rule id，只是把 style 数据翻成 CSS。
 * 它一旦退化成"按 id 硬编码"，预览里自定义规则会静默失效——所以这里把行为钉住。
 *
 * 运行：npm run test:unit
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outFile = path.resolve(import.meta.dirname, '../vscode-extension/out/highlightStyle.js');

if (!fs.existsSync(outFile)) {
  throw new Error(`未找到编译产物 ${path.relative(process.cwd(), outFile)}。请用 npm run test:unit。`);
}

const { cssDeclarationsOf, cssClassOf } = require(outFile);

test('任意规则都能生成样式：不需要改代码、也不需要事先认识这个 id', () => {
  const custom = cssDeclarationsOf({ color: '#ff00ff', fontWeight: '700', fontStyle: 'italic' });
  assert.equal(custom, 'color:#ff00ff;font-weight:700;font-style:italic');
});

test('四种样式字段都能翻译，并支持下划线', () => {
  assert.equal(cssDeclarationsOf({ color: '#4ade80' }), 'color:#4ade80');
  assert.equal(cssDeclarationsOf({ fontWeight: '500' }), 'font-weight:500');
  assert.equal(cssDeclarationsOf({ textDecoration: 'dotted' }), 'text-decoration:underline dotted');
  assert.equal(cssDeclarationsOf({}), '');
  assert.equal(cssDeclarationsOf(undefined), '');
});

test('非法取值被丢弃，而不是拼进 HTML 属性', () => {
  // 规则配置是用户手写的 JSON，不能让任意字符串进入属性
  assert.equal(cssDeclarationsOf({ color: 'javascript:alert(1)' }), '');
  assert.equal(cssDeclarationsOf({ color: 'red;" onmouseover="x' }), '');
  assert.equal(cssDeclarationsOf({ fontWeight: 'bold;color:red' }), '');
  assert.equal(cssDeclarationsOf({ fontStyle: 'url(x)' }), '');
  // 合法与非法混在一起时，只保留合法的部分
  assert.equal(cssDeclarationsOf({ color: 'red', fontWeight: 'nope' }), 'color:red');
});

test('rgb/rgba 与常见颜色名是合法的', () => {
  assert.equal(cssDeclarationsOf({ color: 'rgb(1, 2, 3)' }), 'color:rgb(1, 2, 3)');
  assert.equal(cssDeclarationsOf({ color: 'rgba(1,2,3,0.5)' }), 'color:rgba(1,2,3,0.5)');
  assert.equal(cssDeclarationsOf({ color: 'tomato' }), 'color:tomato');
});

test('类名由 id 推导，且只含安全字符', () => {
  assert.equal(cssClassOf('wago_p99'), 'jp-wago_p99');
  assert.equal(cssClassOf('My Rule!'), 'jp-my-rule');
  assert.equal(cssClassOf(''), 'jp-mark');
  assert.equal(cssClassOf('漢字'), 'jp-mark');
  // 类名只是给用户 CSS 用的钩子，不能因为 id 里有奇怪字符就破坏属性
  for (const id of ['a"b', "c'd", 'd<e', 'f g']) {
    assert.match(cssClassOf(id), /^jp-[a-z0-9_-]*$/);
  }
});
