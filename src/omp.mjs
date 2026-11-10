import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl, writeJsonl, expandPath, isoForFile, uuid, shortId, nowIso, truncate } from './util.mjs';
import { buildConversation, messageBody } from './model.mjs';

/* Oh My Pi（omp）：Pi 的深度分支，会话仍是 Pi v3 的 JSONL 结构，
   但目录命名规则和 model_change 记录格式不同，所以单独一个适配器。 */

export const name = 'omp';

export function sessionsRoot() {
  return path.join(os.homedir(), '.omp', 'agent', 'sessions');
}

/** 目录名规则（照 omp session-paths.ts）：临时目录 → -tmp<相对>；家目录 → -<相对>；其它 → --绝对路径-- */
function encodeRelative(prefix, relative) {
  const encoded = relative.replace(/[/\\:]/g, '-');
  if (!encoded) return prefix;
  return prefix.endsWith('-') ? `${prefix}${encoded}` : `${prefix}-${encoded}`;
}
export function encodeCwd(cwd) {
  const resolved = path.resolve(cwd);
  const within = (base) => {
    const rel = path.relative(base, resolved);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel;
  };
  const tempRel = within(os.tmpdir());
  if (tempRel) return encodeRelative('-tmp', tempRel);
  const homeRel = within(os.homedir());
  if (homeRel) return encodeRelative('-', homeRel);
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

function partsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n');
}

function isInjectedUserText(text) {
  const t = text.trimStart();
  return /^(<read-files>|<modified-files>|<skill|<|Image preview fallback active)/.test(t);
}

export function read(file) {
  const records = readJsonl(file);
  const header = records.find((r) => r.type === 'session') || {};
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

  for (const rec of records) {
    if (rec.type !== 'message' || !rec.message) continue;
    const m = rec.message;
    const ts = m.timestamp ? new Date(m.timestamp).toISOString() : rec.timestamp || nowIso();

    if (m.role === 'user') {
      const text = partsText(m.content);
      if (!text || isInjectedUserText(text)) continue;
      flush();
      messages.push({ role: 'user', text, ts, tools: [] });
      continue;
    }

    if (m.role === 'assistant') {
      for (const part of Array.isArray(m.content) ? m.content : []) {
        if (part.type === 'text' && part.text) {
          const a = ensureAssistant(ts);
          a.text = a.text ? `${a.text}\n\n${part.text}` : part.text;
        } else if (part.type === 'toolCall') {
          const tool = { name: part.name || 'tool', args: part.arguments, outcome: '' };
          ensureAssistant(ts).tools.push(tool);
          if (part.id) pendingCalls.set(part.id, tool);
        }
      }
      continue;
    }

    if (m.role === 'toolResult') {
      const tool = pendingCalls.get(m.toolCallId);
      if (tool) tool.outcome = summarizeOutput(partsText(m.content), m.isError);
      continue;
    }
  }
  flush();

  const interruptedCalls = [...pendingCalls.values()].filter((t) => !t.outcome).length;

  return buildConversation({
    sourceTool: 'omp',
    sourceFile: file,
    id: header.id || path.basename(file, '.jsonl').split('_').pop(),
    cwd: header.cwd || '',
    createdAt: header.timestamp || nowIso(),
    title: '',
    messages,
    interruptedCalls,
  });
}

function summarizeOutput(text, isError) {
  if (!text) return isError ? '报错' : '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const kb = Math.round(Buffer.byteLength(String(text)) / 1024);
  return `${isError ? '报错: ' : ''}${truncate(flat, 70)}${kb > 1 ? ` (~${kb}KB)` : ''}`;
}

/** 会话头不在第一行（omp 先写一条 title 记录），所以要扫前几行 */
function headerOf(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').split('\n', 5);
    for (const line of head) {
      if (!line.trim()) continue;
      const rec = JSON.parse(line);
      if (rec.type === 'session') return rec;
    }
  } catch { /* 损坏文件跳过 */ }
  return null;
}

export function list({ cwd, limit = 20 } = {}) {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return [];
  const items = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!ent.name.endsWith('.jsonl')) continue;
      const header = headerOf(full);
      if (!header) continue;
      if (cwd && String(header.cwd || '').toLowerCase() !== expandPath(cwd).toLowerCase()) continue;
      try {
        const stat = fs.statSync(full);
        items.push({ file: full, id: header.id, cwd: header.cwd, createdAt: header.timestamp, updatedAt: stat.mtime, size: stat.size, title: '' });
      } catch { /* ignore */ }
    }
  };
  walk(root);
  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** 最近一条原生 omp 会话用的模型（model_change 里存的是 "provider/model" 字符串） */
export function detectModel() {
  for (const item of list({ limit: 20 })) {
    let records;
    try { records = readJsonl(item.file); } catch { continue; }
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i];
      if (rec.type === 'model_change' && rec.model) return { model: String(rec.model) };
      const m = rec.message;
      if (rec.type === 'message' && m?.role === 'assistant' && m.provider && m.model) return { model: `${m.provider}/${m.model}` };
    }
  }
  return null;
}

export function write(conv, { cwd, model } = {}) {
  const newId = uuid();
  const now = new Date();
  const targetCwd = expandPath(cwd || conv.cwd || process.cwd());
  const dir = path.join(sessionsRoot(), encodeCwd(targetCwd));
  const file = path.join(dir, `${isoForFile(now, true)}_${newId}.jsonl`);
  const picked = model?.model
    ? { model: model.model }
    : (model?.provider && model?.modelId
      ? { model: `${model.provider}/${model.modelId}` }
      : detectModel());

  // 第一行必须是 session 头：omp 校验 entries[0] 的类型，标题槽是它自己维护的定长记录
  const records = [
    { type: 'session', version: 3, id: newId, timestamp: now.toISOString(), cwd: targetCwd },
  ];
  let parentId = null;
  if (picked?.model) {
    const changeId = shortId();
    records.push({ type: 'model_change', id: changeId, parentId: null, timestamp: now.toISOString(), model: picked.model });
    parentId = changeId;
  }

  for (const msg of conv.messages) {
    const text = messageBody(msg);
    if (!text) continue;
    const entryId = shortId();
    const ts = new Date().toISOString();
    const message = {
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    };
    if (msg.role === 'assistant') {
      message.stopReason = 'stop';
      message.usage = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      if (picked?.model) {
        const [provider, ...rest] = String(picked.model).split('/');
        message.provider = provider;
        message.model = rest.join('/') || picked.model;
      }
    }
    records.push({ type: 'message', id: entryId, parentId, timestamp: ts, message });
    parentId = entryId;
  }

  writeJsonl(file, records);
  return { file, id: newId, resumeCommand: `omp --resume ${newId}` };
}
