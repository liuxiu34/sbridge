import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* 只读 git 查询：给右侧面板的「改动」用。
   只做 status / diff / 读文件，任何写操作都不在这里做。 */

const IGNORED = new Set(['.git', 'node_modules', 'dist', 'release', '.sbridge-worktrees', '.sbridge-fix', '__pycache__', '.venv', 'venv', 'target']);
const DIFF_MAX = 200 * 1024;   // 200KB
const LIST_MAX = 400;          // 单目录最多 400 条
const READ_MAX = 256 * 1024;   // 预览上限 256KB

function gitRun(args, cwd) {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, out: String(out || '') };
  } catch (err) {
    return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` || String(err.message || '') };
  }
}

/** 相对路径 → 绝对路径，并确认没跑出工作目录 */
export function resolveInside(cwd, rel) {
  const base = path.resolve(cwd);
  const abs = path.resolve(base, rel || '.');
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error('路径越界');
  return { base, abs, rel: path.relative(base, abs).split(path.sep).join('/') };
}

const statusLabel = (code) => {
  if (code === '??') return '新增';
  if (code.includes('D')) return '删除';
  if (code.includes('R')) return '重命名';
  if (code.includes('A')) return '新增';
  return '修改';
};

/** 仓库改动概览；传 filePath 时返回该文件的 unified diff */
export function inspectChanges(cwd, filePath) {
  const { base, rel } = resolveInside(cwd, '.');
  if (!fs.existsSync(base)) return { isGit: false, reason: '目录不存在' };

  const top = gitRun(['rev-parse', '--show-toplevel'], base);
  if (!top.ok) return { isGit: false, reason: '不是 git 仓库' };

  const branch = gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], base).out.trim();
  const status = gitRun(['status', '--porcelain'], base).out.split('\n').filter(Boolean);
  const files = status.map((line) => {
    const code = line.slice(0, 2).trim() || line.slice(0, 2);
    const file = line.slice(3).trim().replace(/^.* -> /, '');
    return { path: file, code, label: statusLabel(code) };
  }).slice(0, LIST_MAX);

  if (filePath) {
    const target = resolveInside(base, filePath);
    if (IGNORED.has(target.rel.split('/')[0])) throw new Error('该路径不可查看');
    let diff = gitRun(['diff', '--no-color', '--', target.rel], base).out;
    if (!diff.trim()) {
      // 未跟踪的新文件：diff 为空，直接用文件内容拼一段「全新增」
      const abs = path.resolve(base, target.rel);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const size = fs.statSync(abs).size;
        if (size <= DIFF_MAX) {
          const text = fs.readFileSync(abs, 'utf8');
          diff = text.split('\n').map((l) => `+${l}`).join('\n');
        }
      }
    }
    const truncated = diff.length > DIFF_MAX;
    return {
      isGit: true, branch, file: target.rel, diff: truncated ? diff.slice(0, DIFF_MAX) : diff,
      truncated, added: (diff.match(/^\+[^+]/gm) || []).length, deleted: (diff.match(/^-[^-]/gm) || []).length,
    };
  }

  const stat = gitRun(['diff', '--stat', '--no-color'], base).out.trim();
  return { isGit: true, branch, repo: top.out.trim(), files, stat, dirtyCount: files.length, rel };
}

/** 列目录：目录在前；忽略构建产物与依赖目录 */
export function listDir(cwd, rel) {
  const { base, abs, rel: relPath } = resolveInside(cwd, rel || '.');
  if (!fs.existsSync(abs)) throw new Error('目录不存在');
  if (!fs.statSync(abs).isDirectory()) throw new Error('不是目录');
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => !IGNORED.has(e.name))
    .map((e) => {
      const full = path.join(abs, e.name);
      let size = 0;
      try { size = e.isDirectory() ? 0 : fs.statSync(full).size; } catch { /* ignore */ }
      return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
    .slice(0, LIST_MAX);
  return { dir: relPath === '.' ? '' : relPath, entries };
}

/** 读文本预览；二进制或超大只返回元信息 */
export function readFilePreview(cwd, rel) {
  const { abs, rel: relPath } = resolveInside(cwd, rel);
  if (!fs.existsSync(abs)) throw new Error('文件不存在');
  const st = fs.statSync(abs);
  if (st.isDirectory()) throw new Error('这是目录');
  if (st.size > READ_MAX) return { path: relPath, size: st.size, binary: false, truncated: true, text: '' };
  const buf = fs.readFileSync(abs);
  const head = buf.subarray(0, Math.min(buf.length, 4096));
  if (head.includes(0)) return { path: relPath, size: st.size, binary: true, truncated: false, text: '' };
  return { path: relPath, size: st.size, binary: false, truncated: false, text: buf.toString('utf8') };
}
