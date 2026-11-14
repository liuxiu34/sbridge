// 安装版验收：读取原有看板和会话，不发送消息；仅通过本地调试端口检查真实窗口。
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
const require = createRequire(import.meta.url), asar = require('@electron/asar');
const installation = path.join(process.env.LOCALAPPDATA, 'Programs/sbridge');
const dataDir = path.join(process.env.APPDATA, 'sbridge/data');
const output = path.resolve('../research/workflow-audit-20261114');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const initialBoard = fs.readFileSync(path.join(dataDir, 'board.json'));
const board = JSON.parse(initialBoard);
const installedPackage = JSON.parse(asar.extractFile(path.join(installation, 'resources/app.asar'), 'package.json'));
assert.equal(installedPackage.version, JSON.parse(fs.readFileSync('package.json', 'utf8')).version);
assert.equal(sha(asar.extractFile(path.join(installation, 'resources/app.asar'), 'src/electron-main.cjs')), sha(fs.readFileSync('src/electron-main.cjs')));
assert.equal(sha(fs.readFileSync(path.join(installation, 'resources/sbridge/sbridge.exe'))), sha(fs.readFileSync('dist/sbridge.exe')));
const env = { ...process.env, SBRIDGE_TEST_MODE: '1' }; delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(installation, 'sbridge.exe'), ['--remote-debugging-port=49311'], { env, windowsHide: true, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let socket, base, nextId = 0;
const pending = new Map();
async function rpc(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(method + ' timeout')); }, 15_000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
  return result.result.value;
}
try {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try { target = (await (await fetch('http://127.0.0.1:49311/json')).json()).find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:/.test(t.url)); } catch {}
    if (!target) await sleep(200);
  }
  assert.ok(target, '安装版窗口未就绪'); base = new URL(target.url).origin;
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', (message) => {
    const record = JSON.parse(message); const p = pending.get(record.id); if (!p) return;
    clearTimeout(p.timer); pending.delete(record.id); record.error ? p.reject(Error(record.error.message)) : p.resolve(record.result);
  });
  let loaded = false;
  for (let i = 0; i < 80 && !loaded; i++) {
    loaded = await evaluate(`document.readyState === 'complete' && typeof openTask === 'function'`);
    if (!loaded) await sleep(200);
  }
  assert.ok(loaded, '安装版页面脚本未加载完成');
  await evaluate(`window.installedErrors=[];window.addEventListener('error',e=>installedErrors.push(e.message));void 0;`);
  const task = board.tasks.find((t) => t.nodes.some((n) => n.cwd?.toLowerCase() === process.cwd().toLowerCase() && n.file && fs.existsSync(n.file)))
    || board.tasks.find((t) => t.nodes.some((n) => n.file && fs.existsSync(n.file)));
  assert.ok(task);
  const node = [...task.nodes].reverse().find((n) => n.file && fs.existsSync(n.file));
  await evaluate(`(async()=>{await openTask(${JSON.stringify(task.id)});openSessionTab(${JSON.stringify(node.id)});return true})()`);
  await sleep(2200);
  const ui = await evaluate(`(()=>{const h=document.querySelector('.pane-host.focused')||document;const input=h.querySelector('[data-role="input"]');const r=input?.getBoundingClientRect();return {inputVisible:!!r&&r.height>0&&r.bottom<=innerHeight,interactionPanel:!!h.querySelector('[data-role="interactions"]'),timeline:!!h.querySelector('[data-role="list"]')&& !h.querySelector('[data-role="streamscroll"]').hidden,errors:installedErrors,width:innerWidth,height:innerHeight}})()`);
  assert.equal(ui.inputVisible, true); assert.equal(ui.interactionPanel, true); assert.equal(ui.timeline, true); assert.deepEqual(ui.errors, []);
  const resources = ['index.html', 'app.css', 'js/pane.js', 'js/interactions.js', 'js/stream.js'];
  for (const resource of resources) {
    const response = await fetch(base + '/' + resource); assert.equal(response.status, 200);
    assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(fs.readFileSync(path.join('src/web', resource))), resource);
  }
  const snapshot = await (await fetch(base + `/api/tasks/${task.id}/headless-status?nodeId=${node.id}`)).json();
  assert.ok(Array.isArray(snapshot.interactions)); assert.equal(snapshot.session.id, node.sessionId);
  assert.equal(sha(fs.readFileSync(path.join(dataDir, 'board.json'))), sha(initialBoard), '看板数据发生了变化');
  const screenshot = await rpc('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: Math.max(0, ui.height - 200), width: ui.width, height: 200, scale: 1 } });
  fs.writeFileSync(path.join(output, 'installed-composer.png'), Buffer.from(screenshot.data, 'base64'));
  const result = { passed: true, version: installedPackage.version, installation, base, resourcesMatched: resources.length,
    projects: board.projects.length, tasks: board.tasks.length, nodes: board.tasks.flatMap((t) => t.nodes).length,
    boardUnchanged: true, actualWindow: ui, boardSHA256: sha(initialBoard) };
  fs.writeFileSync(path.join(output, 'installed-verification.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  socket?.close();
  if (base) await fetch(base + '/api/shutdown', { method: 'POST', signal: AbortSignal.timeout(15_000) }).catch(() => {});
  await new Promise((r) => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, r));
}
