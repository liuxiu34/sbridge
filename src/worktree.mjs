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

/* ---------- worktree 生命周期：查看状态 + 合并回主分支 ---------- */

const WT_MARK = /[\\/]\.sbridge-worktrees[\\/]/i;

function gitRun(args, cwd) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out || '').trim() };
  } catch (err) {
    return { ok: false, out: String(`${err.stdout || ''}${err.stderr || ''}`).trim() || String(err.message || '') };
  }
}

const git = (args, cwd) => {
  const r = gitRun(args, cwd);
  if (!r.ok) throw new Error(r.out);
  return r.out;
};

/** 是否是 sbridge 自建的 worktree（只认 .sbridge-worktrees 下的目录，不碰用户自己的 worktree） */
export function isSbridgeWorktree(cwd) {
  return WT_MARK.test(String(cwd || ''));
}

/** 读取 worktree 与主仓库的状态：分支、领先/落后提交数、未提交改动、是否已合并 */
export function worktreeInfo(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  let top = '';
  try { top = git(['rev-parse', '--show-toplevel'], cwd); } catch { return null; }
  if (!top || !isSbridgeWorktree(top)) return null;
  let branch = '';
  try { branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], top); } catch { return null; }
  let repo = '';
  try {
    const common = git(['rev-parse', '--git-common-dir'], top);
    repo = path.dirname(path.resolve(top, common));
  } catch { /* 老版本/异常时留空 */ }
  let base = '';
  try { base = repo ? git(['rev-parse', '--abbrev-ref', 'HEAD'], repo) : ''; } catch { /* ignore */ }
  let statusLines = [];
  try { statusLines = git(['status', '--porcelain'], top).split('\n').filter(Boolean); } catch { /* ignore */ }
  let ahead = 0;
  let behind = 0;
  let merged = false;
  if (repo && base && branch) {
    const a = gitRun(['rev-list', '--count', `${base}..${branch}`], repo);
    if (a.ok) ahead = Number(a.out) || 0;
    const b = gitRun(['rev-list', '--count', `${branch}..${base}`], repo);
    if (b.ok) behind = Number(b.out) || 0;
    merged = gitRun(['merge-base', '--is-ancestor', branch, base], repo).ok;
  }
  return {
    path: top, branch, repo, base, ahead, behind,
    dirtyCount: statusLines.length,
    files: statusLines.slice(0, 40),
    merged,
  };
}

/** 把 worktree 分支合并回主仓库当前分支；有未提交改动/冲突时拒绝并回滚 */
export function mergeWorktree(cwd) {
  const info = worktreeInfo(cwd);
  if (!info) return { ok: false, error: '这个会话不在 sbridge 的独立 worktree 里' };
  if (!info.repo || !info.base) return { ok: false, error: '找不到主仓库或目标分支' };
  if (info.dirtyCount) {
    return { ok: false, error: `worktree 还有 ${info.dirtyCount} 个未提交改动；先让 agent 提交或手动 commit 后再合并` };
  }
  if (info.merged) return { ok: true, already: true, info };
  const repoStatus = gitRun(['status', '--porcelain'], info.repo);
  if (repoStatus.ok && repoStatus.out) {
    return { ok: false, error: `主仓库有未提交改动，先提交或清理后再合并到 ${info.base}` };
  }
  const r = gitRun(['merge', '--no-ff', '--no-edit', info.branch], info.repo);
  if (!r.ok) {
    gitRun(['merge', '--abort'], info.repo);
    return { ok: false, error: r.out ? `合并失败（已回滚）：${r.out}` : '合并失败（已回滚）' };
  }
  return { ok: true, output: r.out, info: worktreeInfo(cwd) || info };
}
