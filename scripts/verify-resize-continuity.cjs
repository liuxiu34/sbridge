// 真实 xterm / FitAddon / mountTerm + 逐帧采样；360ms 延迟重绘，不启动模型 CLI、不读用户数据。
// electron scripts/verify-resize-continuity.cjs [--baseline] [--native]
// --native 使用隔离 sbridge 服务和真实 ConPTY 长历史；默认使用可控的屏幕重绘夹具。
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { WebSocketServer, WebSocket } = require('ws');
const root = path.resolve(__dirname, '..');
const output = process.env.SBRIDGE_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-resize-'));
const baselineOnly = process.argv.includes('--baseline');
const native = process.argv.includes('--native');
// 普通隐藏窗口用于原生最大化验收；离屏模式额外核验像素，避免 capturePage 返回旧合成帧。
const offscreen = process.argv.includes('--offscreen');
const delay = 360;
// POSIX 上的模拟也使用现代 ConPTY 的已知能力边界；真实后端验收另有脚本。
const windowsPty = { backend: 'conpty', buildNumber: process.platform === 'win32' ? Number(os.release().split('.')[2]) : 21376 };
fs.mkdirSync(output, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-resize-profile-')));
app.disableHardwareAcceleration();
// 隐藏窗口会被 Windows 原生遮挡检测把合成帧节流到 ~1fps，导致逐帧采样断言依赖主进程
// 偶发的强制合成。这里只影响测试宿主窗口的帧调度，不改变任何被验证的产品行为。
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('window-all-closed', () => {});
let server, wss, win, ev, cdpDebugger, nativeFixture, metadata = true, terms = [], seq = 0;
const timers = new Set(), results = [], requests = [];
const nativeChunks = [], upstreams = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const diagnostics = { drag: null, screenshots: {}, consoleMessages: [] };
const summary = t => ({ id: t.id, nodeId: t.nodeId, tool: t.tool, running: true, cols: t.cols, rows: t.rows, ...(metadata ? { windowsPty } : {}) });

function rendererHarness() {
  const qa = window.qa = { frames: [], recording: false, errors: [], handle: null };
  addEventListener('error', e => qa.errors.push(e.message));
  addEventListener('unhandledrejection', e => qa.errors.push(String(e.reason)));
  qa.input = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'mousedown', 'mousemove', 'mouseup', 'mouseover', 'mouseleave']) addEventListener(type, e => qa.input.push({ type,
    buttons: e.buttons, button: e.button, x: e.clientX, y: e.clientY, defaultPrevented: e.defaultPrevented,
    target: e.target instanceof Element ? `${e.target.tagName}.${String(e.target.className).slice(0, 60)}` : String(e.target) }), true);
  qa.scrollbarProbe = () => {
    const bar = document.querySelector('.xterm .scrollbar.vertical');
    const slider = bar?.querySelector('.slider');
    if (!bar || !slider) return { barFound: !!bar, sliderFound: !!slider };
    const r = slider.getBoundingClientRect();
    const center = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    const hit = document.elementFromPoint(center.x, center.y);
    return { barClass: bar.className, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, center,
      barPointerEvents: getComputedStyle(bar).pointerEvents, sliderPointerEvents: getComputedStyle(slider).pointerEvents,
      hit: hit ? `${hit.tagName}.${String(hit.className).slice(0, 60)}` : null,
      hitIsSlider: hit === slider, hitInsideBar: hit ? bar.contains(hit) : false };
  };
  qa.takeInput = () => qa.input.splice(0);
  qa.snapshot = (event = 'sample') => {
    const t = window.__sbLastMountTerm;
    if (!t) return null;
    const b = t.buffer.active;
    return { event, ms: performance.now(), cols: t.cols, rows: t.rows, type: b.type,
      baseY: b.baseY, viewportY: b.viewportY, cursorY: b.cursorY, length: b.length,
      topLine: b.getLine(b.viewportY)?.translateToString(true),
      renderedTop: document.querySelector('.xterm-rows > div')?.textContent,
      oldest: b.getLine(0)?.translateToString(true), windowsPty: { ...t.options.windowsPty } };
  };
  qa.record = event => { if (qa.recording) qa.frames.push(qa.snapshot(event)); };
  const realFit = FitAddon.FitAddon.prototype.fit;
  FitAddon.FitAddon.prototype.fit = function () { realFit.call(this); qa.record('just-fit'); };
  const RealWebSocket = window.WebSocket;
  window.WebSocket = class extends RealWebSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener('message', e => {
        if (e.data !== '\0REPLAY_DONE\0') qa.record('pty-arrived-before-parse');
      });
    }
  };
  qa.start = () => {
    qa.frames = []; qa.recording = true; qa.record('before');
    const frame = () => { if (qa.recording) { qa.record('raf'); requestAnimationFrame(frame); } };
    requestAnimationFrame(frame);
  };
  qa.stop = () => { qa.record('after'); qa.recording = false; return qa.frames; };
  qa.mount = async (node, route) => {
    qa.handle?.dispose(); nodeTermBindings.clear();
    state.terms = route === 'list' ? (await api('/api/terms')).terms : [];
    qa.handle = await mountTerm(document.querySelector('#host'), node);
    __sbLastMountTerm.onRender(() => qa.record('render'));
    __sbLastMountTerm.onWriteParsed(() => qa.record('parsed'));
  };
}

