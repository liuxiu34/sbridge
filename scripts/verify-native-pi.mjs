// 使用真实 Pi RPC 与临时扩展完成选择往返；input 钩子直接处理，不调用模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createExecutionDriver } from '../src/execution-driver.mjs';
import { CliProcess } from '../src/cli-process.mjs';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-native-pi-'));
const extension = path.join(folder, 'question.ts');
const resultFile = path.join(folder, 'answer.json');
fs.writeFileSync(extension, `import fs from 'node:fs';
export default function(pi) {
  pi.on('input', async (_event, ctx) => {
    const choice = await ctx.ui.select('请选择验证方案', ['方案 A', '方案 B']);
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ choice }));
    return { action: 'handled' };
  });
}
`);
let resolveOutcome, rejectOutcome, asked = false;
const outcome = new Promise((resolve, reject) => { resolveOutcome = resolve; rejectOutcome = reject; });
const driver = createExecutionDriver({
  node: { id: 'native-pi-fixture', tool: 'pi', cwd: folder }, runId: 'native-pi-fixture', message: 'test question',
  onSession() {}, onRequestCanceled() {}, onComplete: resolveOutcome,
  onRequest: (q) => {
    asked = true;
    q.respond({ answers: { answer: ['方案 B'] } }).catch(rejectOutcome);
  },
}, { makeProcess: (tool, args, options) => new CliProcess(tool,
  [...args, '--no-session', '--no-extensions', '--extension', extension, '--no-skills', '--no-prompt-templates', '--no-themes'], options) });
const timer = setTimeout(() => rejectOutcome(new Error('Pi 选择往返超过 40 秒')), 40_000);
try {
  await driver.start();
  const result = await outcome;
  assert.equal(result.exitCode, 0, result.stderrTail);
  assert.equal(asked, true);
  assert.equal(JSON.parse(fs.readFileSync(resultFile, 'utf8')).choice, '方案 B');
  console.log(JSON.stringify({ nativeCli: 'pi', questionReceived: true, answerReceivedByCli: '方案 B', modelTurns: 0, passed: true }));
} finally { clearTimeout(timer); await driver.stop(); }
