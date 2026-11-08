import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../paths.mjs';

const DB_FILE = path.join(DATA_DIR, 'context.db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, cwd TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  board_task_id TEXT UNIQUE,
  project_id TEXT,
  title TEXT NOT NULL,
  goal TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  session_file TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL,
  role TEXT,
  tool_name TEXT,
  args_json TEXT,
  outcome TEXT,
  outcome_hash TEXT,
  call_id TEXT,
  ts TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id, processed);
CREATE INDEX IF NOT EXISTS idx_events_call ON events(task_id, call_id);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT DEFAULT '',
  count INTEGER NOT NULL DEFAULT 1,
  first_ts TEXT NOT NULL,
  last_ts TEXT NOT NULL,
  outcome_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_evidence_task ON evidence(task_id, kind);
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  project_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'verified',
  evidence_ids TEXT DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_task ON knowledge(task_id, status);
CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  evidence_ids TEXT DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hypotheses_task ON hypotheses(task_id, status);
CREATE TABLE IF NOT EXISTS code_refs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  path TEXT NOT NULL,
  content_hash TEXT,
  last_tool TEXT,
  note TEXT DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE(task_id, path)
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,
  rendered TEXT NOT NULL,
  injected_tokens INTEGER NOT NULL DEFAULT 0,
  llm_tokens INTEGER NOT NULL DEFAULT 0,
  llm_used INTEGER NOT NULL DEFAULT 0,
  loss_json TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'checkpoint',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capture_state (
  task_id TEXT NOT NULL,
  session_file TEXT NOT NULL,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, session_file)
);
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- capture|checkpoint|handoff
  duration_ms INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  extra_json TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_task ON metrics(task_id, kind);
`;

let _db = null;

export function openDb() {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new DatabaseSync(DB_FILE);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA busy_timeout = 5000');
  _db.exec(SCHEMA);
  migrate(_db);
  return _db;
}

/** 轻量迁移：老库缺列时补齐（幂等） */
function migrate(db) {
  const cols = db.prepare('PRAGMA table_info(checkpoints)').all().map((r) => r.name);
  if (!cols.includes('loss_json')) {
    try { db.exec("ALTER TABLE checkpoints ADD COLUMN loss_json TEXT DEFAULT ''"); } catch { /* 并发下可能已加，忽略 */ }
  }
}

export const uid = () => crypto.randomBytes(6).toString('hex');
export const now = () => new Date().toISOString();
export const sha1 = (text) => crypto.createHash('sha1').update(String(text)).digest('hex');
export const fileHash = (file) => sha1(fs.readFileSync(file));

export function dbFilePath() {
  return DB_FILE;
}

/* ---------- tasks / projects ---------- */

export function upsertProject(cwd, name) {
  const db = openDb();
  const normalized = path.resolve(cwd).toLowerCase();
  const rows = db.prepare('SELECT id, cwd FROM projects').all();
  const hit = rows.find((r) => path.resolve(r.cwd).toLowerCase() === normalized);
  if (hit) return hit.id;
  const id = uid();
  db.prepare('INSERT INTO projects (id, name, cwd, created_at) VALUES (?, ?, ?, ?)')
    .run(id, name || path.basename(cwd) || '未命名项目', cwd, now());
  return id;
}

export function ensureTask({ boardTaskId, title, cwd }) {
  const db = openDb();
  const existing = boardTaskId
    ? db.prepare('SELECT * FROM tasks WHERE board_task_id = ?').get(boardTaskId)
    : null;
  if (existing) {
    db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), existing.id);
    return existing.id;
  }
  const id = uid();
  const projectId = cwd ? upsertProject(cwd) : null;
  db.prepare('INSERT INTO tasks (id, board_task_id, project_id, title, goal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, boardTaskId || null, projectId, title || '未命名任务', '', now(), now());
  return id;
}

export function getTask(ctxTaskId) {
  return openDb().prepare('SELECT * FROM tasks WHERE id = ?').get(ctxTaskId);
}

export function findTaskByBoardId(boardTaskId) {
  return openDb().prepare('SELECT * FROM tasks WHERE board_task_id = ?').get(boardTaskId);
}

/* ---------- capture offset ---------- */

export function getOffset(ctxTaskId, file) {
  const row = openDb().prepare('SELECT byte_offset FROM capture_state WHERE task_id = ? AND session_file = ?')
    .get(ctxTaskId, file);
  return row ? row.byte_offset : 0;
}

export function setOffset(ctxTaskId, file, offset) {
  openDb().prepare(`
    INSERT INTO capture_state (task_id, session_file, byte_offset) VALUES (?, ?, ?)
    ON CONFLICT(task_id, session_file) DO UPDATE SET byte_offset = excluded.byte_offset
  `).run(ctxTaskId, file, offset);
}

/* ---------- events ---------- */

export function insertEvent(evt) {
  const db = openDb();
  const r = db.prepare(`
    INSERT INTO events (task_id, session_file, byte_offset, kind, role, tool_name, args_json, outcome, outcome_hash, call_id, ts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    evt.taskId, evt.sessionFile, evt.byteOffset ?? 0, evt.kind, evt.role ?? null,
    evt.toolName ?? null, evt.argsJson ?? null, evt.outcome ?? null,
    evt.outcomeHash ?? null, evt.callId ?? null, evt.ts,
  );
  return Number(r.lastInsertRowid);
}