const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/vendor/xterm.css">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#fdf6e3}.term-view{position:fixed;inset:0}#host{height:100%;width:100%}</style>
</head><body><section class="term-view"><div id="host"></div></section>
<script src="/vendor/xterm.js"></script><script src="/vendor/addon-fit.js"></script>
<script>const currentTask={id:'fixture'},state={terms:[]};
const theme={liveTerms:new Set(),xtermTheme:()=>({background:'#fdf6e3',foreground:'#333333'})};
const toolLabel=t=>t,renderTabs=()=>{},renderBoard=()=>{},toast=e=>{throw Error(e)};
async function api(url,options={}){const res=await fetch(url,{...options,headers:{'content-type':'application/json'},body:options.body?JSON.stringify(options.body):undefined});if(!res.ok)throw Error(await res.text());return res.json();}
</script><script src="/js/term.js"></script><script>(${rendererHarness.toString()})()</script></body></html>`;

async function until(code, message = code, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await ev(code)) return; await sleep(20); }
  throw Error(`Timeout: ${message}`);
}

function connect(socket, req) {
  const t = terms.find(t => req.url === `/ws/term/${t.id}`);
  if (!t) { socket.close(); return; }
  t.socket = socket;
  if (native) {
    const upstream = t.upstream = new WebSocket(nativeFixture.base.replace('http:', 'ws:') + req.url);
    upstreams.add(upstream);
    let releaseAt = 0, queue = [], flushing = null;
    const writes = [];
    upstream.on('open', () => writes.splice(0).forEach(data => upstream.send(data)));
    upstream.on('error', error => { t.error = error.message; socket.close(); });
    upstream.on('message', raw => {
      const text = raw.toString();
      nativeChunks.push({ id: t.id, receivedAt: Date.now(), held: Date.now() < releaseAt, text });
      if (Date.now() < releaseAt || flushing) {
        queue.push(text);
        if (!flushing) {
          flushing = setTimeout(() => {
            timers.delete(flushing); flushing = null;
            if (socket.readyState === 1) queue.splice(0).forEach(data => socket.send(data));
          }, Math.max(0, releaseAt - Date.now()));
          timers.add(flushing);
        }
      } else if (socket.readyState === 1) socket.send(text);
    });
    socket.on('message', raw => {
      const data = raw.toString();
      let size;
      try { size = JSON.parse(data).resize; } catch { t.inputs.push(data); }
      if (size) {
        t.resizes.push(size);
        if (t.cols !== size.cols || t.rows !== size.rows) releaseAt = Date.now() + delay;
        t.cols = size.cols; t.rows = size.rows;
      }
      if (upstream.readyState === 1) upstream.send(data); else writes.push(data);
    });
    socket.on('close', () => { upstream.close(); upstreams.delete(upstream); });
    return;
  }
  socket.send(t.buffer); socket.send('\0REPLAY_DONE\0');
  socket.on('message', raw => {
    const data = raw.toString();
    let size;
    try { size = JSON.parse(data).resize; } catch { t.inputs.push(data); return; }
    if (!size) return;
    t.resizes.push(size);
    if (size.cols === t.cols && size.rows === t.rows) return;
    const oldRows = t.rows;
    t.cols = size.cols; t.rows = size.rows;
    // ConPTY 的增长语义：活动屏幕的首行保持，下面补空行；不把 scrollback 拉回来。
    const active = t.alternate || t;
    if (t.rows >= oldRows) active.screen.push(...Array(t.rows - oldRows).fill(''));
    else {
      const removed = Math.max(0, active.cursorY - t.rows + 1);
      active.screen = active.screen.slice(removed, removed + t.rows);
      active.cursorY = Math.min(active.cursorY, t.rows - 1);
    }
    const repaint = '\x1b[H' + active.screen.map(line => '\x1b[2K' + line).join('\r\n') + `\x1b[${active.cursorY + 1};1H`;
    const timer = setTimeout(() => {
      timers.delete(timer);
      t.buffer += repaint;
      if (socket.readyState === 1) socket.send(repaint);
    }, delay);
    timers.add(timer);
  });
}

async function mount(node, route = 'create') {
  await ev(`qa.mount(${JSON.stringify(node)},${JSON.stringify(route)})`);
  await until(`qa.snapshot().baseY > 100 && document.querySelector('.xterm-rows').textContent.includes('READY>')`);
  await sleep(130);
}

async function resize(name, action) {
  await ev('qa.start()');
  action();
  await until(`qa.frames.some(f=>f.event==='just-fit')`, name + ' fit');
  await sleep(100);
  // capturePage 是异步的；同时记录请求前和完成后的状态。跨过重绘的截图不能
  // 冒充重绘前证据，连续性断言始终依据带时刻的 renderer / rAF 采样。
  const pendingShot = await ev('({ state: qa.snapshot("pending-shot"), delayedRepaintSeen: qa.frames.some(f=>f.event==="pty-arrived-before-parse") })');
  const captured = await win.webContents.capturePage();
  const completedShot = await ev('({ state: qa.snapshot("capture-complete"), delayedRepaintSeen: qa.frames.some(f=>f.event==="pty-arrived-before-parse") })');
  const capture = { requested: pendingShot, completed: completedShot,
    phase: !completedShot.delayedRepaintSeen ? 'before-redraw' : pendingShot.delayedRepaintSeen ? 'after-redraw' : 'spans-redraw' };
  fs.writeFileSync(path.join(output, name + '-capture.json'), JSON.stringify(capture, null, 2));
  diagnostics.screenshots[name] = capture;
  fs.writeFileSync(path.join(output, name + '-capture.png'), captured.toPNG());
  await until(`qa.frames.some(f=>f.event==='pty-arrived-before-parse')`, name + ' delayed repaint');
  await sleep(100);
  const frames = await ev('qa.stop()');
  const before = frames[0], fit = frames.find(f => f.event === 'just-fit');
  const arrival = frames.find(f => f.event === 'pty-arrived-before-parse');
  const pending = frames.filter(f => f.event === 'raf' && f.ms > fit.ms && f.ms < arrival.ms);
  const after = frames.at(-1);
  const r = { name, before, fit, arrival, after, pendingShot, pendingFrameCount: pending.length,
    upstreamDelayMs: arrival.ms - fit.ms, pulledHistory: pending.some(f => f.topLine !== before.topLine),
    renderedHistoryChanged: pending.some(f => f.renderedTop !== before.renderedTop), frames };
  results.push(r);
  assert.ok(pending.length >= 3, name + ' must observe multiple frames before PTY redraw');
  assert.ok(r.upstreamDelayMs >= delay - 20, name + ' repaint was not delayed');
  fs.writeFileSync(path.join(output, name + '-after.png'), (await win.webContents.capturePage()).toPNG());
  return r;
}

async function heightCase(tool, route, legacy = false) {
  const name = `${legacy ? 'legacy' : tool}-${route}-height`;
  metadata = !legacy;
  win.setContentSize(980,440);
  await ev('qa.handle?.dispose(); qa.handle=null;');
  if (native) {
    for (const term of terms) await fetch(nativeFixture.base + '/api/terms/kill', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: term.id }),
    });
  }
  terms = [];
  const node = native ? nativeFixture.nodes.find(n => n.id === name) : { id: name, tool, cwd: 'fixture' };
  await mount(node);
  const created = terms[0].id;
  if (route !== 'create') await mount(node, route);
  assert.equal(terms.length, 1, route + ' must reuse the same PTY');
  assert.equal(terms[0].id, created);
  const r = await resize(name, () => win.setContentSize(980,660));
  assert.equal(r.before.cursorY, r.before.rows - 1, 'cursor starts on last row');
  assert.equal(r.before.baseY, r.before.viewportY, 'starts following bottom');
  assert.equal(r.before.cols, r.fit.cols, 'height-only resize');
  assert.ok(r.fit.rows > r.before.rows);
  if (legacy) {
    assert.ok(r.fit.baseY < r.before.baseY, 'legacy must pull history during fit');
    assert.equal(r.pulledHistory, true, 'legacy must visibly expose older lines in intermediate frames');
    assert.equal(r.renderedHistoryChanged, true, 'legacy DOM renderer must display the jump');
    assert.equal(r.after.topLine, r.before.topLine, 'legacy must jump back on delayed redraw');
  } else {
    assert.equal(r.before.windowsPty.backend, 'winpty', route + ' must mark non-conpty to disable local reflow');
    assert.equal(r.fit.baseY, r.before.baseY, 'Windows fit must keep the screen base');
    assert.equal(r.pulledHistory, false, name + ' showed old history before repaint');
    assert.equal(r.renderedHistoryChanged, false, name + ' rendered an old history line before repaint');
    assert.equal(r.after.topLine, r.before.topLine);
    assert.equal(r.after.oldest, 'HISTORY_000', 'history must survive');
    assert.ok(r.frames.filter(f => f.event === 'raf').every(f => f.baseY === f.viewportY), name + ' lost bottom-follow between frames');
  }
  return r;
}

async function finish(code, error) {
  for (const timer of timers) clearTimeout(timer);
  const report = { passed: code === 0, baselineOnly, native, offscreen, delay, windowsPty, diagnostics,
    source: path.join(root, 'src/web/js/term.js'), error: error?.stack, results, requests };
  fs.writeFileSync(path.join(output, 'resize-continuity.json'), JSON.stringify(report, null, 2));
  if (native) fs.writeFileSync(path.join(output, 'native-conpty-chunks.json'), JSON.stringify(nativeChunks, null, 2));
  console.log(JSON.stringify({ passed: report.passed, output, error: error?.message,
    results: results.map(({ name, before, fit, after, pulledHistory, pendingFrameCount }) => ({ name,
      before: [before.baseY, before.viewportY, before.topLine], fit: [fit.baseY, fit.viewportY, fit.topLine],
      after: [after.baseY, after.viewportY, after.topLine], pulledHistory, pendingFrameCount })) }));
  try { cdpDebugger?.detach(); } catch {} win?.destroy(); wss?.clients.forEach(s => s.terminate()); upstreams.forEach(s => s.terminate());
  wss?.close(); server?.closeAllConnections(); server?.close();
  await nativeFixture?.close();
  app.exit(code);
}

(async () => {
  if (native) {
    assert.equal(process.platform, 'win32', '--native acceptance expects Windows ConPTY');
    const { startPtyResizeFixture } = await import('./fixtures/pty-resize-fixture.mjs');
    nativeFixture = await startPtyResizeFixture(output);
  }
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ method: req.method, path: url.pathname, nodeId: body.nodeId });
      res.setHeader('content-type', 'application/json');
      if (native) {
        const response = await fetch(nativeFixture.base + url.pathname, {
          method: req.method, headers: { 'content-type': 'application/json' }, ...(raw ? { body: raw } : {}),
        });
        const value = await response.json();
        if (response.ok && value.termId && !terms.some(t => t.id === value.termId)) {
          terms.push({ id: value.termId, nodeId: body.nodeId, tool: body.tool,
            cols: value.cols, rows: value.rows, resizes: [], inputs: [] });
        }
        // 对照只模拟 1.3.2 没有传递 metadata 的传输契约，实际 ConPTY 与其输出不变。
        if (!metadata) { delete value.windowsPty; value.terms?.forEach(t => delete t.windowsPty); }
        res.statusCode = response.status;
        return res.end(JSON.stringify(value));
      }
      if (req.method === 'GET') return res.end(JSON.stringify({ terms: terms.map(summary) }));
      let t = terms.find(t => t.nodeId === body.nodeId);
      const reused = !!t;
      if (!t) {
        const lines = [...Array.from({ length: 240 }, (_, i) => `HISTORY_${String(i).padStart(3, '0')}`), 'READY>'];
        t = { id: `t${++seq}`, nodeId: body.nodeId, tool: body.tool, cols: body.cols, rows: body.rows,
          inputs: [], resizes: [], cursorY: body.rows - 1, screen: lines.slice(-body.rows), buffer: lines.join('\r\n') };
        terms.push(t);
      }
      return res.end(JSON.stringify({ termId: t.id, resumed: reused, ...summary(t) }));
    }
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(html); }
    const file = path.join(root, 'src/web', url.pathname);
    res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript');
    try { res.end(fs.readFileSync(file)); } catch { res.writeHead(404); res.end(); }
  });
  wss = new WebSocketServer({ server }); wss.on('connection', connect);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await app.whenReady();
  win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen } });
  win.setMenu(null);
  win.webContents.on('console-message', (e, level, message, line, sourceId) => diagnostics.consoleMessages.push({ level, message, sourceId, line }));
  cdpDebugger = win.webContents.debugger;
  await cdpDebugger.attach();
  ev = code => win.webContents.executeJavaScript(code, true);
  await win.loadURL(`http://127.0.0.1:${server.address().port}/`);
  await heightCase('codex', 'create', true);
  if (!baselineOnly) {
    for (const tool of ['pi', 'codex', 'claude', 'omp']) {
      for (const route of ['create', 'list', 'reuse']) await heightCase(tool, route);
    }
    const mixed = await resize('width-and-height', () => win.setContentSize(1150,820));
    assert.equal(mixed.pulledHistory, false, 'simultaneous width/height change');
    await resize('restore', () => win.setContentSize(900,500));
    const maximized = await resize('maximize', () => win.maximize());
    assert.equal(win.isMaximized(), true, 'must use native window maximize');
    assert.ok(maximized.fit.cols !== maximized.before.cols || maximized.fit.rows !== maximized.before.rows);
    if (maximized.fit.rows >= maximized.before.rows) assert.equal(maximized.pulledHistory, false, 'maximize showed older history');
    await resize('unmaximize', () => win.unmaximize());
    await ev(`document.querySelector('.term-view').dispatchEvent(new WheelEvent('wheel',{deltaY:-360,bubbles:true,cancelable:true}));`);
    const reading = await resize('reading-history', () => win.setContentSize(1000,700));
    assert.ok(reading.before.viewportY < reading.before.baseY);
    assert.equal(reading.pulledHistory, false, 'history anchor moved during fit');
    assert.equal(reading.after.topLine, reading.before.topLine, 'repaint pulled reader to bottom');
    assert.ok(reading.after.viewportY < reading.after.baseY);
    const count = terms[0].resizes.length;
    await ev(`for(let i=0;i<5;i++)dispatchEvent(new Event('resize'));`);
    await sleep(250);
    assert.equal(terms[0].resizes.length, count, 'unchanged geometry must not resize PTY');
    // 通过 xterm 原生滚动条拖动回看，并让延迟重绘抵达；不能被写队列强制贴底。
    // xterm 6 的滚动条来自 VS Code ScrollableElement：visibility=auto，未悬停时是
    // `.invisible`（opacity:0 + pointer-events:none）；滑块用 pointerdown + setPointerCapture
    // 跟踪，且每次 pointermove 都要求 e.buttons 与按下时一致。sendInputEvent 的 mouseMove
    // 携带不了按下按钮位（诊断实记：pointerdown buttons=1、后续 pointermove buttons=0，
    // GlobalPointerMoveMonitor 立即 stopMonitoring）。因此用 CDP Input.dispatchMouseEvent
    // 注入带 buttons 状态的真实 Chromium 鼠标事件完成拖拽：悬停 reveal → 按下 →
    // 分段按住移动 → 释放；不调用任何滚动函数冒充拖拽。
    await ev('qa.handle.scrollToBottom();qa.handle.focus();');
    await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const dragStart = await ev('qa.snapshot("drag-start")');
    const slider = await ev(`(()=>{const s=document.querySelector('.xterm .scrollbar.vertical .slider');const r=s.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    const dragInput = async params => cdpDebugger.sendCommand('Input.dispatchMouseEvent', { pointerType: 'mouse', ...params });
    await dragInput({ type: 'mouseMoved', x: 300, y: 300, buttons: 0 });
    await sleep(60);
    await dragInput({ type: 'mouseMoved', x: slider.x, y: slider.y, buttons: 0 });
    await sleep(120);
    await ev('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const hoverProbe = await ev('qa.scrollbarProbe()');
    assert.equal(hoverProbe.hitIsSlider, true, `slider must be hit-testable before drag: ${JSON.stringify(hoverProbe)}`);
    await dragInput({ type: 'mousePressed', x: slider.x, y: slider.y, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(60);
    for (let step = 1; step <= 4; step++) {
      await dragInput({ type: 'mouseMoved', x: slider.x, y: slider.y - step * 25, button: 'left', buttons: 1 });
      await sleep(40);
    }
    await sleep(60);
    await dragInput({ type: 'mouseReleased', x: slider.x, y: slider.y - 100, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(60);
    diagnostics.drag = { method: 'CDP Input.dispatchMouseEvent', start: dragStart, hover: hoverProbe, events: await ev('qa.takeInput()'), end: await ev('qa.snapshot("drag-end")') };
    await until('qa.snapshot().viewportY < qa.snapshot().baseY',
      `native scrollbar drag: ${JSON.stringify(diagnostics.drag)}`);
    const dragged = await resize('dragged-history', () => win.setContentSize(1020,760));
    assert.equal(dragged.after.topLine, dragged.before.topLine, 'dragged history pulled to bottom');
    assert.ok(dragged.after.viewportY < dragged.after.baseY);
    await ev('qa.handle.focus();');
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'x' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'x' });
    await sleep(80);
    assert.ok(terms[0].inputs.join('').includes('x'), 'native input must reach PTY socket');
    if (native) terms[0].upstream.send('\x02');
    else {
      terms[0].alternate = { screen: ['Native picker', ...Array(terms[0].rows - 1).fill('')], cursorY: 0 };
      terms[0].socket.send('\x1b[?1049h\x1b[2J\x1b[HNative picker');
    }
    await until(`qa.snapshot().type==='alternate'`);
    const alternate = await resize('alternate', () => win.setContentSize(980,600));
    assert.equal(alternate.after.type, 'alternate');
    assert.equal(alternate.after.baseY, 0);
    assert.equal(alternate.after.topLine, 'Native picker');
    if (native) terms[0].upstream.send('\x04');
    else { terms[0].alternate = null; terms[0].socket.send('\x1b[?1049l'); }
    await until(`qa.snapshot().type==='normal'`);
    assert.equal((await ev('qa.snapshot()')).oldest, 'HISTORY_000');
    assert.deepEqual(await ev('qa.errors'), []);
  }
  await finish(0);
})().catch(error => finish(1, error));
