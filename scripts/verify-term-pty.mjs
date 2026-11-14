// 真实隔离 HTTP / node-pty：首次、列表、POST 复用的元信息和尺寸一致，并捕获真实长历史重绘。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import xterm from '@xterm/xterm';
import { startPtyResizeFixture } from './fixtures/pty-resize-fixture.mjs';
import { windowsPtyForHost } from '../src/term.mjs';
const { Terminal } = xterm;

const output = process.env.SBRIDGE_QA_OUTPUT || fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-term-contract-'));
fs.mkdirSync(output, { recursive: true });
let fixture, socket, terminal;
const results = [], chunks = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const end = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > end) throw Error('Timeout: ' + label); await sleep(20); }
}
try {
  fixture = await startPtyResizeFixture(output);
  const api = async (route, body) => {
    const res = await fetch(fixture.base + route, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data)); return data;
  };
  for (const tool of ['pi', 'codex', 'claude', 'omp']) {
    const node = fixture.nodes.find(n => n.id === `${tool}-create-height`);
    const request = { ...node, nodeId: node.id, cols: 80, rows: 20 };
    const created = await api('/api/tasks/fixture/term', request);
    const listed = (await api('/api/terms')).terms.find(t => t.id === created.termId);
    const reused = await api('/api/tasks/fixture/term', { ...request, cols: 100, rows: 32 });
    assert.equal(reused.termId, created.termId);
    for (const value of [created, listed, reused]) {
      assert.deepEqual(value.windowsPty, windowsPtyForHost());
      assert.equal(value.cols, 80); assert.equal(value.rows, 20);
    }
    const renderer = terminal = new Terminal({ cols: 80, rows: 20, windowsPty: created.windowsPty || {} });
    let chain = Promise.resolve(), ready = false, socketError, waiting = false, disposed = false;
    const pending = [];
    socket = new WebSocket(fixture.base.replace('http:', 'ws:') + '/ws/term/' + created.termId);
    socket.on('error', error => { socketError = error; });
    const consume = text => { chain = chain.then(() => disposed ? undefined : new Promise(resolve => renderer.write(text, resolve))); };
    socket.on('message', raw => {
      if (disposed) return;
      const text = raw.toString().replaceAll('\0REPLAY_DONE\0', '');
      if (!text) return;
      chunks.push({ tool, at: Date.now(), delayed: waiting, text });
      if (waiting) pending.push(text); else consume(text);
      if (text.includes('READY>')) ready = true;
    });
    await until(() => { if (socketError) throw socketError; return ready; }, tool + ' history');
    await chain; await sleep(100); await chain;
    const snap = () => ({ baseY: terminal.buffer.active.baseY, viewportY: terminal.buffer.active.viewportY,
      cursorY: terminal.buffer.active.cursorY, rows: terminal.rows,
      topLine: terminal.buffer.active.getLine(terminal.buffer.active.viewportY)?.translateToString(true) });
    const before = snap();
    assert.ok(before.baseY > 100, 'real PTY must produce scrollback');
    assert.equal(before.cursorY, 19, 'real cursor must be on last line');
    waiting = true;
    terminal.resize(80, 32);
    const fitted = snap();
    socket.send(JSON.stringify({ resize: { cols: 80, rows: 32 } }));
    await sleep(360);
    const delayed = snap();
    assert.deepEqual(fitted, delayed);
    if (process.platform === 'win32') {
      assert.equal(fitted.topLine, before.topLine);
      assert.equal(fitted.baseY, before.baseY);
      assert.ok(pending.length > 0, 'must capture actual ConPTY redraw');
    }
    waiting = false; pending.forEach(consume); await chain;
    await sleep(100); await chain;
    const after = snap();
    const current = (await api('/api/terms')).terms.find(t => t.id === created.termId);
    assert.equal(current.cols, 80); assert.equal(current.rows, 32);
    results.push({ tool, created, reused, before, fitted, delayed, after, redrawChunks: pending.length });
    disposed = true; socket.close(); socket = null; terminal.dispose(); terminal = null;
    await api('/api/terms/kill', { id: created.termId });
  }
  fs.writeFileSync(path.join(output, 'term-pty.json'), JSON.stringify({ passed: true, renderer: false, results }, null, 2));
  console.log(JSON.stringify({ passed: true, renderer: false, output, tools: results.map(r => r.tool) }));
} catch (error) {
  fs.writeFileSync(path.join(output, 'term-pty.json'), JSON.stringify({ passed: false, error: error.stack, code: error.code, errno: error.errno, results }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  socket?.close(); terminal?.dispose(); await fixture?.close();
  fs.writeFileSync(path.join(output, 'conpty-chunks.json'), JSON.stringify(chunks, null, 2));
}
