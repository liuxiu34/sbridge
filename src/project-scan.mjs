import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* 项目现状（Project Truth）：不依赖具体编程工具，直接读工作区事实。
   目的：无论用户同时用了哪些工具（包括 sbridge 不解析的工具），接力/合并时
   都以磁盘和 git 为准，而不是只信某一条会话链的认知。 */

const SKIP_DIR = new Set([
  '.git', 'node_modules', 'dist', 'release', 'out', 'build', '.next', '.cache',
  '.sbridge-worktrees', '.sbridge-fix', '__pycache__', '.venv', 'venv', 'target', '.idea', '.vscode',
  // 索引/缓存类目录：改动频繁但不是代码，避免把「索引器刷新」误判成外部改动
  '.codeindex', '.wrangler', '.turbo', '.svelte-kit', '.nuxt', '.output', 'coverage',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', '.terraform',
]);
// 数据库/日志/锁文件：不是代码改动
const SKIP_FILE = /(^|[\\/])(\.DS_Store|Thumbs\.db)$|\.(db|db-wal|db-shm|log|lock)$/i;
const isNoisePath = (p) => String(p).split(/[\\/]/).some((seg) => SKIP_DIR.has(seg)) || SKIP_FILE.test(p);
const CACHE_TTL = 8000;
const cache = new Map(); // cwd -> { t, val }

const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

function gitRoot(cwd) {
  try {
    const top = git(['rev-parse', '--show-toplevel'], cwd);
    // 从 worktree 里扫描时统一指回主仓库（默认分支/最近提交更有参考价值）
    let mainRoot = top;
    try {
      const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
      const dir = path.dirname(common);
      if (dir && fs.existsSync(dir)) mainRoot = dir;
    } catch { /* 老版本 git 没有 --path-format，退回 worktree 路径 */ }
    return { root: top, mainRoot };
  } catch {
    return null;
  }
}

