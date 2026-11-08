import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* 项目现状扫描（Project Truth Scan）：
   合并/接力不依赖「谁最新」的判断，直接读工作区当前事实（git 分支/提交/未提交改动/最近修改文件），
   和历史会话的认知一起注入。历史会话没有 worktree 隔离、判断谁最新不准时，这一步兜底。 */

const SKIP_DIR = new Set(['.git', 'node_modules', 'dist', 'release', 'out', 'build', '.next', '.cache', '.sbridge-worktrees', '__pycache__', '.venv', 'venv', 'target']);
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

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
        try {
          const st = fs.statSync(path.join(dir, e.name));
          if (st.size > 2 * 1024 * 1024) continue;
          out.push({ rel: path.relative(cwd, path.join(dir, e.name)), mtime: st.mtimeMs });
        } catch { /* ignore */ }
      }
    }
  };
  walk(cwd, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export function scanProjectTruth(cwd) {
  if (!cwd || !fs.existsSync(cwd)) return null;
  const lines = ['### 项目当前状态（自动扫描，供接续判断，以此为准）', `- 工作目录：${cwd}`];
  let isGit = false;
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
    isGit = true;
    lines.push(`- Git 分支：${branch}`);
    const log = git(['log', '-n', '6', '--date=short', '--pretty=format:%h|%ad|%s'], cwd);
    if (log) {
      lines.push('- 最近提交：');
      for (const l of log.split('\n').slice(0, 6)) {
        const [, date, msg] = l.split('|');
        lines.push(`  - ${l.split('|')[0]} ${date} ${msg}`);
      }
    }
    const status = git(['status', '--porcelain'], cwd);
    const statusLines = status ? status.split('\n').filter(Boolean) : [];
    lines.push(`- 未提交改动：${statusLines.length ? `${statusLines.length} 个文件` : '无'}`);
    for (const s of statusLines.slice(0, 12)) lines.push(`  - ${s}`);
    if (statusLines.length > 12) lines.push(`  - …另有 ${statusLines.length - 12} 个`);
  } catch {
    lines.push('- Git：不是仓库或不可用（按最近修改文件判断）');
  }
  try {
    const recent = recentFiles(cwd);
    if (recent.length) {
      lines.push('- 最近修改文件：');
      for (const f of recent.slice(0, 10)) lines.push(`  - ${f.rel}（${ageTxt(f.mtime)}）`);
    }
  } catch { /* ignore */ }
  const text = lines.join('\n').slice(0, 1800);
  return { text, git: isGit };
}
