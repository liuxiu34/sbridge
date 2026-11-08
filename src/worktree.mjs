import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* git worktree 隔离（吸收 Paseo 的并行隔离思路）：
   新开会话/接力时，在仓库旁边的 .sbridge-worktrees/<repo>-<label>-<seq> 里起一个
   独立分支工作区，几个 agent 并行改代码互不覆盖。
   安全策略：只对「工作区干净」的 git 仓库创建；有未提交改动时回退原目录并说明原因
   （否则新会话看不到你当前的改动，代价更大）。非 git 目录直接回退。 */

const sanitize = (s) => String(s || 'agent').replace(/[^\w\u4e00-\u9fff-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';

export function maybeCreateWorktree(cwd, label) {
  if (!cwd || !fs.existsSync(cwd)) return { cwd, created: false, reason: '目录不存在' };
  let top = '';
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return { cwd, created: false, reason: '不是 git 仓库' };
  }
  if (!top) return { cwd, created: false, reason: '不是 git 仓库' };
  try {
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (status.trim()) {
      return { cwd, created: false, reason: '主工作区有未提交改动，未创建 worktree（避免新会话看不到当前改动）' };
    }
    const repoName = path.basename(top);
    const seq = `${sanitize(label)}-${Date.now().toString(36)}`;
    const wtRoot = path.join(path.dirname(top), '.sbridge-worktrees');
    fs.mkdirSync(wtRoot, { recursive: true });
    const wtPath = path.join(wtRoot, `${repoName}-${seq}`);
    const branch = `sbridge/${seq}`;
    execFileSync('git', ['worktree', 'add', '-b', branch, wtPath, 'HEAD'], {
      cwd: top, stdio: 'ignore',
    });
    return { cwd: wtPath, created: true, branch, repo: top, reason: '' };
  } catch (err) {
    return { cwd, created: false, reason: `创建 worktree 失败：${err.message}` };
  }
}
