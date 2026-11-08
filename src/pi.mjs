import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl, writeJsonl, expandPath, isoForFile, uuid, shortId, nowIso, truncate } from './util.mjs';
import { buildConversation, messageBody } from './model.mjs';

export const name = 'pi';

export function sessionsRoot() {
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

/** pi 用 cwd 编码出会话子目录：C:\Users\me -> --C--Users-me-- */
export function encodeCwd(cwd) {
  return `--${cwd.replace(/[\\/:]/g, '-')}--`;
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

  // 悬空调用 = 有 toolCall 无 toolResult，上个会话可能中断在工具调用中间
  const interruptedCalls = [...pendingCalls.values()].filter((t) => !t.outcome).length;

  return buildConversation({
    sourceTool: 'pi',
    sourceFile: file,
    id: header.id || path.basename(file, '.jsonl'),
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

export function list({ cwd, limit = 20 } = {}) {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return [];
  const items = [];
  for (const dirEnt of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirEnt.isDirectory()) continue;
    const dir = path.join(root, dirEnt.name);
    if (cwd && dirEnt.name !== encodeCwd(expandPath(cwd))) continue;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, ent.name);
      try {
        const stat = fs.statSync(file);
        const first = fs.readFileSync(file, 'utf8').split('\n')[0];
        const header = JSON.parse(first);
        if (header.type !== 'session') continue;
        items.push({ file, id: header.id, cwd: header.cwd, createdAt: header.timestamp, updatedAt: stat.mtime, size: stat.size, title: '' });
      } catch {
        // 损坏文件跳过
      }
    }
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/** 取最近一次原生 pi 会话用过的模型，用于让导入会话落在可用模型上 */
export function detectModel() {
  const items = list({ limit: 30 });
  for (const item of items) {
    let records;
    try { records = readJsonl(item.file); } catch { continue; }
    for (let i = records.length - 1; i >= 0; i--) {
      const rec = records[i];
      if (rec.type === 'model_change' && rec.provider && rec.modelId) return { provider: rec.provider, modelId: rec.modelId };
      const m = rec.message;
      if (rec.type === 'message' && m?.role === 'assistant' && m.provider && m.model) {
        return { provider: m.provider, modelId: m.model, api: m.api };
      }
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
  const picked = model && model.provider ? model : detectModel();

  const records = [{ type: 'session', version: 3, id: newId, timestamp: now.toISOString(), cwd: targetCwd }];
  let parentId = null;

  if (picked) {
    const changeId = shortId();
    records.push({ type: 'model_change', id: changeId, parentId: null, timestamp: now.toISOString(), provider: picked.provider, modelId: picked.modelId });
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
      // pi 汇总用量时会强制读取 usage 各字段，缺失会抛错
      message.usage = {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      if (picked) {
        message.provider = picked.provider;
        message.model = picked.modelId;
        if (picked.api) message.api = picked.api;
      }
    }
    records.push({ type: 'message', id: entryId, parentId, timestamp: ts, message });
    parentId = entryId;
  }

  writeJsonl(file, records);
  return { file, id: newId, resumeCommand: `pi --session ${newId}` };
}
