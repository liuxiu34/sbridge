import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExecutionManager } from '../src/execution.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(options = {}) {
  const node = { id: 'node', tool: 'claude', cwd: process.cwd(), model: 'old-model' }, drivers = [];
  const manager = new ExecutionManager({
    getNode: () => node, ...options,
    createDriver(hooks) {
      const driver = { hooks, start: async () => {}, steer: async () => {}, stopped: false,
        async stop() { this.stopped = true; },
      };
      drivers.push(driver); return driver;
    },
  });
  return { manager, node, drivers, send: (text, options) => manager.send('task', 'node', text, options) };
}
test('并行发送被序列化，重复请求 ID 只提交一次', async () => {
  const h = fixture();
  await h.send('first', { requestId: 'id-1' });
  await h.send('first', { requestId: 'id-1' });
  await h.send('second');
  assert.equal(h.drivers.length, 1);
  assert.equal(h.manager.snapshot('node').queue.length, 1);
  h.drivers[0].hooks.onComplete(); await tick();
  assert.equal(h.drivers.length, 2);
  assert.equal(h.drivers[0].stopped, true);
  assert.equal(h.drivers[1].hooks.message, 'second');
  await h.manager.shutdown();
});
test('中断完成后才开始新消息，保留原待发队列', async () => {
  const h = fixture(); await h.send('first'); await h.send('queued');
  await h.send('urgent', { mode: 'interrupt' });
  assert.equal(h.drivers[0].stopped, true);
  assert.equal(h.drivers[1].hooks.message, 'urgent');
  assert.equal(h.manager.snapshot('node').queue[0].message, 'queued');
  h.drivers[0].hooks.onComplete({ exitCode: 1 }); await tick();
  assert.equal(h.manager.snapshot('node').status.running, true);
  assert.equal(h.manager.snapshot('node').status.runId, h.drivers[1].hooks.runId);
  await h.manager.shutdown();
});
test('停止未确认时不启动第二个实例', async () => {
  const h = fixture(); await h.send('first');
  h.drivers[0].stop = async () => { throw Error('process still alive'); };
  await assert.rejects(h.send('urgent', { mode: 'interrupt' }));
  assert.equal(h.drivers.length, 1);
  assert.equal(h.manager.snapshot('node').queue[0].message, 'urgent');
  assert.equal(h.manager.snapshot('node').status.phase, 'stop-failed');
});
test('每一轮读取最新模型配置，Claude 引导按下一轮排队', async () => {
  const h = fixture(); await h.send('first');
  h.node.model = 'new-model';
  const response = await h.send('follow-up', { mode: 'steer' });
  assert.equal(response.queued, true);
  assert.equal(h.drivers.length, 1);
  h.drivers[0].hooks.onComplete(); await tick();
  assert.equal(h.drivers[1].hooks.node.model, 'new-model');
  await h.manager.shutdown();
});
test('问题保留到回答，拒绝过期回答且重复提交幂等', async () => {
  const h = fixture(); await h.send('first');
  let responses = 0;
  h.drivers[0].hooks.onRequest({ id: 'q1', view: { title: '问题' }, respond: async () => { responses++; } });
  const snap = h.manager.snapshot('node');
  assert.equal(snap.status.phase, 'waiting-input');
  assert.equal(snap.interactions[0].title, '问题');
  await assert.rejects(h.manager.answer('node', { runId: 'old', interactionId: 'q1' }));
  const answer = { runId: snap.status.runId, interactionId: 'q1', answers: { q1: ['A'] } };
  await h.manager.answer('node', answer); await h.manager.answer('node', answer);
  assert.equal(responses, 1);
  assert.equal(h.manager.snapshot('node').interactions.length, 0);
  await h.manager.shutdown();
});
test('取消暂停队列，重启保留消息且不会自动执行', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'sbridge-execution-test-'));
  const snapshotFile = path.join(folder, 'execution.json');
  const h = fixture({ snapshotFile }); await h.send('first'); await h.send('queued');
  await h.manager.cancel('node');
  const restored = fixture({ snapshotFile });
  assert.equal(restored.manager.snapshot('node').paused, true);
  assert.equal(restored.manager.snapshot('node').queue[0].message, 'queued');
  assert.equal(restored.drivers.length, 0);
  restored.manager.resume('node');
  assert.equal(restored.drivers[0].hooks.message, 'queued');
  await restored.manager.shutdown();
  fs.unlinkSync(snapshotFile); fs.rmdirSync(folder);
});

test('非阻塞问题跨回合保留连接，收到自动续轮后继续等待完成', async () => {
  const h = fixture(); await h.send('first');
  h.drivers[0].hooks.onRequest({ id: 7, blocking: false, view: {}, respond: async () => {} });
  assert.equal(h.manager.snapshot('node').status.phase, 'running');
  h.drivers[0].hooks.onComplete({ exitCode: 0 }); await tick();
  const runId = h.manager.snapshot('node').status.runId;
  await h.manager.answer('node', { runId, interactionId: 7 });
  assert.equal(h.drivers[0].stopped, false);
  assert.equal(h.manager.busy('node'), false);
  h.drivers[0].hooks.onTurnStarted();
  assert.equal(h.manager.busy('node'), true);
  h.drivers[0].hooks.onComplete({ exitCode: 0 }); await tick();
  assert.equal(h.drivers[0].stopped, true);
  assert.equal(h.manager.snapshot('node').status.phase, 'completed');
});

test('退出会清理等待回答的进程并保留队列', async () => {
  const h = fixture(); await h.send('first'); await h.send('queued');
  h.drivers[0].hooks.onRequest({ id: 'q', view: {}, respond: async () => {} });
  await h.manager.shutdown();
  assert.equal(h.drivers[0].stopped, true);
  assert.equal(h.manager.snapshot('node').paused, true);
  assert.equal(h.manager.snapshot('node').queue[0].message, 'queued');
});

test('启动状态写盘失败不丢待发消息，也不启动 CLI', async () => {
  const h = fixture();
  let writes = 0;
  h.manager.save = () => { if (++writes === 2) throw Error('disk full'); };
  await h.send('preserve');
  assert.equal(h.drivers.length, 0);
  assert.equal(h.manager.snapshot('node').queue[0].message, 'preserve');
  assert.equal(h.manager.snapshot('node').paused, true);
  assert.match(h.manager.snapshot('node').recoveryError, /disk full/);
});

test('撤回写盘失败保留原待发队列', async () => {
  const h = fixture(); await h.send('first'); await h.send('queued');
  const id = h.manager.snapshot('node').queue[0].id;
  const originalSave = h.manager.save;
  h.manager.save = () => { throw Error('disk full'); };
  assert.throws(() => h.manager.unqueue('node', id));
  assert.equal(h.manager.snapshot('node').queue[0].id, id);
  h.manager.save = originalSave; await h.manager.shutdown();
});

test('过期问题的取消按钮不能取消下一轮', async () => {
  const h = fixture(); await h.send('first');
  const runId = h.manager.snapshot('node').status.runId;
  await h.send('second', { mode: 'interrupt' });
  await assert.rejects(h.manager.cancel('node', { runId }), /已经结束|已结束/);
  assert.equal(h.drivers[1].stopped, false);
  await h.manager.shutdown();
});
