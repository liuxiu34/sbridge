// 真实 OMP + 应用 HTTP 问答验收。模型端为本机确定性 fixture，执行的 ask 工具、会话保存及 RPC 均为原生 OMP。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-omp-workflow-'));
const profile = path.join(folder, 'profile'), data = path.join(folder, 'data'), cwd = path.join(folder, 'workspace');
for (const dir of [profile, data, cwd]) fs.mkdirSync(dir);
const html = '<form><fieldset><legend>选择方案</legend><label><input type="radio" name="strategy" value="A">方案 A</label><label><input type="radio" name="strategy" value="B">方案 B</label></fieldset><fieldset><legend>选择检查项</legend><label><input type="checkbox" name="checks" value="X">检查 X</label><label><input type="checkbox" name="checks" value="Y">检查 Y</label></fieldset><label>补充说明<textarea name="notes"></textarea></label></form>';
let answeredContent = '', recalled = false, modelRequests = 0;
const modelServer = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); modelRequests++;
    const messages = body.messages || [];
    const lastUser = messages.findLastIndex((m) => m.role === 'user');
    const latest = JSON.stringify(messages[lastUser]?.content || '');
    const tool = messages.slice(lastUser + 1).findLast((m) => m.role === 'tool');
    const wantsRecall = latest.includes('recall');
    let delta, finish;
    if (tool || wantsRecall) {
      if (tool) answeredContent = typeof tool.content === 'string' ? tool.content : JSON.stringify(tool.content);
      if (wantsRecall) recalled = messages.some((m) => m.role === 'tool' && JSON.stringify(m.content).includes('测试说明'));
      delta = { role: 'assistant', content: wantsRecall ? '仍记得方案 B 和测试说明。' : '已收到方案 B、多选检查项和测试说明。' }; finish = 'stop';
    } else {
      assert.ok(body.tools?.some((t) => t.function?.name === 'ask'), '原生 ask 工具未启用');
      delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'call_fixture_' + modelRequests, type: 'function', function: { name: 'ask', arguments: JSON.stringify({ html }) } }] };
      finish = 'tool_calls';
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (part, finish_reason = null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture', choices: [{ index: 0, delta: part, finish_reason }] });
    res.write('data: ' + JSON.stringify(frame(delta)) + '\n\n');
    res.write('data: ' + JSON.stringify(frame({}, finish)) + '\n\n'); res.end('data: [DONE]\n\n');
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
});
await new Promise((r) => modelServer.listen(0, '127.0.0.1', r));
fs.writeFileSync(path.join(profile, 'models.yml'), JSON.stringify({ providers: { qa: {
  baseUrl: `http://127.0.0.1:${modelServer.address().port}/v1`, api: 'openai-completions', apiKey: 'offline-test-placeholder',
  models: [{ id: 'fixture', name: 'Fixture', reasoning: false, contextWindow: 128000, maxTokens: 8192 }],
} } }));
fs.writeFileSync(path.join(profile, 'config.yml'), 'ask:\n  timeout: 1\n'); // 驱动本轮覆盖为不自动提交；测试会故意等超过 1 秒。
fs.writeFileSync(path.join(data, 'board.json'), JSON.stringify({ projects: [], tasks: [{ id: 'qa', title: 'OMP隔离验收', nodes: [{ id: 'omp', tool: 'omp', cwd, file: '', model: 'qa/fixture' }] }] }));
const binary = process.env.SBRIDGE_QA_BINARY;
const child = spawn(binary || process.execPath, [...(binary ? [] : ['src/server.mjs']), '--port=49320'], {
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    SBRIDGE_DATA: data, SBRIDGE_TEST_MODE: '1', SBRIDGE_NO_BROWSER: '1', SBRIDGE_NO_REUSE: '1', PI_CODING_AGENT_DIR: profile },
});
let base, logs = '';
child.stdout.on('data', (d) => { logs += d; const m = logs.match(/SBRIDGE_PORT=(\d+)/); if (m) base = `http://127.0.0.1:${m[1]}`; });
child.stderr.on('data', (d) => { logs += d; });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(route, body, expected = 200) {
  const response = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
}
const snapshot = () => api('/api/tasks/qa/headless-status?nodeId=omp');
async function until(get, predicate, label, timeout = 60_000) {
  const started = Date.now(); let value;
  while (Date.now() - started < timeout) {
    value = await get();
    if (value?.status?.phase === 'failed') throw Error(value.status.stderrTail);
    if (predicate(value)) return value; await delay(100);
  }
  throw Error(label + ' timeout: ' + JSON.stringify(value));
}
const send = (message) => api('/api/tasks/qa/send-headless', { nodeId: 'omp', message });
const question = (previous) => until(snapshot, (s) => s.interactions[0] && s.interactions[0].id !== previous, 'question');
const answer = (s, payload, expected) => api('/api/tasks/qa/nodes/omp/answer', { runId: s.status.runId, interactionId: s.interactions[0].id, ...payload }, expected);
try {
  await until(() => base, Boolean, 'server', 15_000); await send('OMP交互验收');
  let s = await question(); const first = s.interactions[0];
  await delay(1500); assert.equal((await snapshot()).interactions[0].id, first.id, 'OMP 不应自动选默认答案');
  await answer(s, { answers: { answer: ['不存在的选项'] } }, 400);
  await answer(s, { answers: { answer: ['方案 B'] } });
  s = await question(first.id);
  assert.equal(s.interactions[0].kind, 'choices');
  for (const label of ['检查 X', '检查 Y', '完成选择']) {
    const q = s.interactions[0], choice = q.choices.find((c) => c.label.includes(label));
    assert.ok(choice, label); await answer(s, { decision: choice.id }); s = await question(q.id);
  }
  assert.ok(s.interactions[0].questions[0].multiline);
  await answer(s, { answers: { answer: ['测试说明'] } });
  s = await until(snapshot, (state) => state.status?.phase === 'completed', 'complete');
  for (const expected of ['B', 'X', 'Y', '测试说明']) assert.ok(answeredContent.includes(expected), '原生 ask 未回传 ' + expected);
  const firstSession = s.session;
  assert.ok(fs.existsSync(firstSession.file));
  await send('recall');
  s = await until(snapshot, (state) => state.status?.phase === 'completed', 'resume');
  assert.equal(s.session.id, firstSession.id); assert.equal(recalled, true);
  await send('取消问题验收'); s = await question(); await send('队列保留');
  await answer(s, { cancel: true });
  s = await until(snapshot, (state) => !state.status?.running, 'cancel');
  assert.equal(s.status.canceled, true); assert.equal(s.paused, true); assert.equal(s.queue[0].message, '队列保留');
  console.log(JSON.stringify({ passed: true, tool: 'omp', model: 'local deterministic fixture', modelRequests,
    checks: ['native-ask', 'no-auto-answer', 'answer-validation', 'checkbox-fields', 'text-field', 'same-session-resume', 'cancel-pauses-queue'], folder, binary: binary || 'source' }));
} finally {
  fs.writeFileSync(path.join(folder, 'server.log'), logs);
  if (base) await fetch(base + '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => {});
  await new Promise((r) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, r));
  modelServer.closeAllConnections(); await new Promise((r) => modelServer.close(r));
}
