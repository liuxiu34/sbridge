import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './paths.mjs';

const DATA_FILE = path.join(DATA_DIR, 'board.json');

const EMPTY = { projects: [], tasks: [] };

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
    title: String(title || '').trim().slice(0, 120) || '新任务',
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

export function deleteTask(db, id) {
  const before = db.tasks.length;
  db.tasks = db.tasks.filter((t) => t.id !== id);
  save(db);
  return db.tasks.length !== before;
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

export function removeNode(db, taskId, nodeId) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return false;
  const removed = task.nodes.find((n) => n.id === nodeId);
  const before = task.nodes.length;
  task.nodes = task.nodes.filter((n) => n.id !== nodeId);
  // 只移除看板记录，本地会话文件一律不碰；分支链不能断：子会话接到被移除会话的上级
  if (removed) for (const n of task.nodes) if (n.parentNodeId === nodeId) n.parentNodeId = removed.parentNodeId || null;
  save(db);
  return task.nodes.length !== before;
}

export function dataFilePath() {
  return DATA_FILE;
}
