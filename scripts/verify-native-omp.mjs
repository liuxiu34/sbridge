// 真实 OMP rpc-ui 往返；隔离 input 扩展直接处理消息，不调用模型、不接触用户旧会话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createExecutionDriver } from '../src/execution-driver.mjs';
import { CliProcess } from '../src/cli-process.mjs';

const startedAt = performance.now();
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-native-omp-'));
const profile = path.join(folder, 'profile'); fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile, 'models.yml'), JSON.stringify({ providers: { qa: {
  baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'offline-test-placeholder', models: [{ id: 'fixture' }],
} } }));
const extension = path.join(folder, 'question.ts'), resultFile = path.join(folder, 'answers.json');
fs.writeFileSync(extension, `import fs from 'node:fs';
export default function(pi) {
  pi.on('input', async (_event, ctx) => {
    const choice = await ctx.ui.select('选择方案', [{label:'方案 A',description:'第一项'},{label:'方案 B',description:'第二项'}]);
    const confirmed = await ctx.ui.confirm('确认选择', '继续吗？');
    const text = await ctx.ui.input('补充说明');
    const edited = await ctx.ui.editor('编辑说明', '初稿');
    const multiple = await ctx.ui.askDialog([{id:'multi',question:'选择测试项目',multi:true,options:[{label:'A'},{label:'B'}]}]);
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({choice,confirmed,text,edited,multiple}));
    // OMP 的 InputEventResult 使用 handled 布尔值；Pi 的 action 字段不会拦截模型回合。
    return { handled: true };
  });
}`);
let resolve, reject;
const outcome = new Promise((yes, no) => { resolve = yes; reject = no; });
const methods = [];
const frames = [];
const expectedMethods = ['select', 'confirm', 'input', 'editor', 'ask'];
let modelTurns = 0;
const driver = createExecutionDriver({ node: { id: 'test', tool: 'omp', cwd: folder, model: 'qa/fixture' }, runId: 'native-omp', message: 'fixture',
  onSession() {}, onRequestCanceled() {}, onComplete: resolve,
  onRequest(q) {
    const question = q.view.questions?.[0];
    methods.push(q.view.title);
    const response = q.view.kind === 'approval' ? { decision: 'accept' }
      : { answers: { [question.id]: question.multiSelect ? ['A', 'B'] : question.options.length ? ['方案 B'] : [question.multiline ? '修订稿' : '测试说明'] } };
    q.respond(response).catch(reject);
  },
}, { makeProcess: (tool, args, options) => new CliProcess(tool, [...args,
  '--no-session', '--no-extensions', '--extension', extension, '--no-skills', '--no-rules', '--no-context-files', '--no-title'],
  { ...options, env: { PI_CODING_AGENT_DIR: profile }, onRecord(record) {
    if (['response', 'prompt_result', 'session_settled', 'agent_start', 'agent_end', 'extension_ui_request'].includes(record.type)) {
      frames.push({ type: record.type, id: record.id, command: record.command, method: record.method,
        status: record.status, success: record.success, agentInvoked: record.agentInvoked, sessionSettled: record.sessionSettled,
        data: record.command === 'get_state' ? { isSettled: record.data?.isSettled, isStreaming: record.data?.isStreaming, hasPendingAsyncWork: record.data?.hasPendingAsyncWork } : record.data });
    }
    if (record.type === 'agent_start') {
      modelTurns++;
      reject(Error('OMP input 钩子未拦截消息，意外启动了模型回合'));
    }
    options.onRecord(record);
  } }) });
const timer = setTimeout(() => reject(Error('OMP 原生交互验收超时')), 60_000);
let result;
try {
  await Promise.race([driver.start(), outcome]); result = await outcome;
} finally {
  clearTimeout(timer);
  try { await driver.stop(); }
  finally { fs.writeFileSync(path.join(folder, 'frames.json'), JSON.stringify(frames, null, 2)); }
}
// 进程退出后再核对完整帧记录，成功日志也包含清理耗时。
assert.equal(result.exitCode, 0, result.stderrTail);
assert.equal(modelTurns, 0, '原生 UI 验收不得启动模型回合');
assert.equal(methods.length, expectedMethods.length);
assert.deepEqual(frames.filter((r) => r.type === 'extension_ui_request' && expectedMethods.includes(r.method)).map((r) => r.method), expectedMethods);
// rpc-mode.ts 的 local 分支只回复 agentInvoked:false，不会另发 prompt_result。
const promptResponse = frames.find((r) => r.type === 'response' && r.command === 'prompt');
assert.equal(promptResponse?.success, true);
assert.equal(promptResponse?.data?.agentInvoked, false, 'input 钩子必须通过本地完成响应结束');
const actual = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
assert.equal(actual.choice, '方案 B'); assert.equal(actual.confirmed, true);
assert.equal(actual.text, '测试说明'); assert.equal(actual.edited, '修订稿');
assert.deepEqual(actual.multiple.results[0].selectedOptions, ['A', 'B']);
const elapsedMs = Math.round(performance.now() - startedAt);
assert.ok(elapsedMs < 60_000, 'OMP 原生交互验收须在 60 秒内完成');
console.log(JSON.stringify({ passed: true, nativeCli: 'omp', dialogs: methods.length, checks: ['select', 'confirm', 'input', 'editor', 'ask-multi'], modelTurns, elapsedMs, folder }));
