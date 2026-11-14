import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';

test('托盘退出等待后台清理，重复退出不会跳过清理', async () => {
  const handlers = {}, calls = [], events = [];
  let menu, finishShutdown;
  const app = {
    isPackaged: false, whenReady: () => new Promise(() => {}), on: (event, handler) => { handlers[event] = handler; },
    getLoginItemSettings: () => ({}), getPath: () => '.',
    quit() { const event = { prevented: false, preventDefault() { this.prevented = true; } }; events.push(event); handlers['before-quit'](event); },
    exit: (code) => calls.push(['exit', code]),
  };
  const context = vm.createContext({
    require(name) {
      if (name === 'electron') return { app, Tray: class { setToolTip() {} setContextMenu() {} on() {} }, Menu: { buildFromTemplate(items) { menu = items; return items; } } };
      if (name === 'node:child_process') return { execFile(command, args, _options, done) { calls.push([command, args]); done(); } };
      if (name === 'node:fs') return { appendFileSync() {} };
      if (name === 'node:path') return path;
      throw Error(name);
    },
    __dirname: process.cwd(), process: { platform: 'win32' }, console: { log() {} }, AbortSignal,
    fetch(url) { calls.push(['shutdown', url]); return new Promise((r) => { finishShutdown = r; }); },
  });
  vm.runInContext(fs.readFileSync('src/electron-main.cjs', 'utf8') + '\nsvc={pid:12345};createTray();', context);
  menu.find((item) => item.label === '退出 sbridge').click();
  app.quit();
  assert.equal(events.every((event) => event.prevented), true);
  assert.equal(calls.filter((c) => c[0] === 'shutdown').length, 1);
  assert.equal(calls.some((c) => c[0] === 'exit'), false);
  finishShutdown();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.at(-2)[0], 'taskkill');
  assert.equal(calls.at(-1)[0], 'exit');
});
