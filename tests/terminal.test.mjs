import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import vm from 'node:vm';
import { setTimeout as sleep } from 'node:timers/promises';
import xterm from '@xterm/xterm';
import { windowsPtyForHost, termClientOptions, spawnTerm, listTerms, getPty, pruneTerms } from '../src/term.mjs';
const { Terminal } = xterm;

const write = (t, text) => new Promise(resolve => t.write(text, resolve));
const snapshot = t => {
  const b = t.buffer.active;
  return { baseY: b.baseY, viewportY: b.viewportY, topLine: b.getLine(b.viewportY).translateToString(true) };
};
const history = Array.from({ length: 240 }, (_, i) => `HISTORY_${String(i).padStart(3, '0')}\r\n`).join('') + 'READY>';

test('真实 xterm：ConPTY 增高在延迟重绘前不拉回历史，缺失 metadata 的对照能复现跳变', async () => {
  // 无 DOM renderer 的核心回归；可见帧验收由 verify-resize-continuity.cjs 执行。
  for (const knownWindows of [false, true]) {
    const t = new Terminal({ cols: 80, rows: 20, scrollback: 5000,
      ...(knownWindows ? { windowsPty: windowsPtyForHost('win32', '10.0.22631') } : {}) });
    try {
      await write(t, history);
      const before = snapshot(t);
      assert.equal(t.buffer.active.cursorY, 19);
      const screen = Array.from({ length: 20 }, (_, i) => t.buffer.active.getLine(before.baseY + i).translateToString(true));
      t.resize(80, 32); t.scrollToBottom();
      const fitted = snapshot(t);
      await sleep(120);
      assert.deepEqual(snapshot(t), fitted, '必须观察重绘到达前的独立时段');
      if (knownWindows) assert.deepEqual(fitted, before);
      else {
        assert.equal(fitted.baseY, before.baseY - 12);
        assert.equal(fitted.topLine, 'HISTORY_209');
      }
      await write(t, '\x1b[H' + screen.join('\r\n') + '\x1b[J');
      t.scrollToBottom();
      assert.equal(snapshot(t).topLine, before.topLine);
      assert.equal(t.buffer.active.getLine(0).translateToString(true), 'HISTORY_000');
      if (knownWindows) assert.deepEqual(snapshot(t), before);
    } finally { t.dispose(); }
  }
});

test('现代 ConPTY 保留宽度 reflow，POSIX 不启用 Windows resize 语义', async () => {
  assert.equal(windowsPtyForHost('linux', '6.12.0'), undefined);
  assert.equal(windowsPtyForHost('darwin', '24.0.0'), undefined);
  const modern = new Terminal({ cols: 80, rows: 20, windowsPty: windowsPtyForHost('win32', '10.0.22631') });
  const legacy = new Terminal({ cols: 80, rows: 20, windowsPty: windowsPtyForHost('win32', '10.0.19045') });
  try {
    for (const t of [modern, legacy]) await write(t, ('a'.repeat(120) + '\r\n').repeat(50) + 'READY>');
    const oldLength = modern.buffer.active.length;
    modern.resize(140, 28); legacy.resize(140, 28);
    assert.ok(modern.buffer.active.length < oldLength, '现代 ConPTY 必须重排早先折行的历史');
    assert.ok(legacy.buffer.active.length > modern.buffer.active.length, '旧 ConPTY 保留兼容的无 reflow 模式');
    assert.deepEqual(windowsPtyForHost('win32', '6.1.7601'), { backend: 'winpty', buildNumber: 7601 });
  } finally { modern.dispose(); legacy.dispose(); }
});

test('PTY 启动选项、列表与复用 metadata 一致，尺寸从实际 PTY 读取', () => {
  const pty = getPty(), original = pty.spawn;
  let options, exited;
  const fake = { cols: 92, rows: 28, onData() {}, onExit(fn) { exited = fn; } };
  pty.spawn = (_shell, _args, supplied) => { options = supplied; return fake; };
  try {
    const t = spawnTerm({ tool: 'codex', cwd: process.cwd(), command: 'fixture', cols: 92, rows: 28 });
    const expected = windowsPtyForHost(process.platform, os.release());
    assert.deepEqual(t.windowsPty, expected);
    if (expected) {
      assert.equal(options.useConpty, expected.backend === 'conpty');
      assert.equal(options.useConptyDll, false, '系统 build 不可被用于猜测独立 DLL 版本');
    } else assert.equal('useConpty' in options, false);
    fake.cols = 110; fake.rows = 40;
    const client = termClientOptions(t), listed = listTerms().find(entry => entry.id === t.id);
    assert.equal(client.cols, 110); assert.equal(client.rows, 40);
    assert.equal(listed.cols, client.cols); assert.equal(listed.rows, client.rows);
    assert.deepEqual(listed.windowsPty, client.windowsPty);
    exited({ exitCode: 0 }); pruneTerms(-1);
  } finally { pty.spawn = original; }
});

