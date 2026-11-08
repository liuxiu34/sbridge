import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJsonl, writeJsonl, expandPath, uuid, nowIso, truncate, readHeadLines } from './util.mjs';
import { buildConversation, messageBody } from './model.mjs';

export const name = 'claude';

export function sessionsRoot() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env ? path.join(expandPath(env), 'projects') : path.join(os.homedir(), '.claude', 'projects');
}

/** Claude 的会话目录名编码：非字母数字一律替换为 '-'（实测 C:\Users\me -> C--Users-me） */
export function encodeCwd(cwd) {
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function isInjectedUserText(text) {
  const t = text.trimStart();
  // <system-reminder>、<local-command-stdout> 等注入内容，以及 Claude 的 Caveat 提示行
  return t.startsWith('<') || t.startsWith('Caveat:');
}

/** content 可能是字符串或块数组；提取 text 块 / tool_result 块 */
function contentBlocks(content) {
  if (typeof content === 'string') return { text: content, results: [] };
  if (!Array.isArray(content)) return { text: '', results: [] };
  const texts = [];
  const results = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c.text) texts.push(c.text);
    else if (c.type === 'tool_result') results.push(c);
  }
  return { text: texts.join('\n'), results };
}

function summarizeResult(content) {
  const { text } = contentBlocks(content);
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const kb = Math.round(Buffer.byteLength(String(text)) / 1024);
  return `${truncate(flat, 70)}${kb > 1 ? ` (~${kb}KB)` : ''}`;
}

export function read(file) {
  const records = readJsonl(file);
  const messages = [];
  let assistant = null;
  let cwd = '';
  let sessionId = '';
  let createdAt = '';

  const flush = () => {
    if (assistant && (assistant.text || assistant.tools.length)) messages.push(assistant);
    assistant = null;
  };
  const ensureAssistant = (ts) => {
    if (!assistant) assistant = { role: 'assistant', text: '', ts, tools: [] };
    return assistant;
  };
  const pendingCalls = new Map();

  for (const rec of records) {
    if (rec.isSidechain === true) continue; // 子代理行不进入主线
    if (!sessionId && rec.sessionId) sessionId = rec.sessionId;
    if (!cwd && rec.cwd) cwd = rec.cwd;
    if (!createdAt && rec.timestamp) createdAt = rec.timestamp;
    const ts = rec.timestamp || nowIso();

    if (rec.type === 'user' && rec.message) {
      const { text, results } = contentBlocks(rec.message.content);
      // tool_result 回填对应 tool_use 的结论
      for (const r of results) {
        const tool = pendingCalls.get(r.tool_use_id);
        if (tool) tool.outcome = summarizeResult(r.content);
      }
      if (!text || isInjectedUserText(text)) continue;
      flush();
      messages.push({ role: 'user', text, ts, tools: [] });
      continue;
    }

    if (rec.type === 'assistant' && rec.message) {
      const content = rec.message.content;
      if (typeof content === 'string') {
        if (content) ensureAssistant(ts).text = assistant.text ? `${assistant.text}\n\n${content}` : content;
        continue;
      }
      for (const c of Array.isArray(content) ? content : []) {
        if (c?.type === 'text' && c.text) {
          const a = ensureAssistant(ts);
          a.text = a.text ? `${a.text}\n\n${c.text}` : c.text;
        } else if (c?.type === 'tool_use' && c.name) {
          const tool = { name: c.name, args: c.input ?? '', outcome: '' };
          ensureAssistant(ts).tools.push(tool);
          if (c.id) pendingCalls.set(c.id, tool);
        }
      }
      continue;
    }
  }
  flush();

  // 悬空调用 = 有 tool_use 无 tool_result，上个会话可能中断在工具调用中间
  const interruptedCalls = [...pendingCalls.values()].filter((t) => !t.outcome).length;

  return buildConversation({
    sourceTool: 'claude',
    sourceFile: file,
    id: sessionId || path.basename(file, '.jsonl'),
    cwd,
    createdAt: createdAt || nowIso(),
    title: '',
    messages,
    interruptedCalls,
  });
}

export function list({ cwd, limit = 20 } = {}) {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return [];
  const items = [];
  for (const dirEnt of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dirEnt.isDirectory()) continue;
    const dir = path.join(root, dirEnt.name);
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, ent.name);
      try {
        const stat = fs.statSync(file);
        // 从头部行提取 sessionId 与 cwd（首行即含 sessionId，cwd 出现在消息行里）
        let id = '';
        let fileCwd = '';
        for (const line of readHeadLines(file, 40)) {
          if (!id) {
            const m = line.match(/"sessionId":"([^"]+)"/);
            if (m) id = m[1];
          }
          if (!fileCwd) {
            const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
            if (m) fileCwd = JSON.parse(`"${m[1]}"`);
          }
          if (id && fileCwd) break;
        }
        if (!id) continue;
        items.push({ file, id, cwd: fileCwd, createdAt: stat.birthtime?.toISOString?.() || stat.mtime.toISOString(), updatedAt: stat.mtime, size: stat.size, title: '' });
      } catch {
        // 损坏文件跳过
      }
    }
  }
  const filtered = cwd ? items.filter((it) => it.cwd && expandPath(it.cwd).toLowerCase() === expandPath(cwd).toLowerCase()) : items;
  return filtered.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

/**
 * 写入 Claude Code 原生会话（文件型，无需索引库；claude --resume <id> 需在匹配 cwd 下启动）。
 */
export function write(conv, { cwd } = {}) {
  const id = uuid();
  const now = new Date();
  const targetCwd = expandPath(cwd || conv.cwd || process.cwd());
  const dir = path.join(sessionsRoot(), encodeCwd(targetCwd));
  const file = path.join(dir, `${id}.jsonl`);
  const ts = now.toISOString();

  const records = [];
  let parentUuid = null;
  for (const msg of conv.messages) {
    const text = messageBody(msg);
    if (!text) continue;
    const selfUuid = uuid();
    records.push({
      parentUuid,
      isSidechain: false,
      userType: 'external',
      type: msg.role === 'user' ? 'user' : 'assistant',
      uuid: selfUuid,
      timestamp: ts,
      cwd: targetCwd,
      sessionId: id,
      message: {
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.role === 'user' ? text : [{ type: 'text', text }],
      },
    });
    // Claude resume 从最后一条沿 parentUuid 反向重建，必须逐条链接
    parentUuid = selfUuid;
  }

  writeJsonl(file, records);
  return { file, id, resumeCommand: `claude --resume ${id}`, launchCommand: 'claude' };
}
