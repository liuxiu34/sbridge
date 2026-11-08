import fs from 'node:fs';

/**
 * 会话上下文用量：优先读编程工具自己记录的数字，而不是靠事件估算。
 * - Codex：rollout 里的 event_msg/token_count（last_token_usage + model_context_window）
 * - Claude Code：最后一条 assistant 的 message.usage（input + cache_creation + cache_read），
 *   窗口从 cost-state 的 modelUsage 键后缀（如 `[1m]`）取
 * - Pi：会话里 assistant 的 usage（totalTokens）；若终端里有 pi 状态栏（`13.2%/272k (auto)`），
 *   直接以状态栏为准（那是 pi 自己算好的上下文占比）
 */

const TAIL_BYTES = 512 * 1024;
const cache = new Map(); // file -> { key, val }

function tailLines(file) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl === -1 ? '' : text.slice(nl + 1); // 丢掉被截断的半行
    }
    return text.split('\n').filter((l) => l.trim());
  } finally {
    fs.closeSync(fd);
  }
}

const fromEnd = (lines, pick) => {
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    const hit = pick(o);
    if (hit) return hit;
  }
  return null;
};

function windowFromModelKey(key) {
  const m = /\[(\d+(?:\.\d+)?)(k|m)\]/i.exec(key || '');
  if (!m) return null;
  const n = Number(m[1]);
  return Math.round((m[2].toLowerCase() === 'm' ? n * 1e6 : n * 1000));
}

function parseClaude(lines) {
  let used = null;
  let model = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.type !== 'assistant' || !o.message?.usage) continue;
    const u = o.message.usage;
    const sum = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
    if (sum <= 0) continue; // synthetic/空 usage 行跳过
    used = sum;
    model = o.message.model || null;
    break;
  }
  if (used == null) return null;
  // 窗口：cost-state 里同一模型的键可能带 [1m]/[200k] 标注
  const cost = fromEnd(lines, (o) => (o.type === 'cost-state' && o.modelUsage ? o : null));
  let win = null;
  if (cost) {
    const keys = Object.keys(cost.modelUsage);
    const pick = keys.sort((a, b) => (cost.modelUsage[b]?.inputTokens || 0) - (cost.modelUsage[a]?.inputTokens || 0))[0];
    win = windowFromModelKey(pick);
    if (!model && pick) model = pick.replace(/\[[^\]]+\]$/, '');
  }
  return { used, window: win || 200000, model, source: 'claude-usage' };
}

function parseCodex(lines) {
  const hit = fromEnd(lines, (o) => {
    if (o.type === 'event_msg' && o.payload?.type === 'token_count') return o.payload.info || {};
    if (o.type === 'token_usage_record' && o.payload) {
      return { last_token_usage: o.payload.usage, model_context_window: null };
    }
    return null;
  });
  if (!hit) return null;
  const used = hit.last_token_usage?.total_tokens ?? hit.total_token_usage?.total_tokens ?? null;
  if (!used) return null;
  return { used, window: Number(hit.model_context_window) || 272000, model: null, source: 'codex-token-count' };
}

function parsePi(lines) {
  const msg = fromEnd(lines, (o) => {
    if (o.type !== 'message' || !o.message || o.message.role !== 'assistant') return null;
    const u = o.message.usage;
    if (!u) return null;
    const total = u.totalTokens ?? ((u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0));
    return total > 0 ? { used: total, model: o.message.model || null } : null;
  });
  if (!msg) return null;
  return { used: msg.used, window: null, model: msg.model, source: 'pi-usage' };
}

function parseByTool(tool, lines) {
  if (tool === 'claude') return parseClaude(lines);
  if (tool === 'codex') return parseCodex(lines);
  if (tool === 'pi') return parsePi(lines);
  return null;
}

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x00REPLAY_DONE\x00/g;
const stripAnsi = (s) => s.replace(ANSI_RE, '');

/** 从终端滚回文本里找 pi 自己打印的状态栏，如 `172k J11 R71k CH99.6% 13.2%/272k (auto)` */
export function usageFromStatusText(text) {
  if (!text) return null;
  const clean = stripAnsi(text).replace(/\r/g, '\n');
  const matches = [...clean.matchAll(/(\d+(?:\.\d+)?)%\s*\/\s*(\d+(?:\.\d+)?)\s*([km])?/gi)];
  const m = matches[matches.length - 1];
  if (!m) return null;
  const pct = Number(m[1]);
  const num = Number(m[2]);
  const unit = (m[3] || '').toLowerCase();
  const win = unit === 'm' ? Math.round(num * 1e6) : unit === 'k' ? Math.round(num * 1000) : Math.round(num);
  if (!(pct > 0 && pct <= 100) || win < 50000) return null;
  const lineHit = clean.split('\n').reverse().find((l) => l.includes(m[0])) || m[0];
  return {
    used: Math.round((pct / 100) * win),
    window: win,
    pct,
    source: 'pi-status',
    raw: lineHit.trim().slice(-140),
  };
}

/**
 * 计算某节点的上下文占用。liveText = 该节点终端最近输出（可空）。
 * 有 pi 状态栏时以它为准；其余读会话文件里的工具自家用量记录。
 */
export function computeContextUsage(node, liveText = '') {
  const file = node?.file || '';
  if (!file || file.startsWith('sqlite:')) return null;

  let base = null;
  try {
    const st = fs.statSync(file);
    const key = `${st.mtimeMs}|${st.size}`;
    const hit = cache.get(file);
    if (hit && hit.key === key) base = hit.val;
    else {
      base = parseByTool(node.tool, tailLines(file));
      if (cache.size > 300) cache.clear();
      cache.set(file, { key, val: base });
    }
  } catch { return null; }

  // pi：终端状态栏是它自己算出的最终值，优先
  if (node.tool === 'pi') {
    const live = usageFromStatusText(liveText);
    if (live) {
      return { ...live, model: base?.model || null, nodeId: node.id };
    }
  }
  if (!base) return null;
  const win = base.window || (node.tool === 'codex' ? 272000 : 200000);
  return {
    ...base,
    window: win,
    pct: Math.min(100, (base.used / win) * 100),
    nodeId: node.id,
  };
}
