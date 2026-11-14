import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './paths.mjs';

const DATA_FILE = path.join(DATA_DIR, 'board.json');

const EMPTY = { projects: [], tasks: [] };

/* 标题/文本清洗：U+FFFD（替换符）说明源数据在别的编码下就丢过字节，
   存进看板只会显示成"钻石问号"乱码。统一替换成可读的占位符。 */
export function cleanTitle(s) {
  return String(s || '').replace(/\uFFFD/g, '？').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
}

/* 按 (mtime,size) 缓存解析结果：handleApi 每个请求都会 load()，
   看板数据大时反复 JSON.parse 会拖慢首屏和每个 API。save() 后立刻失效。 */
let cache = null;

export function load() {
  try {
    const st = fs.statSync(DATA_FILE);
    const key = `${st.mtimeMs}|${st.size}`;
    if (cache && cache.key === key) return cache.db;
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const db = JSON.parse(raw);
    const val = { projects: db.projects || [], tasks: db.tasks || [] };
    // 读入时顺手清洗历史数据里的 U+FFFD 乱码标题（写入侧已清洗，这里兜底旧数据）
    let dirty = false;
    for (const t of val.tasks) {
      const fixed = cleanTitle(t.title);
      if (fixed !== t.title) { t.title = fixed; dirty = true; }
    }
    if (dirty) { try { fs.writeFileSync(DATA_FILE, JSON.stringify(val, null, 1), 'utf8'); } catch { /* 只读盘时忽略 */ } }
    cache = { key, db: val };
    return val;
  } catch {
    cache = null;
    return structuredClone(EMPTY);
  }
}

/** 每天首次保存前留一份看板备份（保留最近 30 天），误删/写坏时可手工恢复 */
let lastBackupDay = null;
function backupDaily() {
  const day = new Date().toISOString().slice(0, 10);
  if (lastBackupDay === day) return;
  lastBackupDay = day;
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `board.${day}.json`);
    if (!fs.existsSync(dest)) fs.copyFileSync(DATA_FILE, dest);
    const old = fs.readdirSync(dir).filter((f) => /^board\.\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (old.length > 30) {
      try { fs.rmSync(path.join(dir, old.shift())); } catch { /* ignore */ }
    }
  } catch { /* 备份失败不影响正常保存 */ }
}

export function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  backupDaily();
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  cache = null;
}

export const uid = () => crypto.randomBytes(6).toString('hex');

export function createProject(db, name, cwd = null) {
  const project = {
    id: uid(),
    name: String(name || '未命名项目').trim().slice(0, 60) || '未命名项目',
    // 绑定的项目目录（自动获取按 cwd 归组；手工建项目填了目录也写这里）
    cwd: cwd ? String(cwd) : null,
    createdAt: new Date().toISOString(),
  };
  db.projects.push(project);
  save(db);
  return project;
}

export function createTask(db, { projectId, title }) {
  const task = {
    id: uid(),
    projectId: projectId || null,
    title: cleanTitle(title).slice(0, 120) || '新任务',
    status: 'active',
    note: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [],
  };
  db.tasks.push(task);
  save(db);
  return task;
}

export function updateTask(db, id, patch) {
  const task = db.tasks.find((t) => t.id === id);
  if (!task) return null;
  for (const key of ['title', 'status', 'note', 'projectId']) {
    if (key in patch) task[key] = patch[key];
  }
  task.updatedAt = new Date().toISOString();
  save(db);
  return task;
}

/* 归档 / 恢复：不再做物理删除。归档只打时间戳，节点与分支链、会话文件都原样保留，
   恢复时把时间戳去掉即可回到原位（父节点仍归档时该会话按根节点展示）。 */
export function archiveNode(db, taskId, nodeId, archived = true) {
  const task = db.tasks.find((t) => t.id === taskId);
  const node = task?.nodes.find((n) => n.id === nodeId);
  if (!node) return false;
  if (archived) node.archivedAt = new Date().toISOString();
  else delete node.archivedAt;
  task.updatedAt = new Date().toISOString();
  save(db);
  return true;
}

/** 全部已归档会话（跨任务），按归档时间倒序 */
export function listArchived(db) {
  const items = [];
  for (const t of db.tasks) {
    for (const n of t.nodes || []) {
      if (!n.archivedAt) continue;
      items.push({
        taskId: t.id,
        taskTitle: t.title,
        nodeId: n.id,
        tool: n.tool,
        title: n.title || '(会话)',
        cwd: n.cwd || '',
        sessionId: n.sessionId || '',
        archivedAt: n.archivedAt,
      });
    }
  }
  return items.sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
}

export function addNode(db, taskId, node) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const full = { id: uid(), importedAt: new Date().toISOString(), ...node };
  task.nodes.push(full);
  task.updatedAt = new Date().toISOString();
  save(db);
  return full;
}

export function dataFilePath() {
  return DATA_FILE;
}