function ageTxt(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.round(s / 60)}m 前`;
  if (s < 86400) return `${Math.round(s / 3600)}h 前`;
  return `${Math.round(s / 86400)}d 前`;
}

function recentFiles(cwd, limit = 12, depth = 3) {
  const out = [];
  const walk = (dir, level) => {
    if (level > depth || out.length > 400) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length > 400) break;
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) walk(path.join(dir, e.name), level + 1);
      } else if (e.isFile()) {
        if (isNoisePath(e.name)) continue;
        try {
          const full = path.join(dir, e.name);
          const st = fs.statSync(full);
          if (st.size > 2 * 1024 * 1024) continue;
          out.push({ path: path.relative(cwd, full), mtime: st.mtimeMs });
        } catch { /* ignore */ }
      }
    }
  };
  walk(cwd, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

function scan(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const g = gitRoot(cwd);
  const state = {
    cwd,
    root: g?.root || cwd,
    isGit: !!g,
    branch: null,
    head: null,
    headAt: null,
    headSubject: null,
    recentCommits: [],
    dirty: [],
    dirtyCount: 0,
    diffStat: '',
    recentFiles: [],
    lastChangeAt: null,
    scannedAt: new Date().toISOString(),
  };

  if (g) {
    try { state.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], g.root); } catch { /* ignore */ }
    try { state.head = git(['rev-parse', '--short', 'HEAD'], g.root); } catch { /* ignore */ }
    try { state.headSubject = git(['log', '-1', '--format=%s'], g.root); } catch { /* ignore */ }
    try { state.headAt = git(['log', '-1', '--format=%aI'], g.root); } catch { /* ignore */ }
    try {
      const log = git(['log', '-n', '5', '--format=%h|%aI|%s'], g.root);
      state.recentCommits = log ? log.split('\n').filter(Boolean).map((l) => {
        const [sha, at, ...rest] = l.split('|');
        return { sha, at, subject: rest.join('|') };
      }) : [];
    } catch { /* ignore */ }
    try {
      const status = git(['status', '--porcelain'], g.root);
      const rows = status ? status.split('\n').filter(Boolean) : [];
      // numstat：每文件 +/- 行数（未跟踪文件不在 diff 里，保持 null）
      const numstat = new Map();
      for (const line of (git(['diff', '--numstat', '--no-color'], g.root) || '').split('\n')) {
        const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
        if (m) numstat.set(m[3].trim().replace(/^.* -> /, ''), { added: m[1] === '-' ? null : Number(m[1]), deleted: m[2] === '-' ? null : Number(m[2]) });
      }
      // 过滤索引器/缓存/数据库类路径：只保留真正的代码改动
      state.dirty = rows
        .map((row) => {
          const p = row.slice(3).trim().replace(/^.* -> /, '');
          const ns = numstat.get(p) || null;
          return { code: row.slice(0, 2).trim(), path: row.slice(3).trim(), added: ns?.added ?? null, deleted: ns?.deleted ?? null };
        })
        .filter((d) => !isNoisePath(d.path));
      state.dirtyCount = state.dirty.length;
    } catch { /* ignore */ }
    try {
      const diff = git(['diff', '--stat=110', 'HEAD'], g.root);
      state.diffStat = diff.length > 1400 ? `${diff.slice(0, 1400)}\n…[已截断]` : diff;
    } catch { /* ignore */ }
  }

  state.recentFiles = recentFiles(cwd);

  // 最近变化时间：HEAD 提交时间 / 未提交文件 mtime / 最近修改文件
  let newest = 0;
  if (state.headAt) newest = Math.max(newest, Date.parse(state.headAt) || 0);
  for (const f of state.recentFiles) newest = Math.max(newest, f.mtime || 0);
  if (g && state.dirty.length) {
    for (const d of state.dirty.slice(0, 30)) {
      try { newest = Math.max(newest, fs.statSync(path.join(g.root, d.path)).mtimeMs); } catch { /* ignore */ }
    }
  }
  state.lastChangeAt = newest ? new Date(newest).toISOString() : null;
  return state;
}

/** 结构化扫描（默认 8s 缓存，force=true 强制重扫） */
export function scanProjectState(cwd, { force = false } = {}) {
  if (!cwd) return null;
  const key = path.resolve(cwd);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.t < CACHE_TTL) return hit.val;
  const val = scan(cwd);
  if (cache.size > 200) cache.clear();
  cache.set(key, { t: Date.now(), val });
  return val;
}

/** 把项目现状渲染成检查点里的一段文本：任何工具改的都能带过去 */
export function renderProjectTruth(state, cwd) {
  if (!state) return null;
  const lines = [
    '### 项目当前状态（自动扫描：磁盘与 git 为准，与具体是哪个工具改的无关）',
    `- 工作目录：${cwd || state.cwd}`,
  ];
  if (state.isGit) {
    lines.push(`- Git：${state.branch || '?'} · HEAD ${state.head || '?'}${state.headSubject ? ` · ${state.headSubject}` : ''}${state.headAt ? `（${ageTxt(Date.parse(state.headAt))}）` : ''}`);
    if (state.recentCommits.length) {
      const shown = state.recentCommits.slice(0, 3).map((c) => `${c.sha} ${String(c.at || '').slice(0, 10)} ${c.subject}`).join(' / ');
      lines.push(`- 最近提交：${shown}`);
    }
    lines.push(`- 未提交改动：${state.dirtyCount ? `${state.dirtyCount} 个文件` : '无'}`);
    for (const d of state.dirty.slice(0, 10)) lines.push(`  - ${d.code} ${d.path}`);
    if (state.dirtyCount > 10) lines.push(`  - …另有 ${state.dirtyCount - 10} 个`);
    if (state.diffStat && state.dirtyCount) lines.push(`- 改动规模（git diff --stat）：\n${state.diffStat}`);
  } else {
    lines.push('- Git：不是仓库或不可用（按文件修改时间判断）');
  }
  if (state.recentFiles.length) {
    lines.push('- 最近修改文件：');
    for (const f of state.recentFiles.slice(0, 8)) lines.push(`  - ${f.path}（${ageTxt(f.mtime)}）`);
  }
  lines.push('- 说明：以上是磁盘事实。若其中的改动不是当前会话产生的（例如你同时用了别的工具），按“外部已改过”处理：先读相关文件或看 diff，再决定下一步，不要凭旧认知覆盖。');
  return lines.join('\n').slice(0, 2200);
}

/** 兼容旧调用：返回 { text, git } */
export function scanProjectTruth(cwd, opts = {}) {
  const state = scanProjectState(cwd, opts);
  const text = renderProjectTruth(state, cwd);
  return state ? { text, git: state.isGit, state } : null;
}
