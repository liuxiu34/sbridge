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

export function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DATA_FILE);
  cache = null;
}

export const uid = () => crypto.randomBytes(6).toString('hex');

export function createProject(db, name) {
  const project = {
    id: uid(),
    name: String(name || '未命名项目').trim().slice(0, 60) || '未命名项目',
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
  const before = task.nodes.length;
  task.nodes = task.nodes.filter((n) => n.id !== nodeId);
  save(db);
  return task.nodes.length !== before;
}

export function dataFilePath() {
  return DATA_FILE;
}
