import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../src/web/js/pane.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const keydown = source.match(/ta\.onkeydown = \(e\) => \{([\s\S]*?)\n    \};/)[1];
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function fixture() {
  const sent = [], pending = [], errors = [];
  const ta = { value: '草稿', focus() {} };
  const ctx = vm.createContext({
    ta, crypto: webcrypto, chips: [], composing: false, submitting: false, draftRevision: 0, menu: {}, btn: {},
    closeFileMenu() {}, renderChips() {}, pushHistory() {}, toast: (s) => errors.push(s),
    isComposing: (e) => e.isComposing || e.keyCode === 229,
    deliverMessage(text) { sent.push(text); return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
  });
  vm.runInContext(section('    const doSend = async (', '\n    submitDraft = doSend;') +
    '\nglobalThis.send = doSend; globalThis.key = (e) => {' + keydown + '};', ctx);
  return { ctx, ta, sent, pending, errors };
}
const enter = (extra = {}) => ({ key: 'Enter', shiftKey: false, preventDefault() {}, ...extra });

test('中文选字与已被菜单处理的 Enter 不提交', () => {
  const h = fixture();
  h.ctx.key(enter({ isComposing: true }));
  h.ctx.key(enter({ keyCode: 229 }));
  h.ctx.key(enter({ defaultPrevented: true }));
  assert.equal(h.sent.length, 0);
});
test('请求未返回时多个入口只提交一次', async () => {
  const h = fixture();
  const first = h.ctx.send();
  h.ctx.key(enter());
  await h.ctx.send('interrupt');
  assert.deepEqual(h.sent, ['草稿']);
  h.pending[0].resolve({}); await first;
  assert.equal(h.ta.value, '');
});
test('发送期间继续编辑的草稿被保留', async () => {
  const h = fixture();
  const first = h.ctx.send();
  h.ta.value = '下一条新草稿'; h.ctx.draftRevision++;
  h.pending[0].resolve({}); await first;
  assert.equal(h.ta.value, '下一条新草稿');
});
test('请求失败保留原稿和附件，可重试', async () => {
  const h = fixture(); h.ctx.chips = ['src/main.js'];
  const first = h.ctx.send();
  h.pending[0].reject(new Error('连接中断')); await first;
  assert.equal(h.ta.value, '草稿');
  assert.equal(h.ctx.chips.length, 1);
  assert.equal(h.ctx.submitting, false);
  assert.deepEqual(h.errors, ['连接中断']);
});
test('斜杠命令补全不会同时执行', () => {
  const h = fixture(), handlers = [];
  h.ta.value = '/mo'; h.ta.addEventListener = (_event, fn) => handlers.push(fn);
  Object.assign(h.ctx, { menu: { hidden: false }, menuItems: [['model', '模型']], menuIdx: 0 });
  vm.runInContext(section("    ta.addEventListener('keydown', (e) => {\n      if (isComposing(e)) return;\n      if (!menu.hidden", '\n    let historyDraft'), h.ctx);
  const e = enter({ stopped: false, stopImmediatePropagation() { this.stopped = true; } });
  handlers[0](e); if (!e.stopped) h.ctx.key(e);
  assert.equal(h.ta.value, '/model ');
  assert.equal(h.sent.length, 0);
});
