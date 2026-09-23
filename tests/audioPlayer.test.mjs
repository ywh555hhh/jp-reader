/**
 * 音频播放器选择的测试。
 *
 * 这段逻辑的失效方式是"点了朗读，没有声音，也没有报错" —— 静默失败，
 * 所以把每个平台的候选顺序与"一个都没有时返回 null"都钉住。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const outFile = path.resolve(import.meta.dirname, '../vscode-extension/out/audioPlayer.js');

if (!fs.existsSync(outFile)) {
  throw new Error(`未找到编译产物 ${path.relative(process.cwd(), outFile)}。请用 npm run test:unit。`);
}

const { missingPlayerHint, pickPlayer, playerCandidates } = require(outFile);

test('macOS：用系统自带的 afplay', () => {
  const list = playerCandidates('darwin');
  assert.equal(list[0].command, 'afplay');
  assert.deepEqual(list[0].args('/tmp/a.mp3'), ['/tmp/a.mp3']);
});

test('Linux：候选按 mpv → ffplay → sox play → paplay 排列，且只选第一个存在的', () => {
  const labels = playerCandidates('linux').map((p) => p.command);
  assert.deepEqual(labels, ['mpv', 'ffplay', 'play', 'paplay']);

  assert.equal(pickPlayer('linux', (c) => c === 'paplay').command, 'paplay');
  assert.equal(pickPlayer('linux', (c) => c === 'ffplay' || c === 'paplay').command, 'ffplay', '优先级高的先选');
  assert.equal(pickPlayer('linux', () => true).command, 'mpv');
});

test('Windows：走 PowerShell（音频由 WinMM MCI 播放）', () => {
  assert.equal(playerCandidates('win32')[0].command, 'powershell.exe');
});

test('一个都没有时返回 null，并且提示要给出可执行的下一步', () => {
  assert.equal(pickPlayer('linux', () => false), null);

  assert.match(missingPlayerHint('linux'), /mpv/, 'Linux 提示要给出安装建议');
  assert.match(missingPlayerHint('darwin'), /afplay/);
  assert.match(missingPlayerHint('win32'), /阅读视图/, 'Windows 提示要给出替代做法');
});

test('ffplay 的参数包住文件名（避免被解释成选项）', () => {
  const ffplay = playerCandidates('linux').find((p) => p.command === 'ffplay');
  const args = ffplay.args('/tmp/文件.mp3');
  assert.ok(args.includes('-nodisp'));
  assert.equal(args[args.length - 1], '/tmp/文件.mp3');
});
