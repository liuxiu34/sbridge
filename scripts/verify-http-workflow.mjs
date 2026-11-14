// 隔离数据 + 真实 Pi RPC + 真实 HTTP/PTY；临时扩展直接回答，不调用模型。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-http-'));
const data = path.join(folder, 'data'), cwd = path.join(folder, 'workspace'), piProfile = path.join(folder, 'pi-profile');
fs.mkdirSync(data); fs.mkdirSync(cwd); fs.mkdirSync(path.join(piProfile, 'extensions'), { recursive: true });
fs.writeFileSync(path.join(piProfile, 'models.json'), JSON.stringify({ providers: { qa: {
  baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', apiKey: 'offline-test-placeholder', models: [{ id: 'qa' }],
} } }));
const answerFile = path.join(folder, 'answers.jsonl');
fs.writeFileSync(path.join(piProfile, 'extensions', 'verify.ts'), `import fs from 'node:fs';
export default function(pi) {
  pi.on('input', async (event, ctx) => {
    const choice = await ctx.ui.select('HTTP 验证选择', ['A', 'B']);
    fs.appendFileSync(${JSON.stringify(answerFile)}, JSON.stringify({ message: event.text, choice }) + '\\n');
    return { action: 'handled' };
  });
}`);
fs.writeFileSync(path.join(data, 'board.json'), JSON.stringify({ projects: [], tasks: [
  { id: 'qa', title: '隔离验证', nodes: ['node', 'terminal'].map((id) => ({ id, tool: 'pi', cwd, file: '', title: id, ...(id === 'node' ? { model: 'qa', modelProvider: 'qa' } : {}) })) },
  { id: 'other', title: '其他任务', nodes: [] },
] }));
const binary = process.env.SBRIDGE_QA_BINARY;
const child = spawn(binary || process.execPath, [...(binary ? [] : ['src/server.mjs']), '--port=49310'], {
  cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, SBRIDGE_DATA: data, SBRIDGE_TEST_MODE: '1', SBRIDGE_NO_REUSE: '1', SBRIDGE_NO_BROWSER: '1', PI_CODING_AGENT_DIR: path.join(folder, 'pi-profile') },
});
let base, output = '';
child.stdout.on('data', (chunk) => { output += chunk; const m = output.match(/SBRIDGE_PORT=(\d+)/); if (m) base = `http://127.0.0.1:${m[1]}`; });
child.stderr.on('data', (chunk) => { output += chunk; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(get, predicate, timeout = 40_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await get(); if (predicate(value)) return value; await sleep(100); }
  throw Error('隔离 HTTP 验证超时');
}
async function api(route, body, expected = 200) {
  const res = await fetch(base + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await res.json(); assert.equal(res.status, expected, JSON.stringify(value)); return value;
}
const status = () => api('/api/tasks/qa/headless-status?nodeId=node');
const send = (message, requestId = randomUUID()) => api('/api/tasks/qa/send-headless', { nodeId: 'node', message, requestId });
const waitQuestion = () => until(status, (s) => { if (s.status?.phase === 'failed') throw Error(s.status.stderrTail); return s.interactions.length > 0; });
async function answer(s) {
  return api('/api/tasks/qa/nodes/node/answer', { runId: s.status.runId, interactionId: s.interactions[0].id, answers: { answer: ['B'] } });
}
try {
  await until(() => base, Boolean, 15_000);
  await api('/api/tasks/other/send-headless', { nodeId: 'node', message: 'wrong-owner' }, 404);
  await api('/api/tasks/qa/send-headless', { nodeId: 'node', message: ' ' }, 400);
  await send('first', 'same-request'); await send('first', 'same-request'); await send('second'); await send('third');
  let s = await waitQuestion();
  assert.equal(s.queue.length, 2);
  await api('/api/tasks/qa/term', { nodeId: 'node', tool: 'pi', cwd }, 409);
  await api('/api/tasks/qa/nodes/node/answer', { runId: s.status.runId, interactionId: s.interactions[0].id, answers: {} }, 400);
  await answer(s);
  s = await until(status, (next) => next.interactions.length && next.status.runId !== s.status.runId);
  await api('/api/tasks/qa/cancel-headless', { nodeId: 'node' });
  s = await status(); assert.equal(s.paused, true); assert.equal(s.queue.length, 1);
  await api('/api/tasks/qa/nodes/node/resume-queue', {});
  await answer(await waitQuestion());
  await until(status, (next) => !next.status.running);
  assert.deepEqual(fs.readFileSync(answerFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l).choice), ['B', 'B']);

  const term = await api('/api/tasks/qa/term', { nodeId: 'terminal', tool: 'pi', cwd, resumeCommand: 'node -e "setInterval(()=>{},1000)"' });
  await api('/api/tasks/qa/send-headless', { nodeId: 'terminal', message: 'blocked' }, 409);
  const reused = await api('/api/tasks/qa/term', { nodeId: 'terminal', tool: 'pi', cwd });
  assert.equal(reused.termId, term.termId);
  await api('/api/terms/kill', { id: term.termId });
  await until(() => api('/api/tasks/qa/headless-status?nodeId=terminal'), (v) => !v.terminal);

  // SSE 读实际临时 JSONL，验证消息不会只停留在驱动回调里。
  const transcript = path.join(folder, 'stream.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'message', timestamp: new Date().toISOString(), message: { role: 'user', content: [{ type: 'text', text: 'SSE验收' }] } }) + '\n');
  const controller = new AbortController();
  try {
    const stream = await fetch(base + `/api/stream?tool=pi&file=${encodeURIComponent(transcript)}`, { signal: controller.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body.getReader();
    const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /SSE验收/);
  } finally { controller.abort(); }
  await send('shutdown'); await send('preserved'); await waitQuestion();
  await api('/api/shutdown', {});
  s = await status(); assert.equal(s.status.running, false); assert.equal(s.queue[0].message, 'preserved');
  const saved = JSON.parse(fs.readFileSync(path.join(data, 'execution-state.json'), 'utf8'));
  assert.equal(saved.find((v) => v.nodeId === 'node').queue[0].message, 'preserved');
  console.log(JSON.stringify({ passed: true, binary: binary || 'source', checks: ['ownership', 'idempotency', 'native-question-answer', 'queue', 'cancel-resume', 'terminal-exclusion', 'terminal-reuse', 'SSE', 'shutdown-persistence'], folder }));
} finally {
  fs.writeFileSync(path.join(folder, 'server.log'), output);
  if (base) await fetch(base + '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
  if (process.platform === 'win32') await new Promise((r) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, r));
  else child.kill();
}
