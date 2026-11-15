// 复现验收：工作轨迹页最大化时「先冒顶再滑到底」的跳变（用户无操作）。
// 夹具与 ui-workbench.cjs 同源：真实前端 + 独立 HTTP/SSE，不接触用户会话。
// 用法：npx electron scripts/ui-maximize-jump.cjs [--baseline]
// --baseline 不加载候选修复（window.__sbNoStreamReflowGuard），用于确认复现。
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const baseline = process.argv.includes('--baseline');
const output = process.env.SBRIDGE_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-maxjump-'));
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-maxjump-profile-')));
app.disableHardwareAcceleration();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const projects = [{ id: 'p1', name: 'sbridge', cwd: 'C:/fixture/sbridge' }];
const nodes = [{ id: 'n1', tool: 'claude', title: '最大化滚动复现', cwd: projects[0].cwd, file: 'fixture-maxjump.jsonl', sessionId: 'session-1', createdAt: '2026-11-15T09:00:00Z', summary: { messageCount: 60 } }];
const task = { id: 't1', projectId: 'p1', project: projects[0], title: '最大化跳变复现', updatedAt: '2026-11-15T09:00:00Z', nodes };
const tasks = [{ ...task, nodes: undefined, nodeCount: 1, updatedAt: task.updatedAt }];
// 30 段消息：正文带代码块与 mermaid 图（贴近真实渲染负载），撑出真实长会话滚动量
const history = [];
const MERMAID_SRC = 'graph LR\nA[输入] --> B{渲染}\nB --> C[滚动]\nC --> D[稳定]';
for (let i = 0; i < 30; i++) {
  history.push({ kind: 'user', text: `第 ${i + 1} 轮：请继续检查最大化时的滚动行为。` });
  history.push({ kind: 'assistant', text: `第 ${i + 1} 轮回复：收到。\n\n\`\`\`js\nconst el = document.querySelector('[data-role="streamscroll"]');\nel.scrollTop = el.scrollHeight; // 保持贴底\n\`\`\`\n\n\`\`\`mermaid\n${MERMAID_SRC}\n\`\`\`\n\n当前滚动位置应保持稳定，不因窗口尺寸变化而跳变。` });
}
history.forEach((e, i) => { e.ts = new Date(Date.UTC(2026, 10, 15, 9, 0, i)).toISOString(); });
let status = { status: { running: false, phase: 'idle' }, queue: [], interactions: [] };
let server, win, wss;
const errors = [];
function fixture(url, method, body) {
  const p = url.pathname;
  if (method === 'POST') return { ok: true };
  if (p === '/api/state') return { projects, tasks };
  if (p === '/api/tools') return { tools: ['claude'].map(id => ({ id, label: id, modes: [] })) };
  if (p === '/api/terms') return { terms: [] };
  if (p === '/api/tasks/t1') return task;
  if (p.endsWith('/headless-status')) return status;
  if (p.endsWith('/model')) return { current: 'claude-sonnet-4-6', options: [{ id: 'claude-sonnet-4-6', provider: 'Anthropic' }], effort: { supported: false } };
  if (p.endsWith('/subagents')) return { sessions: [], fix: {} };
  if (p.endsWith('/usage')) return { ctx: { used: 18240, window: 200000, source: 'session', model: 'claude-sonnet-4-6' } };
  if (p.endsWith('/project-state')) return { project: { cwd: projects[0].cwd, branch: 'ui/maxjump', dirtyCount: 0, isGit: true, dirty: [], recentCommits: [] } };
  if (p.endsWith('/files')) return { dir: url.searchParams.get('path') || '', entries: [] };
  return { ok: true };
}
app.whenReady().then(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      history.forEach(e => res.write(`data: ${JSON.stringify(e)}\n\n`));
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      let raw = ''; for await (const c of req) raw += c;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(fixture(url, req.method, raw ? JSON.parse(raw) : {})));
    }
    const file = path.join(root, 'src/web', url.pathname === '/' ? 'index.html' : url.pathname);
    try {
      res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
      let data = fs.readFileSync(file);
      if (url.pathname === '/') data = data.toString().replace('<body>', `<body><script>window.qaErrors=[];addEventListener("error",e=>qaErrors.push(e.message));addEventListener("unhandledrejection",e=>qaErrors.push(String(e.reason)));${baseline ? 'window.__sbNoStreamReflowGuard=true;' : ''}</script>`);
      res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  wss = new WebSocketServer({ server });
  wss.on('connection', () => { });
  win = new BrowserWindow({ width: 980, height: 700, show: true, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const ev = code => win.webContents.executeJavaScript(code, true);
  await ev(`openSessionTab('n1')`);
  await ev(`new Promise(r => setTimeout(r, 500))`); // 等 SSE 回放 + 250ms 首批渲染
  const s = () => ev(`(() => { const el = document.querySelector('[data-role="streamscroll"]'); return { top: el.scrollTop, h: el.scrollHeight, ch: el.clientHeight }; })()`);
  const before = await s();
  // 确认在底部（首批渲染后 toBottom 已执行）
  assert.ok(before.h - before.top - before.ch < 80, `setup: should start at bottom, got ${JSON.stringify(before)}`);
  // 核心复现：最大化。采样 60 帧 scrollTop，捕获任何「远离底部」的中间态。
  await ev(`new Promise(r => { window.__sbSamples = []; const el = document.querySelector('[data-role="streamscroll"]'); const t0 = performance.now(); const tick = () => { window.__sbSamples.push(Math.round(el.scrollTop)); if (performance.now() - t0 < 1200) requestAnimationFrame(tick); else r(); }; requestAnimationFrame(tick); })`);
  win.maximize();
  await ev(`new Promise(r => setTimeout(r, 1300))`);
  const samples = await ev(`window.__sbSamples`);
  const after = await s();
  // 判定：采样序列里不得出现远离底部的值（>250px 以上视为跳到上部；正常偏差只有几像素）
  const atBottom = t => after.h - t - after.ch < 80;
  const jumps = samples.filter(t => !atBottom(t) && (before.h - t - before.ch > 250 || after.h - t - after.ch > 250));
  fs.writeFileSync(path.join(output, 'samples.json'), JSON.stringify({ baseline, before, after, samples, jumps }, null, 2));
  const shot = async (name) => { await sleep(180); await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))'); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  await shot(baseline ? 'baseline-after-maximize' : 'fixed-after-maximize');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    passed: true, baseline, mode: baseline ? 'BASELINE(未加载修复)' : 'FIXED',
    before, after, sampleCount: samples.length, jumpFrames: jumps.length,
    jumpValues: jumps.slice(0, 6), output
  }));
  win.destroy(); wss.clients.forEach(c => c.terminate()); wss.close(); server.closeAllConnections(); server.close(); app.exit(0);
}).catch(error => { console.error(error); win?.destroy(); wss?.clients.forEach(c => c.terminate()); wss?.close(); server?.closeAllConnections?.(); server?.close(); app.exit(1); });
