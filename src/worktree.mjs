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
    // 记录诞生分支：合并目标应该是它，而不是合并那一刻主仓库恰好所在的分支
    let bornFrom = '';
    try {
      bornFrom = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { /* ignore */ }
    // 写进这个 worktree 自己的 .git 文件指向的元数据目录（不污染工作树，不进 dirty 计数）
    try {
      const dotGit = fs.readFileSync(path.join(wtPath, '.git'), 'utf8').trim();
      const m = /^gitdir:\s*(.+)$/i.exec(dotGit);
      if (m) fs.writeFileSync(path.join(m[1], 'sbridge-born-from'), bornFrom, 'utf8');
    } catch { /* ignore */ }
    return { cwd: wtPath, created: true, branch, repo: top, bornFrom, reason: '' };
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

/** worktree 的诞生分支：优先读 git 元数据里的记录文件，退回空（调用方自行兜底） */
export function bornBranchOf(top) {
  try {
    const dotGit = fs.readFileSync(path.join(top, '.git'), 'utf8').trim();
    const m = /^gitdir:\s*(.+)$/im.exec(dotGit);
    if (m) {
      const marker = path.join(m[1], 'sbridge-born-from');
      if (fs.existsSync(marker)) {
        const v = fs.readFileSync(marker, 'utf8').trim();
        if (v) return v;
      }
    }
  } catch { /* ignore */ }
  return '';
}

/** 把某目录（可能是 worktree）映射回它的主仓库顶层；非 sbridge worktree 返回 null。
    目录已被手动删除时也能推：worktree 目录名含主仓库名，且它就在主仓库旁的 .sbridge-worktrees 下。 */
export function mainRepoOf(cwd) {
  if (!cwd || !isSbridgeWorktree(cwd)) return null;
  if (fs.existsSync(cwd)) {
    try {
      const common = git(['rev-parse', '--git-common-dir'], cwd);
      return path.dirname(path.resolve(cwd, common));
    } catch { /* 目录在但 git 元数据坏了，走路径反推 */ }
  }
  // 目录没了：.sbridge-worktrees/<主仓库名>-<标签>-<序号>，主仓库名本身可含 '-'，
  // 不能按 '-' 切首段——改成查 git 元数据：git worktree list --porcelain 会留着
  // prunable 条目（目录删了元数据还在），从里面反查这个路径的主仓库。
  const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
  const norm = parts.join('/');
  const idx = norm.toLowerCase().lastIndexOf('.sbridge-worktrees/');
  if (idx === -1) return null;
  // parts 已去掉段间分隔符；POSIX 绝对路径开头的 '/' 被吃掉要补回（Windows 盘符路径不能补）
  const isPosixAbs = String(cwd).startsWith('/');
  const parent = isPosixAbs ? `/${norm.slice(0, idx - 1)}` : norm.slice(0, idx - 1);
  if (!fs.existsSync(parent)) return null;
  // 主仓库候选：父目录下所有 git 仓库（一般就几个），谁的 worktree 列表里有这个路径
  let candidates = [];
  try { candidates = fs.readdirSync(parent, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(parent, e.name)); } catch { return null; }
  for (const repoDir of candidates) {
    if (!fs.existsSync(path.join(repoDir, '.git'))) continue;
    const r = gitRun(['worktree', 'list', '--porcelain'], repoDir);
    if (!r.ok) continue;
    let keep = false;
    for (const line of r.out.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const p = line.slice('worktree '.length).trim().split(/[\\/]+/).filter(Boolean).join('/');
      if (p === norm) { keep = true; break; }
    }
    if (keep) return repoDir;
  }
  return null;
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
  // 合并目标：worktree 的诞生分支；读不到（旧版创建的）才退回主仓库当前分支
  let base = bornBranchOf(top);
  let baseIsBorn = true;
  if (!base && repo) {
    try { base = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo); baseIsBorn = false; } catch { /* ignore */ }
  }
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
  // 主仓库当前分支：给前端展示「合并目标 != 主仓库当前所在」的提示用
  let repoHead = '';
  if (repo) { try { repoHead = git(['rev-parse', '--abbrev-ref', 'HEAD'], repo); } catch { /* ignore */ } }
  return {
    path: top, branch, repo, base, baseIsBorn, repoHead, ahead, behind,
    dirtyCount: statusLines.length,
    files: statusLines.slice(0, 40),
    merged,
  };
}

/** 把 worktree 分支合并回它的诞生分支（不是主仓库恰好所在的分支）；
    有未提交改动/冲突时拒绝并回滚。主仓库当前分支 ≠ 诞生分支时先切过去，合并完切回来。 */
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
  // 主仓库当前分支就是诞生分支 → 直接合并；否则先切到诞生分支，合并完切回原分支
  const originalHead = info.repoHead;
  const switched = !!originalHead && originalHead !== info.base;
  if (switched) {
    const co = gitRun(['checkout', info.base], info.repo);
    if (!co.ok) return { ok: false, error: `切到 ${info.base} 失败：${co.out}` };
  }
  const r = gitRun(['merge', '--no-ff', '--no-edit', info.branch], info.repo);
  if (!r.ok) {
    gitRun(['merge', '--abort'], info.repo);
    if (switched) gitRun(['checkout', originalHead], info.repo);
    return { ok: false, error: r.out ? `合并失败（已回滚）：${r.out}` : '合并失败（已回滚）' };
  }
  if (switched) gitRun(['checkout', originalHead], info.repo);
  return { ok: true, output: r.out, mergedTo: info.base, info: worktreeInfo(cwd) || info };
}

/** 清理 prunable 的 worktree（目录被手动 rm -rf 但 git 元数据还在的幽灵条目） */
export function pruneStaleWorktrees(repo) {
  if (!repo || !fs.existsSync(repo)) return;
  try { gitRun(['worktree', 'prune'], repo); } catch { /* ignore */ }
}
