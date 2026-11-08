import fs from 'node:fs';
import path from 'node:path';

/**
 * 后台自动捕获：监听各工具会话目录，文件变化时对绑定了该会话的看板任务
 * 执行增量捕获（复用 captureTask 的字节偏移 tail），无需手动点击。
 */

const DEBOUNCE_MS = 1200;   // 同一文件连续变化的合并窗口
const THROTTLE_MS = 5000;   // 同一 (任务, 文件) 的最小捕获间隔

export function startAutoCapture(deps) {
  const { getBoardTasks, findCtxTaskId, capture, roots = [] } = deps;
  const debounceTimers = new Map(); // file -> timer
  const lastCapture = new Map();    // `${ctxTaskId}|${file}` -> ts

  const schedule = (file) => {
    const old = debounceTimers.get(file);
    if (old) clearTimeout(old);
    debounceTimers.set(file, setTimeout(() => {
      debounceTimers.delete(file);
      runCapture(file);
    }, DEBOUNCE_MS));
  };

  const runCapture = (file) => {
    try {
      const tasks = getBoardTasks() || [];
      for (const task of tasks) {
        const ctxTaskId = findCtxTaskId(task.id);
        if (!ctxTaskId) continue;
        const hit = (task.nodes || []).find((n) => n.file && sameFile(n.file, file) && !n.checkpointVersion);
        if (!hit) continue;

        const key = `${ctxTaskId}|${hit.file}`;
        const now = Date.now();
        if (now - (lastCapture.get(key) || 0) < THROTTLE_MS) continue;
        lastCapture.set(key, now);

        try {
          const stats = capture(ctxTaskId, [{ tool: hit.tool, file: hit.file }]);
          if (stats?.newEvents > 0) {
            console.log(`[自动捕获] 任务「${task.title}」+${stats.newEvents} 事件 <- ${path.basename(hit.file)}`);
          }
        } catch (err) {
          console.warn(`[自动捕获] 失败（不影响继续监听）: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[自动捕获] 调度异常: ${err.message}`);
    }
  };

  const sameFile = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  const watchOne = (root, retries = 1) => {
    try {
      const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename || !String(filename).endsWith('.jsonl')) return;
        schedule(path.join(root, String(filename)));
      });
      watcher.on('error', (err) => {
        console.warn(`[自动捕获] 监听 ${root} 出错: ${err.message}`);
        try { watcher.close(); } catch { /* ignore */ }
        if (retries > 0) {
          setTimeout(() => {
            if (fs.existsSync(root)) watchOne(root, retries - 1);
          }, 5000);
        }
      });
      console.log(`[自动捕获] 正在监听 ${root}`);
      return watcher;
    } catch (err) {
      console.warn(`[自动捕获] 无法监听 ${root}: ${err.message}`);
      return null;
    }
  };

  const watchers = roots.filter((r) => r && fs.existsSync(r)).map((r) => watchOne(r));
  return { watchers, stop: () => watchers.forEach((w) => { try { w?.close(); } catch { /* ignore */ } }) };
}