test('真实 mountTerm：创建 / 列表重挂 / POST 复用在回放前应用 metadata，回看历史不被重绘贴底', async () => {
  // 传输和 DOM 在此用桩，缓冲区仍是完整 xterm；renderer 另由 Electron 脚本验收。
  const source = fs.readFileSync(new URL('../src/web/js/term.js', import.meta.url), 'utf8');
  const windowsPty = windowsPtyForHost('win32', '10.0.22631');
  for (const route of ['create', 'list', 'reuse']) {
    const node = { id: 'n', tool: 'pi' }, calls = [], sockets = [];
    const entry = { id: 't', nodeId: 'n', tool: 'pi', running: true,
      cols: route === 'reuse' ? 100 : 80, rows: route === 'reuse' ? 30 : 20, windowsPty };
    const dims = { cols: 80, rows: 20 };
    const view = { hidden: false, querySelector: () => null, classList: { toggle() {}, remove() {} }, addEventListener() {}, removeEventListener() {} };
    const host = { isConnected: true, clientHeight: 400, clientWidth: 800, closest: () => view, innerHTML: '', getClientRects: () => [{}] };
    class CoreTerminal extends Terminal { open() {} }
    class Fit {
      activate(t) { this.t = t; }
      dispose() {}
      proposeDimensions() { return dims; }
      fit() { this.t.resize(dims.cols, dims.rows); }
    }
    class Socket {
      constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
      send(text) { this.sent.push(text); }
      close() {}
    }
    const context = vm.createContext({
      Terminal: CoreTerminal, FitAddon: { FitAddon: Fit }, WebSocket: Socket,
      currentTask: { id: 'task' }, state: { terms: route === 'list' ? [entry] : [] },
      theme: { xtermTheme: () => ({}), liveTerms: new Set() }, toolLabel: t => t,
      api: async (url, opts) => { calls.push({ url, opts }); return { termId: entry.id, ...entry, resumed: route === 'reuse' }; },
      performance, setTimeout, clearTimeout,
      requestAnimationFrame: callback => setTimeout(callback, 0), cancelAnimationFrame: clearTimeout,
      location: { protocol: 'http:', host: 'fixture' },
      ResizeObserver: class { observe() {} disconnect() {} },
      addEventListener() {}, removeEventListener() {},
    });
    context.window = context;
    vm.runInContext(source, context);
    const handle = await context.mountTerm(host, node), t = context.__sbLastMountTerm;
    const ws = sockets[0];
    const send = async text => {
      ws.onmessage({ data: text });
      // mountTerm 先在 Promise 链里排队，再由 xterm 的异步解析队列写入。
      await new Promise(resolve => setTimeout(resolve, 30));
    };
    try {
      assert.deepEqual(t.options.windowsPty, windowsPty, route + ' metadata must precede replay');
      assert.equal(calls.length, route === 'list' ? 0 : 1);
      ws.onopen();
      assert.equal(ws.sent.length, route === 'reuse' ? 1 : 0, route + ' notify only if the returned PTY geometry differs');
      if (route === 'reuse') assert.deepEqual(JSON.parse(ws.sent[0]), { resize: { cols: 80, rows: 20 } });
      await send(history);
      const before = snapshot(t);
      const screen = Array.from({ length: 20 }, (_, i) => t.buffer.active.getLine(before.baseY + i).translateToString(true));
      dims.rows = 32; handle.refit();
      await sleep(100);
      assert.deepEqual(snapshot(t), before, route + ' fit must not expose older history');
      t.scrollLines(-40);
      const reading = snapshot(t);
      await send('\x1b[H' + screen.join('\r\n') + '\x1b[J');
      assert.deepEqual(snapshot(t), reading, route + ' delayed repaint must respect user scroll');
      dims.cols = 100; dims.rows = 36; handle.refit(); await sleep(100);
      assert.equal(snapshot(t).topLine, reading.topLine, route + ' resize must retain history anchor');
      assert.ok(t.buffer.active.viewportY < t.buffer.active.baseY);
      const sends = ws.sent.length;
      handle.refit(); await sleep(100);
      assert.equal(ws.sent.length, sends, 'same size must not redraw');
      await send('\x1b[?1049h\x1b[2J\x1b[HNative picker');
      assert.equal(t.buffer.active.type, 'alternate');
      await send('\x1b[?1049l');
      assert.equal(t.buffer.active.type, 'normal');
      assert.equal(t.buffer.active.getLine(0).translateToString(true), 'HISTORY_000');
    } finally { handle.dispose(); }
  }
});
