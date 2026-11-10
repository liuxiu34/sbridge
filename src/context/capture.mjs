import fs from 'node:fs';
import * as db from './db.mjs';
import * as engine from './engine.mjs';

/**
 * 增量捕获：按字节偏移 tail 各工具的会话 JSONL，只处理完整行，
 * 产出事件落库，再交给 engine 做规则加工（证据/知识/代码引用）。
 */

const MAX_OUTCOME = 4000;

/* ---------- 行解析：codex ---------- */

function codexInjected(text) {
  const t = text.trimStart();
  return t.startsWith('<') || /^#\s*AGENTS\.md instructions/.test(t);
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.text).map((c) => c.text).join('\n');
}

function parseCodexLine(rec, evts) {
  if (rec.type !== 'response_item') return;
  const p = rec.payload || {};
  const ts = rec.timestamp || new Date().toISOString();

  if (p.type === 'message') {
    const text = contentText(p.content);
    if (!text) return;
    if (p.role === 'user' && !codexInjected(text)) {
      evts.push({ kind: 'user', role: 'user', text, ts });
    } else if (p.role === 'assistant') {
      evts.push({ kind: 'assistant', role: 'assistant', text, ts });
    }
    return;
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    evts.push({
      kind: 'tool_call', toolName: p.name || p.namespace || 'tool',
      args: p.arguments ?? p.input, callId: p.call_id || p.id || null, ts,
    });
    return;
  }
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    evts.push({ kind: 'tool_result', callId: p.call_id, outcome: stringify(p.output), ts });
  }
}

/* ---------- 行解析：pi ---------- */

function piInjected(text) {
  return /^(<read-files>|<modified-files>|<skill|<|Image preview fallback active)/.test(text.trimStart());
}

function parsePiLine(rec, evts) {
  if (rec.type !== 'message' || !rec.message) return;
  const m = rec.message;
  const ts = m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString();

  if (m.role === 'user') {
    const text = partsText(m.content);
    if (text && !piInjected(text)) evts.push({ kind: 'user', role: 'user', text, ts });
    return;
  }
  if (m.role === 'assistant') {
    for (const part of Array.isArray(m.content) ? m.content : []) {
      if (part.type === 'text' && part.text) {
        evts.push({ kind: 'assistant', role: 'assistant', text: part.text, ts });
      } else if (part.type === 'toolCall') {
        evts.push({ kind: 'tool_call', toolName: part.name || 'tool', args: part.arguments, callId: part.id || null, ts });
      }
    }
    return;
  }
  if (m.role === 'toolResult') {
    evts.push({ kind: 'tool_result', callId: m.toolCallId, outcome: stringify(partsText(m.content)), isError: !!m.isError, ts });
  }
}

/* ---------- 行解析：claude ---------- */

function claudeInjected(text) {
  const t = text.trimStart();
  return t.startsWith('<') || t.startsWith('Caveat:');
}

function parseClaudeLine(rec, evts) {
  if (rec.isSidechain === true) return;
  if (rec.type !== 'user' && rec.type !== 'assistant') return;
  const content = rec.message?.content;
  const ts = rec.timestamp || new Date().toISOString();

  if (typeof content === 'string') {
    if (rec.type === 'user' && content && !claudeInjected(content)) evts.push({ kind: 'user', role: 'user', text: content, ts });
    else if (rec.type === 'assistant' && content) evts.push({ kind: 'assistant', role: 'assistant', text: content, ts });
    return;
  }
  if (!Array.isArray(content)) return;

  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'text' && c.text) {
      if (rec.type === 'user' && !claudeInjected(c.text)) evts.push({ kind: 'user', role: 'user', text: c.text, ts });
      else if (rec.type === 'assistant') evts.push({ kind: 'assistant', role: 'assistant', text: c.text, ts });
    } else if (c.type === 'tool_use' && c.name) {
      evts.push({ kind: 'tool_call', toolName: c.name, args: c.input ?? '', callId: c.id || null, ts });
    } else if (c.type === 'tool_result') {
      evts.push({ kind: 'tool_result', callId: c.tool_use_id, outcome: stringify(c.content), isError: !!c.is_error, ts });
    }
  }
}

function partsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n');
}

function stringify(value) {
  if (value == null) return '';
  // Codex 的 output 常是 [{type:'input_text',text}] 数组，先提取文本
  if (Array.isArray(value)) return stringify(contentText(value.map((v) => ({ text: typeof v === 'string' ? v : v?.text })).filter((v) => v.text)));
  if (typeof value === 'object') {
    // 单对象包装 {type, text} 或 {output: "..."}
    if (typeof value.text === 'string') return stringify(value.text);
    if (typeof value.output === 'string') return stringify(value.output);
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > MAX_OUTCOME ? `${text.slice(0, MAX_OUTCOME)}\n…[截断，共 ${text.length} 字符]` : text;
}

/* ---------- 增量 tail ---------- */

function tailNewLines(file, offset) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= offset) return { chunk: '', nextOffset: offset };
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    const text = buf.toString('utf8');
    // 只保留最后一个完整行（\n 之后的内容留给下次）
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { chunk: '', nextOffset: offset };
    return { chunk: text.slice(0, lastNl + 1), nextOffset: offset + Buffer.byteLength(text.slice(0, lastNl + 1)) };
  } finally {
    fs.closeSync(fd);
  }
}

// 供会话流（SSE）复用：按工具解析会话行 → 展示事件
export const PARSERS = { codex: parseCodexLine, pi: parsePiLine, claude: parseClaudeLine, omp: parsePiLine };

/**
 * 对单个会话文件执行增量捕获。
 * @returns 新事件数
 */
function captureFile(ctxTaskId, tool, file) {
  const { chunk, nextOffset } = tailNewLines(file, db.getOffset(ctxTaskId, file));
  if (!chunk) return 0;

  const parser = PARSERS[tool] || parsePiLine;
  const evts = [];
  for (const line of chunk.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      parser(JSON.parse(t), evts);
    } catch {
      // 半行或未知格式，跳过
    }
  }

  for (const evt of evts) {
    if (evt.kind === 'tool_result') {
      // 回填对应 tool_call 的名称与参数，便于 engine 分类
      const call = db.findCallEvent(ctxTaskId, evt.callId);
      if (call) {
        evt.toolName = call.tool_name;
        evt.argsJson = call.args_json;
      }
      if (evt.isError) evt.outcome = `报错: ${evt.outcome}`;
    }
    db.insertEvent({
      taskId: ctxTaskId,
      sessionFile: file,
      byteOffset: nextOffset,
      kind: evt.kind,
      role: evt.role ?? null,
      toolName: evt.toolName ?? null,
      argsJson: evt.args != null ? stringify(evt.args) : evt.argsJson ?? null,
      outcome: evt.text ?? evt.outcome ?? null,
      outcomeHash: evt.kind === 'tool_result' ? db.sha1(`${evt.toolName || ''}|${(evt.outcome || '').slice(0, 256)}`) : null,
      callId: evt.callId ?? null,
      ts: evt.ts,
    });
  }

  db.setOffset(ctxTaskId, file, nextOffset);
  return evts.length;
}

/**
 * 任务级捕获：tail 所有已绑定会话 → 规则加工 → 状态汇总。
 */
export function captureTask(ctxTaskId, { sessions = [] } = {}) {
  let newEvents = 0;
  for (const s of sessions) {
    if (!s.file || !fs.existsSync(s.file)) continue;
    try {
      newEvents += captureFile(ctxTaskId, s.tool, s.file);
    } catch {
      // 单文件失败不影响其他文件
    }
  }
  const processed = engine.processEvents(ctxTaskId);
  const staleness = engine.refreshStaleness(ctxTaskId);
  return { newEvents, ...processed, ...staleness };
}

export { tailNewLines };