export function findCallEvent(ctxTaskId, callId) {
  if (!callId) return null;
  return openDb().prepare("SELECT * FROM events WHERE task_id = ? AND call_id = ? AND kind = 'tool_call' ORDER BY id DESC LIMIT 1")
    .get(ctxTaskId, callId);
}

export function pendingEvents(ctxTaskId) {
  return openDb().prepare('SELECT * FROM events WHERE task_id = ? AND processed = 0 ORDER BY id').all(ctxTaskId);
}

export function markProcessed(ids) {
  const db = openDb();
  const stmt = db.prepare('UPDATE events SET processed = 1 WHERE id = ?');
  for (const id of ids) stmt.run(id);
}

export function latestUserEvent(ctxTaskId) {
  return openDb().prepare("SELECT * FROM events WHERE task_id = ? AND kind = 'user' ORDER BY id DESC LIMIT 1").get(ctxTaskId);
}

export function lastAssistantText(ctxTaskId) {
  const row = openDb().prepare("SELECT outcome, args_json, ts FROM events WHERE task_id = ? AND kind = 'assistant' ORDER BY id DESC LIMIT 1").get(ctxTaskId);
  return row || null;
}

/* ---------- evidence ---------- */

export function findEvidenceByHash(ctxTaskId, hash) {
  return openDb().prepare('SELECT * FROM evidence WHERE task_id = ? AND outcome_hash = ?').get(ctxTaskId, hash);
}

export function upsertEvidence({ taskId, kind, summary, detail, hash, ts }) {
  const db = openDb();
  const existing = hash ? findEvidenceByHash(taskId, hash) : null;
  if (existing) {
    db.prepare('UPDATE evidence SET count = count + 1, last_ts = ?, detail = ? WHERE id = ?')
      .run(ts, detail || existing.detail, existing.id);
    return { id: existing.id, merged: true };
  }
  const id = uid();
  db.prepare('INSERT INTO evidence (id, task_id, kind, summary, detail, count, first_ts, last_ts, outcome_hash) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)')
    .run(id, taskId, kind, summary, detail || '', ts, ts, hash || null);
  return { id, merged: false };
}

export function listEvidence(ctxTaskId, limit = 200) {
  return openDb().prepare('SELECT * FROM evidence WHERE task_id = ? ORDER BY last_ts DESC LIMIT ?').all(ctxTaskId, limit);
}

/* ---------- knowledge / hypotheses ---------- */

export function findKnowledgeByContent(ctxTaskId, content) {
  return openDb().prepare('SELECT * FROM knowledge WHERE task_id = ? AND content = ?').get(ctxTaskId, content);
}

