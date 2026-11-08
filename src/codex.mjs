import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { readJsonl, writeJsonl, expandPath, isoForFile, dayParts, uuid, nowIso, truncate, backupFile, readFirstLine } from './util.mjs';
import { DATA_DIR } from './paths.mjs';
import { buildConversation, messageBody } from './model.mjs';

export const name = 'codex';

export function sessionsRoot() {
  const env = process.env.CODEX_HOME;
  return env ? path.join(expandPath(env), 'sessions') : path.join(os.homedir(), '.codex', 'sessions');
}

function firstLineText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => c.text || '').filter(Boolean).join('\n');
}

/** 注入型上下文（AGENTS.md、应用上下文等）不算真实用户发言 */
function isInjectedUserText(text) {
  const t = text.trimStart();
  return t.startsWith('<') || /^#\s*AGENTS\.md instructions/.test(t);
}

/** 读取 rollout 文件（session_meta + response_item JSONL） */
function readRollout(file) {
  const records = readJsonl(file);
  const meta = records.find((r) => r.type === 'session_meta')?.payload || {};
  const messages = [];
  let assistant = null;
  const pendingCalls = new Map();

  const flush = () => {
    if (assistant && (assistant.text || assistant.tools.length)) messages.push(assistant);
    assistant = null;
  };
  const ensureAssistant = (ts) => {
    if (!assistant) assistant = { role: 'assistant', text: '', ts, tools: [] };
    return assistant;
  };

  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const ts = rec.timestamp || rec.payload?.timestamp || meta.timestamp || nowIso();
    if (rec.type !== 'response_item') continue;
    const p = rec.payload || {};

    if (p.type === 'message') {
      const text = firstLineText(p.content);
      if (p.role === 'user') {
        if (!text || isInjectedUserText(text)) continue;
        flush();
        messages.push({ role: 'user', text, ts, tools: [] });
      } else if (p.role === 'assistant') {
        if (!text) continue;
        const a = ensureAssistant(ts);
        a.text = a.text ? `${a.text}\n\n${text}` : text;
      }
      continue;
    }

    if (p.type === 'function_call' || p.type === 'custom_tool_call') {
      const callId = p.call_id || p.id || `call-${i}`;
      const tool = { name: p.name || p.namespace || 'tool', args: p.arguments ?? p.input, outcome: '' };
      ensureAssistant(ts).tools.push(tool);
      pendingCalls.set(callId, tool);
      continue;
    }

    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
      const tool = pendingCalls.get(p.call_id);
      if (tool) {
        const out = typeof p.output === 'string' ? p.output : firstLineText(p.output);
        tool.outcome = summarizeOutput(out);
      }
      continue;
    }
    // reasoning / additional_tools / 其他内部条目一律忽略
  }
  flush();

  // 悬空调用 = 有 call 无 output，上个会话可能中断在工具调用中间
  const interruptedCalls = [...pendingCalls.values()].filter((t) => !t.outcome).length;

  return buildConversation({
    sourceTool: 'codex',
    sourceFile: file,
    id: meta.id || meta.session_id || path.basename(file, '.jsonl'),
    cwd: meta.cwd || '',
    createdAt: meta.timestamp || nowIso(),
    title: '',
    messages,
    interruptedCalls,
  });
}

function summarizeOutput(out) {
  if (!out) return '';
  const text = String(out).replace(/\s+/g, ' ').trim();
  const size = Math.round(Buffer.byteLength(String(out)) / 1024);
  return `${truncate(text, 70)}${size > 1 ? ` (~${size}KB)` : ''}`;
}

/* ---------- Codex Desktop SQLite 来源 ----------
 * 桌面版大部分会话没有 rollout 文件，正文在 thread_history_1.sqlite；
 * 会话清单在 state_5.sqlite 的 threads 表。 */

function cleanCwd(cwd) {
  return cwd ? String(cwd).replace(/^\\\\\?\\/, '') : '';
}

function openCodexDb(file) {
  const p = path.join(os.homedir(), '.codex', file);
  if (!fs.existsSync(p)) return null;
  try {
    return new DatabaseSync(p, { readOnly: true });
  } catch {
    return null;
  }
}

