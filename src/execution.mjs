import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (message, status = 409) => Object.assign(new Error(message), { status });

/** 每个节点只有一个执行实例；所有异步回调必须持有该实例才能改状态。 */
export class ExecutionManager {
  constructor({ createDriver, getNode, snapshotFile = null, timeoutMs = 600_000, onSession = () => {} }) {
    Object.assign(this, { createDriver, getNode, snapshotFile, timeoutMs, onSession });
    this.entries = new Map();
    if (snapshotFile) {
      try {
        for (const saved of JSON.parse(fs.readFileSync(snapshotFile, 'utf8'))) {
          const entry = this.entry(saved.nodeId);
          entry.queue = saved.queue || [];
          entry.paused = entry.queue.length > 0;
          entry.outcome = saved.status?.running
            ? { ...saved.status, running: false, phase: 'interrupted', exitCode: -1, endedAt: Date.now(), stderrTail: '应用已重启，上次执行未正常结束；待发消息已保留。' }
            : saved.outcome || null;
        }
      } catch (error) { if (error.code !== 'ENOENT') this.recoveryError = '执行记录读取失败，未自动恢复待发消息'; }
    }
  }
  entry(nodeId) {
    if (!this.entries.has(nodeId)) this.entries.set(nodeId, {
      nodeId, active: null, queue: [], outcome: null, paused: false, receipts: new Map(), answered: new Set(),
    });
    return this.entries.get(nodeId);
  }
  snapshot(nodeId) {
    const e = this.entry(nodeId), run = e.active;
    return {
      status: run ? { ...run.status } : e.outcome,
      outcome: e.outcome,
      queue: e.queue.map(({ id, message }) => ({ id, message })),
      paused: e.paused,
      interactions: run ? [...run.pending.values()].map((p) => ({ ...p.view, id: p.id, runId: run.id })) : [],
      recoveryError: this.recoveryError || null,
    };
  }
  busy(nodeId) { const run = this.entries.get(nodeId)?.active; return !!run && (run.status.running || run.pending.size > 0); }
  async releaseIdle(nodeId) {
    const e = this.entries.get(nodeId);
    if (!e?.active) return;
    if (this.busy(nodeId)) throw fail('当前会话仍在执行或等待回答');
    await this.finish(e, e.active, e.active.completedOutcome);
  }
  settleCompleted(e, run) {
    // 非阻塞问题答复后，Codex 可能自行启动下一轮；保留空闲连接直到收到新回合或用户切换执行入口。
    run.status.running = false;
    run.status.phase = 'completed';
    clearTimeout(run.timer);
    e.outcome = { ...run.status, ...run.completedOutcome, endedAt: Date.now() };
    try { this.save(); } catch (error) { e.paused = true; this.recoveryError = '执行记录保存失败：' + error.message; }
    if (e.queue.length && !e.paused) void this.finish(e, run, run.completedOutcome);
  }
  save() {
    if (!this.snapshotFile) return;
    const rows = [...this.entries.values()].map((e) => ({
      nodeId: e.nodeId, queue: e.queue, status: e.active?.status, outcome: e.outcome,
    })).filter((e) => e.queue.length || e.status || e.outcome);
    fs.mkdirSync(path.dirname(this.snapshotFile), { recursive: true });
    const temp = this.snapshotFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(rows), 'utf8');
    fs.renameSync(temp, this.snapshotFile);
  }
  remember(entry, requestId, response) {
    if (requestId) {
      entry.receipts.set(requestId, response);
      if (entry.receipts.size > 100) entry.receipts.delete(entry.receipts.keys().next().value);
    }
    return response;
  }
  validate(taskId, nodeId) {
    const node = this.getNode(taskId, nodeId);
    if (!node) throw fail('会话不存在', 404);
    if (!node.cwd || !fs.existsSync(node.cwd)) throw fail('工作目录不存在', 400);
    if (node.perm === 'ro' && ['pi', 'omp'].includes(node.tool)) throw fail('该工具暂不支持只读执行，请切换工具或权限档位', 400);
    return node;
  }
  async send(taskId, nodeId, message, { mode = 'send', requestId = null } = {}) {
    message = String(message || '').trim();
    if (!message) throw fail('消息为空', 400);
    const node = this.validate(taskId, nodeId), e = this.entry(nodeId);
    if (requestId && e.receipts.has(requestId)) return e.receipts.get(requestId);
    if (mode === 'steer' && e.active && !e.active.finishing && !e.active.pending.size && node.tool === 'pi') {
      // 先记住在途 Promise，重复 HTTP 请求不会重复向 CLI 写入。
      const operation = (async () => {
        await e.active.driver.steer(message);
        return { ok: true, steered: true, queued: false };
      })();
      this.remember(e, requestId, operation);
      try { return await operation; } catch (error) { e.receipts.delete(requestId); throw error; }
    }
    if (e.queue.length >= 10) throw fail('待发消息已满（10 条），请等待或先撤回', 429);
    const item = { id: randomUUID(), taskId, nodeId, message, ts: Date.now() };
    if (mode === 'interrupt') {
      e.paused = true;
      e.queue.unshift(item);
    } else e.queue.push(item);
    try { this.save(); } catch (error) {
      e.queue = e.queue.filter((q) => q.id !== item.id);
      throw fail('待发消息保存失败：' + error.message, 500);
    }
    const queued = !!e.active || e.paused;
    const response = { ok: true, queued, itemId: item.id, queueLen: e.queue.length, interrupted: mode === 'interrupt' };
    this.remember(e, requestId, response);
    if (mode === 'interrupt') {
      try {
        await this.cancel(nodeId, { pause: true });
        e.paused = false;
        this.drain(e);
      } catch (error) {
        e.receipts.delete(requestId);
        // 中断失败也保留新消息，用户可以看到并撤回；禁止并发启动。
        throw error;
      }
    } else if (!e.paused) {
      if (e.active && !e.active.status.running && !e.active.pending.size) void this.finish(e, e.active, e.active.completedOutcome);
      else if (!e.active) this.drain(e);
    }
    return response;
  }
  drain(e) {
    if (e.active || e.paused || !e.queue.length) return;
    const item = e.queue[0];
    let node;
    try { node = this.validate(item.taskId, item.nodeId); } catch (error) {
      e.paused = true;
      e.outcome = { running: false, phase: 'failed', runId: randomUUID(), exitCode: -1, stderrTail: error.message, endedAt: Date.now() };
      try { this.save(); } catch (saveError) { this.recoveryError = '执行记录保存失败：' + saveError.message; }
      return;
    }
    e.queue.shift();
    const run = {
      id: randomUUID(), node: { ...node }, item, pending: new Map(), timer: null, finishing: null, driver: null,
      status: { running: true, phase: 'starting', startedAt: Date.now(), tool: node.tool },
    };
    run.status.runId = run.id;
    e.active = run;
    try { this.save(); } catch (error) {
      e.active = null; e.queue.unshift(item); e.paused = true;
      this.recoveryError = '待发消息已暂停，执行记录保存失败：' + error.message;
      return;
    }
    const current = () => e.active === run;
    try {
      run.driver = this.createDriver({
        node: run.node, message: item.message, runId: run.id,
        onTurnStarted: () => {
          if (!current() || run.finishing) return;
          run.completedOutcome = null; run.status.running = true;
          this.armTimeout(e, run);
        },
        onComplete: (outcome = {}) => {
          if (!current()) return;
          // 非阻塞问题可能晚于文本回合结束；保留原连接供用户回答。
          if (run.pending.size && !outcome.canceled && (outcome.exitCode ?? 0) === 0) {
            run.completedOutcome = outcome; run.status.phase = 'waiting-input'; clearTimeout(run.timer);
          } else void this.finish(e, run, outcome);
        },
        onSession: (session) => { if (current()) this.onSession(item.taskId, node.id, session); },
        onRequest: (request) => {
          if (!current() || run.finishing) return;
          const id = request.id;
          run.pending.set(id, { ...request, id, responding: false });
          if (request.blocking !== false) {
            run.status.phase = 'waiting-input';
            clearTimeout(run.timer);
          }
        },
        onRequestCanceled: (id) => {
          if (!current()) return;
          run.pending.delete(id);
          if (!run.pending.size) {
            if (run.completedOutcome) this.settleCompleted(e, run);
            else this.armTimeout(e, run);
          }
        },
      });
      this.armTimeout(e, run);
      Promise.resolve(run.driver.start()).then(() => {
        if (current() && !run.finishing && !run.pending.size) run.status.phase = 'running';
      }).catch((error) => { if (current()) void this.finish(e, run, { exitCode: -1, stderrTail: error.message }); });
    } catch (error) { void this.finish(e, run, { exitCode: -1, stderrTail: error.message }); }
  }
  armTimeout(e, run) {
    clearTimeout(run.timer);
    if (run.finishing || [...run.pending.values()].some((p) => p.blocking !== false)) return;
    run.status.phase = 'running';
    run.timer = setTimeout(() => {
      e.paused = true;
      void this.finish(e, run, { exitCode: -1, timedOut: true, stderrTail: '执行超时（10 分钟），待发消息已保留' });
    }, this.timeoutMs);
    run.timer.unref?.();
  }
  finish(e, run, outcome = {}) {
    if (e.active !== run) return Promise.resolve();
    if (run.finishing) return run.finishing;
    clearTimeout(run.timer);
    run.status.phase = 'stopping';
    run.finishing = (async () => {
      try { await run.driver?.stop(); } catch (error) {
        e.paused = true;
        run.status.phase = 'stop-failed';
        run.status.stderrTail = '停止进程未确认：' + error.message;
        run.finishing = null;
        throw error;
      }
      if (e.active !== run) return;
      const result = { exitCode: 0, ...outcome, ...(run.cancelOutcome || {}) };
      e.outcome = {
        ...run.status, ...result, running: false, endedAt: Date.now(),
        phase: result.canceled ? 'canceled' : result.exitCode === 0 ? 'completed' : 'failed',
      };
      e.active = null;
      if (result.exitCode !== 0) e.paused = e.queue.length > 0 || e.paused;
      try { this.save(); } catch (error) {
        e.paused = true; this.recoveryError = '执行记录保存失败，待发消息已暂停：' + error.message;
      }
      if (!e.paused) this.drain(e);
    })();
    // 调用者可以 await 失败；后台事件回调也不会产生未处理的 rejection。
    run.finishing.catch(() => {});
    return run.finishing;
  }
  async cancel(nodeId, { pause = true, runId = null } = {}) {
    const e = this.entry(nodeId);
    if (runId && e.active?.id !== runId) throw fail('这次请求已结束，请刷新后查看当前运行');
    e.paused = pause;
    const run = e.active;
    if (run) {
      run.cancelOutcome = { exitCode: -2, canceled: true, stderrTail: '已取消执行' };
      await this.finish(e, run, run.cancelOutcome);
    }
    this.save();
    return { ok: true };
  }
  async answer(nodeId, { runId, interactionId, ...answer }) {
    const e = this.entry(nodeId), key = `${runId}:${typeof interactionId}:${interactionId}`;
    if (e.answered.has(key)) return { ok: true, alreadyAnswered: true };
    const run = e.active;
    if (!run || run.id !== runId || run.finishing) throw fail('这次请求已结束，请刷新后查看当前问题');
    const request = run.pending.get(interactionId);
    if (!request) throw fail('问题已处理或已取消');
    if (request.responding) throw fail('答案正在提交，请稍候');
    request.responding = true;
    try {
      await request.respond(answer);
      run.pending.delete(request.id);
      e.answered.add(key);
      if (e.answered.size > 100) e.answered.delete(e.answered.values().next().value);
      if (e.active === run && !run.pending.size) {
        if (run.completedOutcome) this.settleCompleted(e, run);
        else this.armTimeout(e, run);
      }
      return { ok: true };
    } finally { request.responding = false; }
  }
  unqueue(nodeId, itemId) {
    const e = this.entry(nodeId);
    const previous = e.queue;
    e.queue = e.queue.filter((item) => item.id !== itemId);
    try { this.save(); } catch (error) { e.queue = previous; throw error; }
    return { ok: true, queueLen: e.queue.length };
  }
  resume(nodeId) {
    const e = this.entry(nodeId); e.paused = false;
    try { this.save(); } catch (error) { e.paused = true; throw error; }
    if (e.active && !this.busy(nodeId)) void this.finish(e, e.active, e.active.completedOutcome);
    else this.drain(e);
    return { ok: true };
  }
  async shutdown() {
    await Promise.allSettled([...this.entries.keys()].map((id) => this.cancel(id)));
  }
}