export function upsertKnowledge({ taskId, projectId, kind, content, evidenceIds = '' }) {
  const db = openDb();
  const existing = findKnowledgeByContent(taskId, content);
  if (existing) {
    db.prepare("UPDATE knowledge SET updated_at = ?, status = 'verified' WHERE id = ?").run(now(), existing.id);
    return { id: existing.id, merged: true };
  }
  const id = uid();
  db.prepare('INSERT INTO knowledge (id, task_id, project_id, kind, content, status, evidence_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, taskId, projectId ?? null, kind, content, 'verified', evidenceIds, now(), now());
  return { id, merged: false };
}

export function upsertHypothesis({ taskId, content, status = 'open', evidenceIds = '' }) {
  const db = openDb();
  const existing = db.prepare('SELECT * FROM hypotheses WHERE task_id = ? AND content = ?').get(taskId, content);
  if (existing) {
    if (existing.status !== status) {
      db.prepare('UPDATE hypotheses SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), existing.id);
    }
    return { id: existing.id, merged: true };
  }
  const id = uid();
  db.prepare('INSERT INTO hypotheses (id, task_id, content, status, evidence_ids, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, taskId, content, status, evidenceIds, now());
  return { id, merged: false };
}

export function listKnowledge(ctxTaskId, status = null) {
  const db = openDb();
  return status
    ? db.prepare('SELECT * FROM knowledge WHERE task_id = ? AND status = ? ORDER BY updated_at DESC').all(ctxTaskId, status)
    : db.prepare('SELECT * FROM knowledge WHERE task_id = ? ORDER BY updated_at DESC').all(ctxTaskId);
}

/* ---------- 项目级长期认知（跨任务共享沉淀） ----------
 * 以 task_id = '__project__:<projectId>' 作为哨兵行存于 knowledge 表，
 * 同一项目下所有任务的检查点都能取到。 */

export const projectKnowledgeKey = (projectId) => `__project__:${projectId}`;

export function upsertProjectKnowledge({ projectId, kind, content }) {
  const db = openDb();
  const key = projectKnowledgeKey(projectId);
  const existing = db.prepare('SELECT * FROM knowledge WHERE task_id = ? AND content = ?').get(key, content);
  if (existing) {
    db.prepare("UPDATE knowledge SET updated_at = ?, status = 'verified' WHERE id = ?").run(now(), existing.id);
    return { id: existing.id, merged: true };
  }
  const id = uid();
  db.prepare('INSERT INTO knowledge (id, task_id, project_id, kind, content, status, evidence_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, key, projectId, kind, content, 'verified', '', now(), now());
  return { id, merged: false };
}

export function listProjectKnowledge(projectId, status = null) {
  const db = openDb();
  const key = projectKnowledgeKey(projectId);
  return status
    ? db.prepare('SELECT * FROM knowledge WHERE task_id = ? AND status = ? ORDER BY updated_at DESC').all(key, status)
    : db.prepare('SELECT * FROM knowledge WHERE task_id = ? ORDER BY updated_at DESC').all(key);
}

export function listHypotheses(ctxTaskId, status = null) {
  const db = openDb();
  return status
    ? db.prepare('SELECT * FROM hypotheses WHERE task_id = ? AND status = ? ORDER BY updated_at DESC').all(ctxTaskId, status)
    : db.prepare('SELECT * FROM hypotheses WHERE task_id = ? ORDER BY updated_at DESC').all(ctxTaskId);
}

/* ---------- code refs ---------- */

export function upsertCodeRef({ taskId, filePath, contentHash, lastTool, note = '' }) {
  const db = openDb();
  db.prepare(`
    INSERT INTO code_refs (id, task_id, path, content_hash, last_tool, note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id, path) DO UPDATE SET
      content_hash = excluded.content_hash,
      last_tool = excluded.last_tool,
      updated_at = excluded.updated_at
  `).run(uid(), taskId, filePath, contentHash, lastTool, note, now());
}

export function listCodeRefs(ctxTaskId) {
  return openDb().prepare('SELECT * FROM code_refs WHERE task_id = ? ORDER BY updated_at DESC').all(ctxTaskId);
}

/* ---------- checkpoints / agent sessions ---------- */

export function nextCheckpointVersion(ctxTaskId) {
  const row = openDb().prepare('SELECT MAX(version) v FROM checkpoints WHERE task_id = ?').get(ctxTaskId);
  return (row?.v || 0) + 1;
}

export function insertCheckpoint({ taskId, payload, rendered, injectedTokens, llmTokens, llmUsed, lossJson = '' }) {
  const id = uid();
  const version = nextCheckpointVersion(taskId);
  openDb().prepare('INSERT INTO checkpoints (id, task_id, version, payload, rendered, injected_tokens, llm_tokens, llm_used, loss_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, taskId, version, JSON.stringify(payload), rendered, injectedTokens, llmTokens, llmUsed ? 1 : 0, lossJson || '', now());
  return { id, version };
}

export function latestCheckpoint(ctxTaskId) {
  return openDb().prepare('SELECT * FROM checkpoints WHERE task_id = ? ORDER BY version DESC LIMIT 1').get(ctxTaskId);
}

/* ---------- 损耗报告统计 ---------- */

export function countEvents(ctxTaskId) {
  return openDb().prepare('SELECT COUNT(*) c FROM events WHERE task_id = ?').get(ctxTaskId).c;
}

export function countEvidence(ctxTaskId) {
  const row = openDb().prepare('SELECT COUNT(*) c, COALESCE(SUM(count - 1), 0) merged FROM evidence WHERE task_id = ?').get(ctxTaskId);
  return { total: row.c, merged: row.merged };
}

export function insertAgentSession({ taskId, tool, sessionId, file, role = 'checkpoint' }) {
  openDb().prepare('INSERT INTO agent_sessions (id, task_id, tool, session_id, file, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(uid(), taskId, tool, sessionId, file, role, now());
}

export function listAgentSessions(ctxTaskId) {
  return openDb().prepare('SELECT * FROM agent_sessions WHERE task_id = ? ORDER BY created_at DESC').all(ctxTaskId);
}

/* ---------- metrics ---------- */

export function recordMetric({ taskId, kind, durationMs, tokens = 0, extra = {} }) {
  openDb().prepare('INSERT INTO metrics (task_id, kind, duration_ms, tokens, extra_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(taskId, kind, Math.round(durationMs), tokens, JSON.stringify(extra), now());
}

export function metricsSummary(ctxTaskId) {
  const dbi = openDb();
  const agg = dbi.prepare(`
    SELECT kind, COUNT(*) count, SUM(duration_ms) totalMs, SUM(tokens) totalTokens
    FROM metrics WHERE task_id = ? GROUP BY kind
  `).all(ctxTaskId);
  const byKind = Object.fromEntries(agg.map((r) => [r.kind, r]));
  const llmTokens = dbi.prepare(`
    SELECT COALESCE(SUM(CAST(json_extract(extra_json, '$.llmTokens') AS INTEGER)), 0) s
    FROM metrics WHERE task_id = ? AND kind IN ('handoff','checkpoint')
  `).get(ctxTaskId).s;
  const llmCount = dbi.prepare(`
    SELECT COUNT(*) c FROM metrics
    WHERE task_id = ? AND json_extract(extra_json, '$.llmUsed') = 1
  `).get(ctxTaskId).c;
  const dupSaved = dbi.prepare('SELECT COALESCE(SUM(count - 1), 0) s FROM evidence WHERE task_id = ?').get(ctxTaskId).s;
  return {
    byKind,
    handoffCount: byKind.handoff?.count || 0,
    injectedTokens: byKind.handoff?.totalTokens || 0,
    llmTokens,
    llmUsedCount: llmCount,
    checkpointCount: byKind.checkpoint?.count || 0,
    avgHandoffMs: byKind.handoff ? Math.round(byKind.handoff.totalMs / byKind.handoff.count) : 0,
    // 规则去重省掉的重复记录条数（同一证据不重复入账）
    duplicatedEvidenceMerged: dupSaved,
  };
}