function findRolloutPath(db, threadId) {
  try {
    const row = db.prepare('SELECT rollout_path FROM threads WHERE id = ?').get(threadId);
    if (!row) return null;
    const p = cleanCwd(row.rollout_path);
    return p && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** threads 表全量清单；file 为 sqlite: 前缀表示正文只在库里 */
function listFromSqlite() {
  const db = openCodexDb('state_5.sqlite');
  if (!db) return [];
  try {
    const hist = openCodexDb('thread_history_1.sqlite');
    const covered = hist
      ? new Set(hist.prepare('SELECT DISTINCT thread_id FROM thread_items').all().map((r) => r.thread_id))
      : new Set();
    const rows = db.prepare('SELECT id, cwd, title, created_at_ms, updated_at_ms FROM threads ORDER BY updated_at_ms DESC').all();
    const out = [];
    for (const r of rows) {
      const rollout = findRolloutPath(db, r.id);
      if (!covered.has(r.id) && !rollout) continue;
      out.push({
        file: rollout || `sqlite:${r.id}`,
        id: r.id,
        cwd: cleanCwd(r.cwd),
        createdAt: new Date(r.created_at_ms || r.updated_at_ms).toISOString(),
        updatedAt: new Date(r.updated_at_ms),
        size: 0,
        title: truncate((r.title || '').replace(/\s+/g, ' '), 60),
      });
    }
    return out;
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

/** 从 thread_items 重建统一会话模型（rollout 文件缺失时的正文来源） */
function readFromSqlite(threadId) {
  const db = openCodexDb('state_5.sqlite');
  const hist = openCodexDb('thread_history_1.sqlite');
  if (!db || !hist) throw new Error('Codex 本地库不可用');
  try {
    const meta = db.prepare('SELECT id, cwd, created_at_ms, updated_at_ms, title FROM threads WHERE id = ?').get(threadId);
    if (!meta) throw new Error(`Codex 会话不存在: ${threadId}`);
    const items = hist.prepare('SELECT item_type, item_json FROM thread_items WHERE thread_id = ? ORDER BY rollout_ordinal').all(threadId);

    const messages = [];
    let assistant = null;
    const flush = () => {
      if (assistant && (assistant.text || assistant.tools.length)) messages.push(assistant);
      assistant = null;
    };
    for (const row of items) {
      let item;
      try { item = JSON.parse(row.item_json); } catch { continue; }
      const ts = new Date().toISOString();
      if (item.type === 'userMessage') {
        const text = (item.content || []).map((c) => c.text || '').filter(Boolean).join('\n');
        if (!text || isInjectedUserText(text)) continue;
        flush();
        messages.push({ role: 'user', text, ts, tools: [] });
      } else if (item.type === 'agentMessage') {
        if (!item.text) continue;
        if (!assistant) assistant = { role: 'assistant', text: '', ts, tools: [] };
        assistant.text = assistant.text ? `${assistant.text}\n\n${item.text}` : item.text;
      } else if (item.type === 'commandExecution') {
        if (!assistant) assistant = { role: 'assistant', text: '', ts, tools: [] };
        assistant.tools.push({ name: 'exec', args: { command: item.command || '' }, outcome: '' });
      } else if (item.type === 'fileChange') {
        for (const change of item.changes || []) {
          if (!assistant) assistant = { role: 'assistant', text: '', ts, tools: [] };
          assistant.tools.push({ name: 'edit', args: { path: change.path }, outcome: '' });
        }
      } else if (item.type === 'mcpToolCall') {
        if (!assistant) assistant = { role: 'assistant', text: '', ts, tools: [] };
        assistant.tools.push({ name: `${item.server || 'mcp'}/${item.tool || 'tool'}`, args: item.arguments ?? {}, outcome: item.status || '' });
      }
      // reasoning / webSearch / contextCompaction / 图片类不进入统一模型
    }
    flush();

    return buildConversation({
      sourceTool: 'codex',
      sourceFile: `sqlite:${threadId}`,
      id: threadId,
      cwd: cleanCwd(meta.cwd),
      createdAt: new Date(meta.created_at_ms || meta.updated_at_ms).toISOString(),
      title: meta.title || '',
      messages,
    });
  } finally {
    try { db.close(); hist.close(); } catch { /* ignore */ }
  }
}

export function read(ref) {
  if (typeof ref === 'string' && ref.startsWith('sqlite:')) return readFromSqlite(ref.slice(7));
  return readRollout(ref);
}

export function list({ cwd, limit = 20 } = {}) {
  const root = sessionsRoot();
  const files = [];
  if (fs.existsSync(root)) {
    const walk = (dir) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full);
        else if (ent.name.endsWith('.jsonl')) files.push(full);
      }
    };
    walk(root);
  }

  const fileItems = files.map((file) => {
    try {
      const stat = fs.statSync(file);
      const meta = JSON.parse(readFirstLine(file)).payload || {};
      return { file, id: meta.id || meta.session_id, cwd: meta.cwd, createdAt: meta.timestamp, updatedAt: stat.mtime, size: stat.size, title: '' };
    } catch {
      return null;
    }
  }).filter(Boolean);

  // 合并 SQLite 清单（桌面版 100+ 会话的正文在 thread_history 库里）
  const byId = new Map();
  for (const it of listFromSqlite()) byId.set(it.id, it);
  for (const it of fileItems) {
    const known = byId.get(it.id);
    if (known) {
      // 有真实 rollout 文件的优先用文件（读取更快、增量捕获可用）
      byId.set(it.id, { ...known, file: it.file, updatedAt: it.updatedAt, size: it.size });
    } else {
      byId.set(it.id, it);
    }
  }
  const items = [...byId.values()];

  const filtered = cwd ? items.filter((it) => it.cwd && expandPath(it.cwd).toLowerCase() === expandPath(cwd).toLowerCase()) : items;
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** Codex 对 session_meta 有较严的字段要求，用本机最近一次原生会话的元数据做模板 */
function metaTemplate() {
  const items = list({ limit: 40 });
  for (const item of items) {
    if (typeof item.file !== 'string' || item.file.startsWith('sqlite:')) continue;
    try {
      const payload = JSON.parse(readFirstLine(item.file)).payload || {};
      if (!payload.base_instructions || String(payload.originator).includes('sbridge')) continue;
      return payload;
    } catch {
      // 跳过损坏文件
    }
  }
  return null;
}

export function write(conv, { cwd, model, register = true } = {}) {
  const id = uuid();
  const now = new Date();
  const { year, month, day } = dayParts(now);
  const dir = path.join(sessionsRoot(), year, month, day);
  const file = path.join(dir, `rollout-${isoForFile(now)}-${id}.jsonl`);
  const targetCwd = expandPath(cwd || conv.cwd || process.cwd());
  const ts = now.toISOString();
  const tpl = metaTemplate();
  if (!tpl) throw new Error('本机没有可用的原生 Codex 会话作模板，请先用 codex 跑一次对话再转换');

  const { git, ...rest } = tpl;
  const meta = {
    ...rest,
    id,
    session_id: id,
    timestamp: ts,
    cwd: targetCwd,
    runtime_workspace_roots: [targetCwd],
    originator: 'sbridge',
    source: 'cli',
    thread_source: 'user',
    history_mode: 'paginated',
    context_window: { window_id: uuid() },
  };

  const records = [{ timestamp: ts, ordinal: 0, type: 'session_meta', payload: meta }];

  let ordinal = 1;
  for (const msg of conv.messages) {
    const text = messageBody(msg);
    if (!text) continue;
    records.push({
      timestamp: ts,
      ordinal: ordinal++,
      type: 'response_item',
      payload: {
        type: 'message',
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: [{ type: msg.role === 'user' ? 'input_text' : 'output_text', text }],
      },
    });
  }

  writeJsonl(file, records);
  const registration = register ? registerThread(id, file, meta, conv) : { registered: false, reason: '已跳过' };
  return { file, id, resumeCommand: `codex resume ${id}`, registration };
}

/**
 * Codex 图形界面不扫描 sessions 目录，列表来自 state_5.sqlite 的 threads 表。
 * 这里补一条索引行，让转换出的会话直接出现在图形界面的会话列表里。
 * 写入前先校验表结构（fail-closed）并备份库文件。
 */
function threadsDbPath() {
  return path.join(os.homedir(), '.codex', 'state_5.sqlite');
}

/** 必需列缺失即拒绝写入，防止 Codex 升级改表后写出脏数据 */
export function verifyThreadsSchema(db) {
  let cols;
  try {
    cols = db.prepare('PRAGMA table_info(threads)').all().map((r) => r.name);
  } catch (err) {
    return { ok: false, missing: [], reason: `无法读取表结构: ${err.message}` };
  }
  const required = ['id', 'rollout_path', 'cwd', 'created_at_ms', 'updated_at_ms', 'first_user_message', 'preview'];
  const missing = required.filter((c) => !cols.includes(c));
  return missing.length ? { ok: false, missing } : { ok: true, missing: [] };
}

export function registerThread(id, file, meta, conv, dbPath = threadsDbPath()) {
  if (!fs.existsSync(dbPath)) return { registered: false, reason: '本机没有 Codex 桌面索引库' };

  const firstUser = conv.messages.find((m) => m.role === 'user');
  const firstText = firstUser ? firstUser.text.replace(/\s+/g, ' ').trim() : '';
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  let db;
  try {
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 5000');
    const check = verifyThreadsSchema(db);
    if (!check.ok) {
      const why = check.reason || `缺列: ${check.missing.join(', ')}`;
      return { registered: false, reason: `threads 表结构不匹配（${why}），已拒绝写入` };
    }
    // 校验通过才备份（保留最近 10 份）
    const backup = backupFile(dbPath, { dir: path.join(DATA_DIR, 'backups') });
    const stmt = db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, tokens_used, has_user_event, archived, cli_version,
        first_user_message, memory_mode, created_at_ms, updated_at_ms, thread_source, preview,
        recency_at, recency_at_ms, history_mode, originator, creator_user_id, creator_account_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, 'enabled', ?, ?, 'user', ?, ?, ?, 'paginated', 'sbridge', ?, ?)
      ON CONFLICT(id) DO UPDATE SET rollout_path = excluded.rollout_path, updated_at = excluded.updated_at
    `);
    stmt.run(
      id,
      file,
      nowSec, nowSec,
      'cli',
      meta.model_provider || '',
      expandPath(conv.cwd || process.cwd()),
      truncate(firstText, 120),
      '{"type":"disabled"}',
      'never',
      meta.cli_version || '',
      truncate(firstText, 400),
      nowMs, nowMs,
      truncate(firstText, 4000),
      nowSec, nowMs,
      meta.creator_user_id || null,
      meta.creator_account_id || null,
    );
    return { registered: true, backup: backup || null };
  } catch (err) {
    return { registered: false, reason: err.message };
  } finally {
    try { db?.close(); } catch { /* 关闭失败不影响结果 */ }
  }
}
