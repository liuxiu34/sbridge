import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import os from 'node:os';
import { getAsset } from 'node:sea';
import * as store from './store.mjs';
import * as codex from './codex.mjs';
import * as pi from './pi.mjs';
import * as claude from './claude.mjs';
import * as ctxdb from './context/db.mjs';
import { captureTask, PARSERS, tailNewLines } from './context/capture.mjs';
import { startAutoCapture } from './context/watcher.mjs';
import { contextSummary } from './context/engine.mjs';
import { buildCheckpoint } from './context/checkpoint.mjs';
import { computeContextUsage } from './context/usage.mjs';
import { applyBudget, summarize } from './model.mjs';
import * as termmod from './term.mjs';
import { renderTranscript } from './transcript.mjs';
import { ensureSubagentProtocols } from './subagent-protocol.mjs';
import { maybeCreateWorktree, isSbridgeWorktree, worktreeInfo, mergeWorktree } from './worktree.mjs';
import { inspectChanges, listDir, readFilePreview } from './git-inspect.mjs';
import { listModels, detectSessionModel, modelFlags } from './models.mjs';
import { scanProjectState, scanProjectTruth, renderProjectTruth } from './project-scan.mjs';
import { expandPath, samePath, truncate, estimateTokens } from './util.mjs';
import { IS_SEA, ROOT, WEB_DIR, DATA_DIR } from './paths.mjs';

let PORT = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] || 4310);
const TOOLS = { codex, pi, claude };
const TOOL_LABELS = { codex: 'Codex', pi: 'Pi', claude: 'Claude Code' };
const LAUNCH_COMMANDS = { codex: 'codex', pi: 'pi', claude: 'claude' };
// 目录比较用：大小写、斜杠、尾斜杠不敏感
const normDir = (p) => String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();

/** 杀掉整棵进程树：Windows 下 PTY/无头命令都是 cmd 包裹，只 kill 壳会留下孤儿进程；
 *  POSIX 下 forkpty 的子进程是会话首进程，用负 PID 连进程组一起杀。 */
function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* 已退出 */ }
}

/** 搜索命中片段：压缩空白后取命中位置前后各 radius 个字符 */
function searchSnippet(text, q, radius = 44) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const pos = clean.toLowerCase().indexOf(String(q || '').toLowerCase());
  if (pos < 0) return clean.slice(0, radius * 2);
  const start = Math.max(0, pos - radius);
  const end = Math.min(clean.length, pos + String(q).length + radius);
  return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
}

/** 会话导出为 Markdown（保留消息与工具调用，输出给用户自己归档） */
function renderSessionMarkdown(node, evts) {
  const lines = [`# ${node.title || '(会话)'}`, ''];
  lines.push(`- 工具：${TOOL_LABELS[node.tool] || node.tool}`);
  if (node.cwd) lines.push(`- 目录：${node.cwd}`);
  if (node.sessionId) lines.push(`- 会话 ID：${node.sessionId}`);
  if (node.createdAt) lines.push(`- 创建时间：${node.createdAt}`);
  lines.push(`- 导出时间：${new Date().toISOString()}（sbridge）`, '');
  for (const e of evts) {
    if (e.kind === 'user') lines.push('## 用户', '', String(e.text || '').trim(), '');
    else if (e.kind === 'assistant') lines.push('## AI', '', String(e.text || '').trim(), '');
    else if (e.kind === 'tool_call') {
      const args = typeof e.args === 'string' ? e.args : JSON.stringify(e.args || '');
      lines.push(`> 工具调用：${e.toolName || 'tool'}`, '', '```', truncate(args, 2000), '```', '');
    } else if (e.kind === 'tool_result') {
      lines.push(`> 工具结果${e.isError ? '（错误）' : ''}`, '', '```', truncate(String(e.outcome || ''), 2000), '```', '');
    }
  }
  return lines.join('\n');
}
/** 探测 CLI 是否可用并取版本输出（带超时，失败不抛错） */
function probeCommand(cmd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try { child = spawn(cmd, { shell: true, windowsHide: true }); }
    catch (e) { resolve({ ok: false, error: e.message }); return; }
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      resolve({ ok: false, timeout: true, output: (out + err).trim() });
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', (d) => { out = (out + d).slice(-400); });
    child.stderr?.on('data', (d) => { err = (err + d).slice(-400); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, output: (out + err).trim() }); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

/** 判断各工具是否已有登录/密钥配置（只看配置存在性，不联网验证账号） */
function readAuthHint(tool) {
  const home = os.homedir();
  try {
    if (tool === 'codex') {
      const f = path.join(home, '.codex', 'auth.json');
      const st = fs.statSync(f);
      if (st.size > 2) return { ok: true, detail: '~/.codex/auth.json 存在（已登录 ChatGPT 或已配密钥）' };
    }
    if (tool === 'pi') {
      const f = path.join(home, '.pi', 'agent', 'models.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      const providers = Object.entries(j.providers || {});
      const withKey = providers.filter(([, v]) => v && (v.apiKey || v.api_key));
      if (withKey.length) {
        let def = '';
        try {
          const s = JSON.parse(fs.readFileSync(path.join(home, '.pi', 'agent', 'settings.json'), 'utf8'));
          def = [s.defaultProvider, s.defaultModel].filter(Boolean).join('/');
        } catch { /* ignore */ }
        return { ok: true, detail: `${withKey.length} 个 provider 配了密钥${def ? `，默认 ${def}` : ''}` };
      }
    }
    if (tool === 'claude') {
      const sf = path.join(home, '.claude', 'settings.json');
      if (fs.existsSync(sf)) {
        const env = JSON.parse(fs.readFileSync(sf, 'utf8')).env || {};
        if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL) {
          return { ok: true, detail: 'settings.json 已配置网关或密钥' };
        }
      }
      const cf = path.join(home, '.claude.json');
      if (fs.existsSync(cf) && fs.statSync(cf).size > 2) return { ok: true, detail: '.claude.json 存在（可能已登录）' };
    }
  } catch (e) { return { ok: false, detail: e.message }; }
  return { ok: false, detail: '未找到登录或密钥配置' };
}

// 从会话 id 构造 resume 命令（「接入已有会话」的节点只有会话文件没有 resumeCommand 时用）
const RESUME_COMMANDS = {
  pi: (id) => `pi --session ${id}`,
  codex: (id) => `codex resume ${id}`,
  claude: (id) => `claude --resume ${id}`,
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
  });
}

function nodeSummary(conv) {
  const s = summarize(conv);
  return {
    messageCount: s.messageCount,
    turnCount: s.turnCount,
    tokens: s.tokens,
    firstUser: s.firstUser,
    lastAssistant: s.lastAssistant,
    files: s.files.slice(0, 12),
  };
}

function makeNode(toolName, conv, extra = {}) {
  const firstUser = conv.messages.find((m) => m.role === 'user');
  return {
    tool: toolName,
    sessionId: conv.id,
    file: conv.sourceFile,
    cwd: conv.cwd,
    title: truncate(firstUser?.text || '(无提问)', 64),
    createdAt: conv.createdAt,
    summary: nodeSummary(conv),
    ...extra,
  };
}

function buildState(db) {
  return {
    projects: db.projects,
    tasks: db.tasks.map((t) => ({
      id: t.id,
      projectId: t.projectId,
      title: t.title,
      status: t.status,
      note: t.note,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      nodeCount: t.nodes.length,
      tools: [...new Set(t.nodes.map((n) => n.tool))],
      lastTool: t.nodes.length ? t.nodes[t.nodes.length - 1].tool : null,
    })),
  };
}

/* 会话里「最后一次实质代码活动」（编辑/命令/commit），用于判断进度新旧。
   不能用文件 mtime——用户和旧会话闲聊几句也会把它顶成「最新」。
   解析结果按 (mtime,size) 缓存，避免每次打开任务都重读大文件。 */
const CODE_TOOL_RE = /^(edit|write|create|apply_patch|applypatch|str_replace|multiedit|notebook_edit|replace|bash|shell|exec|command|powershell|cmd|terminal|git)/i;
const codeActivityCache = globalThis.__sbCodeCache || (globalThis.__sbCodeCache = new Map());

function computeCodeActivity(node) {
  const file = node.file || '';
  if (!file || file.startsWith('sqlite:')) return null;
  try {
    const st = fs.statSync(file);
    if (st.size > 15 * 1024 * 1024) return null; // 超大文件不解析，退回 mtime
    const key = `${st.mtimeMs}|${st.size}`;
    const hit = codeActivityCache.get(file);
    if (hit && hit.key === key) return hit.val;
    const parser = PARSERS[node.tool];
    if (!parser) return null;
    const evts = [];
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { parser(JSON.parse(t), evts); } catch { /* 半行跳过 */ }
    }
    let ts = null;
    const files = new Set();
    for (const e of evts) {
      if (e.kind !== 'tool_call' || !CODE_TOOL_RE.test(e.toolName || '')) continue;
      if (e.ts) ts = e.ts;
      const s = typeof e.args === 'string' ? e.args : JSON.stringify(e.args || '');
      const m = s.match(/(?:[A-Za-z]:\\[^"'\s]+|\/(?:[^"'\s]+\/)*[^"'\s]+)/g);
      if (m) m.slice(0, 8).forEach((p) => files.add(p.toLowerCase()));
    }
    const val = { ts, files: [...files].slice(0, 50) };
    if (codeActivityCache.size > 300) codeActivityCache.clear();
    codeActivityCache.set(file, { key, val });
    return val;
  } catch { return null; }
}

function taskDetail(db, taskId) {
  const task = db.tasks.find((t) => t.id === taskId);
  if (!task) return null;
  const nodes = task.nodes.map((n) => {
    let lastActivity = null;
    // 会话文件的 mtime = 最后一次活动时间（包含闲聊，仅作兜底展示）
    try {
      if (n.file && !n.file.startsWith('sqlite:') && fs.existsSync(n.file)) {
        lastActivity = fs.statSync(n.file).mtime.toISOString();
      }
    } catch { /* 读不到就用 createdAt */ }
    const code = computeCodeActivity(n);
    return {
      ...n,
      lastActivity: lastActivity || n.createdAt || null,
      // 本会话最后一次「真正改了东西」的时间 + 涉及的文件：进度判断以它为准
      lastCodeActivity: code?.ts || null,
      codeFiles: code?.files || [],
      // 上下文用量改为打开面板时按需查询（GET .../nodes/:id/usage）：
      // 打开大任务时不再为几十个会话逐个读文件尾巴，首屏更快
      // sqlite: 前缀 = 正文在 Codex 本地库，视为存在
      exists: n.file.startsWith('sqlite:') || fs.existsSync(n.file),
    };
  });

  // 项目现状（与工具无关）：优先取「最近有代码活动」的会话目录作为主工作区
  const primary = [...nodes]
    .filter((n) => n.cwd)
    .sort((a, b) => String(b.lastCodeActivity || b.lastActivity || '').localeCompare(String(a.lastCodeActivity || a.lastActivity || '')))[0];
  const st = primary ? scanProjectState(primary.cwd) : null;

  return {
    ...task,
    nodes,
    // 轻量字段：给界面提示「项目有未提交改动 / 有比会话更新的磁盘改动」
    project: st ? {
      cwd: st.cwd,
      isGit: st.isGit,
      branch: st.branch,
      head: st.head,
      headAt: st.headAt,
      dirtyCount: st.dirtyCount,
      lastChangeAt: st.lastChangeAt,
    } : null,
  };
}

async function handleApi(req, res, url) {
  const db = store.load();
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, sub, subId, extra] = parts;

  if (req.method === 'GET' && resource === 'state') return json(res, 200, buildState(db));

  /* 引用本地文件（浏览器降级路径）：桌面版走系统文件框拿真实路径，浏览器里把文件存到数据目录再给路径 */
  if (req.method === 'POST' && resource === 'upload') {
    const body = await readBody(req);
    const name = path.basename(String(body.name || 'file')).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(-80) || 'file';
    const data = String(body.data || '');
    if (!data) return json(res, 400, { error: '文件内容为空' });
    let buf;
    try { buf = Buffer.from(data, 'base64'); } catch { return json(res, 400, { error: '文件内容不是合法 base64' }); }
    if (!buf.length) return json(res, 400, { error: '文件内容为空' });
    if (buf.length > 25 * 1024 * 1024) return json(res, 400, { error: '文件超过 25MB，请放到项目目录里直接引用路径' });
    try {
      const dir = path.join(DATA_DIR, 'uploads');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}-${name}`);
      fs.writeFileSync(file, buf);
      return json(res, 200, { ok: true, path: file, size: buf.length });
    } catch (err) {
      return json(res, 500, { error: `保存文件失败: ${err.message}` });
    }
  }

  if (req.method === 'GET' && resource === 'tools') {
    return json(res, 200, { tools: Object.keys(TOOLS).map((id) => ({ id, label: TOOL_LABELS[id] || id })) });
  }

  /* 环境诊断：CLI 是否安装、会话目录是否存在、登录/密钥是否已配置（不联网验证账号） */
  if (req.method === 'GET' && resource === 'env-check') {
    const probes = { codex: 'codex --version', pi: 'pi --version', claude: 'claude --version' };
    const results = [];
    for (const toolId of Object.keys(TOOLS)) {
      const tool = TOOLS[toolId];
      let root = null;
      try { root = tool.sessionsRoot?.() || null; } catch { /* ignore */ }
      const [probe, auth] = await Promise.all([
        probeCommand(probes[toolId]),
        Promise.resolve(readAuthHint(toolId)),
      ]);
      results.push({
        tool: toolId,
        label: TOOL_LABELS[toolId] || toolId,
        sessionsRoot: root,
        sessionsRootExists: !!root && fs.existsSync(root),
        versionProbe: probe,
        auth,
      });
    }
    return json(res, 200, { ok: true, results });
  }

  /* 全局搜索：标题/摘要命中即时返回；deep=1 时再扫会话正文（有时间与体积预算，避免卡住服务） */
  if (req.method === 'GET' && resource === 'search') {
    const q = String(url.searchParams.get('q') || '').trim();
    const deep = url.searchParams.get('deep') === '1';
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 40, 1), 80);
    if (!q) return json(res, 200, { q, deep, results: [], truncated: false });
    const lower = q.toLowerCase();
    const results = [];
    const matchedNodes = new Set();
    const projectName = (pid) => (db.projects.find((p) => p.id === pid)?.name || '');
    for (const t of db.tasks) {
      if (String(t.title || '').toLowerCase().includes(lower)) {
        results.push({ type: 'task', taskId: t.id, title: t.title, projectName: projectName(t.projectId), nodeCount: (t.nodes || []).length, updatedAt: t.updatedAt });
      }
      for (const n of t.nodes || []) {
        const sum = n.summary || {};
        const fields = [
          ['标题', n.title || ''],
          ['首条提问', sum.firstUser || ''],
          ['最近回复', sum.lastAssistant || ''],
          ['涉及文件', (sum.files || []).join(' ')],
        ];
        const hit = fields.find(([, text]) => String(text).toLowerCase().includes(lower));
        if (!hit) continue;
        matchedNodes.add(n.id);
        results.push({
          type: 'session', taskId: t.id, taskTitle: t.title, projectName: projectName(t.projectId),
          nodeId: n.id, tool: n.tool, title: n.title || '(会话)',
          where: hit[0], snippet: searchSnippet(hit[1], q),
          updatedAt: n.lastActivity || n.createdAt || t.updatedAt,
        });
      }
    }
    let truncated = false;
    if (deep) {
      const t0 = Date.now();
      const BUDGET_MS = 4000, MAX_FILES = 80, MAX_BYTES = 40 * 1024 * 1024, MAX_HITS_PER_NODE = 2;
      let files = 0;
      let bytes = 0;
      for (const t of db.tasks) {
        for (const n of t.nodes || []) {
          if (results.length >= limit) { truncated = true; break; }
          if (matchedNodes.has(n.id) || !n.file || n.file.startsWith('sqlite:')) continue;
          const parser = PARSERS[n.tool];
          if (!parser) continue;
          let st;
          try { st = fs.statSync(n.file); } catch { continue; }
          if (st.size > 12 * 1024 * 1024) continue;
          if (files >= MAX_FILES || bytes + st.size > MAX_BYTES || Date.now() - t0 > BUDGET_MS) { truncated = true; break; }
          files += 1;
          bytes += st.size;
          let evts;
          try { evts = parseSessionEvents(parser, n.file); } catch { continue; }
          let hits = 0;
          for (const e of evts) {
            if (e.kind !== 'user' && e.kind !== 'assistant') continue;
            const text = String(e.text || '');
            if (!text.toLowerCase().includes(lower)) continue;
            results.push({
              type: 'session', taskId: t.id, taskTitle: t.title, projectName: projectName(t.projectId),
              nodeId: n.id, tool: n.tool, title: n.title || '(会话)',
              where: e.kind === 'user' ? '用户消息' : 'AI 回复', snippet: searchSnippet(text, q),
              updatedAt: n.lastActivity || n.createdAt || t.updatedAt,
            });
            if (++hits >= MAX_HITS_PER_NODE) break;
            if (results.length >= limit) { truncated = true; break; }
          }
        }
        if (results.length >= limit) break;
      }
    }
    return json(res, 200, { q, deep, results: results.slice(0, limit), truncated: truncated || results.length > limit });
  }

  /* ---------- 内嵌终端 ---------- */
  if (req.method === 'GET' && resource === 'terms') {
    return json(res, 200, { terms: termmod.listTerms() });
  }
  if (req.method === 'POST' && resource === 'terms' && id === 'kill') {
    const body = await readBody(req);
    return json(res, 200, { ok: termmod.killTerm(body.id) });
  }
  // 一键关闭：body.tool 为空 = 关闭全部工具；指定 tool = 只关该工具的所有终端
  if (req.method === 'POST' && resource === 'terms' && id === 'kill-all') {
    const body = await readBody(req);
    const tool = body.tool ? String(body.tool) : null;
    if (tool && !TOOLS[tool]) return json(res, 400, { error: '未知工具' });
    return json(res, 200, { ok: true, killed: termmod.killAll(tool) });
  }

/* ---------- 会话流/历史：展示层解析与截断（capture/检查点链路保持全文保真，截断只用于展示传输） ---------- */
const STREAM_TAIL = 300;
const CLIP_TEXT = 6000;
const CLIP_ARGS = 2000;

function clipEvt(evt) {
  const clip = (value, max) => `${value.slice(0, max)}\n…[已截断，共 ${value.length} 字符]`;
  if (evt.kind === 'user' || evt.kind === 'assistant') {
    if (typeof evt.text === 'string' && evt.text.length > CLIP_TEXT) evt.text = clip(evt.text, CLIP_TEXT);
  } else if (evt.kind === 'tool_call' && typeof evt.args === 'string' && evt.args.length > CLIP_ARGS) {
    evt.args = clip(evt.args, CLIP_ARGS);
  }
  return evt;
}

function parseSessionEvents(parser, file) {
  const evts = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { parser(JSON.parse(t), evts); } catch { /* 半行跳过 */ }
  }
  return evts;
}

/* ---------- 会话实时流（SSE）：结构化会话视图的数据源 ---------- */
if (req.method === 'GET' && resource === 'stream') {
    const tool = url.searchParams.get('tool') || 'codex';
    const file = expandPath(url.searchParams.get('file') || '');
    const parser = PARSERS[tool];
    if (!parser) return json(res, 400, { error: '未知工具' });
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: '会话文件不存在' });
    // tail=N：首连只推最后 N 条事件（超大会话防卡死）；不传保持全量回放（兼容）
    const tailLimit = Number(url.searchParams.get('tail')) || 0;

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (evt) => {
      try { res.write(`data: ${JSON.stringify(evt)}\n\n`); } catch { /* 断开 */ }
    };
    // SSE 事件序号：断线重连时浏览器会带 Last-Event-ID，跳过已渲染的事件，避免整段历史重复
    const sendEvt = (evt, seq) => {
      try { res.write(`id: ${seq}\ndata: ${JSON.stringify(evt)}\n\n`); } catch { /* 断开 */ }
    };
    const lastEventId = Number(req.headers['last-event-id'] || 0) || 0;
    let offset = 0;
    let ordinal = 0; // 事件在文件中的绝对序号（被 tail 截掉的事件也计数，保证重连序号一致）
    let timer = null;
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { res.end(); } catch { /* 已断开 */ }
    };
    req.on('close', finish);
    const pushNew = () => {
      if (closed) return;
      try {
        if (!fs.existsSync(file)) {
          send({ type: 'gone' });
          finish();
          return;
        }
        const isFirst = offset === 0;
        const { chunk, nextOffset } = tailNewLines(file, offset);
        if (!chunk) return;
        offset = nextOffset;
        const evts = [];
        for (const line of chunk.split('\n')) {
          const t = line.trim();
          if (!t) continue;
          try { parser(JSON.parse(t), evts); } catch { /* 半行跳过 */ }
        }
        // 首连带 tail：只推最后 N 条，更早的由前端经 /api/session-history 按需回溯。
        // 带 Last-Event-ID 的重连不截断——只补客户端还没收到的事件（否则重连会重复整段历史）。
        const skipFirst = (isFirst && !lastEventId && tailLimit > 0 && evts.length > tailLimit)
          ? evts.length - tailLimit : 0;
        if (skipFirst > 0) send({ type: 'history-truncated', skipped: skipFirst, before: skipFirst, total: evts.length });
        for (let i = 0; i < evts.length; i++) {
          ordinal += 1;
          if (i < skipFirst) continue;          // 被截掉的更早事件也计数，保证序号稳定
          if (ordinal <= lastEventId) continue; // 重连时这些事件已经渲染过
          sendEvt(clipEvt(evts[i]), ordinal);
        }
      } catch { /* 读取失败下轮重试 */ }
    };
    pushNew(); // 先回放已有内容
    timer = setInterval(pushNew, 1000);
    return;
  }

  /* ---------- 会话历史回溯：工作轨迹「加载更早」分页（配合 /api/stream 的 tail 首推） ---------- */
  if (req.method === 'GET' && resource === 'session-history') {
    const tool = url.searchParams.get('tool') || 'codex';
    const parser = PARSERS[tool];
    if (!parser) return json(res, 400, { error: '未知工具' });
    const file = expandPath(url.searchParams.get('file') || '');
    if (!file || !fs.existsSync(file)) return json(res, 404, { error: '会话文件不存在' });
    const all = parseSessionEvents(parser, file);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500);
    const beforeRaw = url.searchParams.get('before');
    const before = beforeRaw == null ? all.length : Math.min(Math.max(Number(beforeRaw) || 0, 0), all.length);
    const start = Math.max(0, before - limit);
    return json(res, 200, {
      events: all.slice(start, before).map(clipEvt),
      hasMore: start > 0,
      before: start,
      total: all.length,
    });
  }

  if (req.method === 'GET' && resource === 'available') {
    const toolName = url.searchParams.get('tool') || 'codex';
    const tool = TOOLS[toolName];
    if (!tool) return json(res, 400, { error: '未知工具' });
    const cwd = url.searchParams.get('cwd') || null;
    const noFilter = url.searchParams.get('all') === '1';
    const all = tool.list({ limit: 300 });
    const filtered = (!noFilter && cwd)
      ? all.filter((it) => it.cwd && expandPath(it.cwd).toLowerCase() === expandPath(cwd).toLowerCase())
      : all;
    const shown = filtered.slice(0, 50);
    const items = shown.map((it) => {
      try {
        const conv = tool.read(it.file);
        const firstUser = conv.messages.find((m) => m.role === 'user');
        const s = summarize(conv);
        return {
          id: it.id,
          file: it.file,
          cwd: it.cwd,
          updatedAt: it.updatedAt,
          title: truncate(firstUser?.text || '(无提问)', 70),
          messageCount: s.messageCount,
          tokens: s.tokens,
        };
      } catch {
        return { id: it.id, file: it.file, cwd: it.cwd, updatedAt: it.updatedAt, title: '(读取失败)', messageCount: 0, tokens: 0 };
      }
    });
    return json(res, 200, {
      items,
      totalAll: all.length,
      totalFiltered: filtered.length,
      cwd: cwd || null,
      filtered: !noFilter && !!cwd,
    });
  }

  /* 自动获取项目：扫描三个工具的会话目录，按会话 cwd 分组导入看板。
     手动触发（侧栏按钮），不自动运行。规则：
     - 一个项目目录（cwd）= 一个项目文件夹（名字取目录 basename）
     - 每个目录下建一个「自动获取 · 目录名」任务，该目录所有工具的历史会话全部挂进去
     - 会话按 board 全局 sessionId 去重，导入按 updatedAt 升序（接力链顺序自然） */
  if (req.method === 'POST' && resource === 'discover') {
    const LIMIT = 150; // 每工具最多读最近 N 个会话
    const known = new Set();
    for (const t of db.tasks) for (const n of t.nodes || []) if (n.sessionId) known.add(String(n.sessionId));

    const groups = new Map(); // cwdNorm -> { cwd, items: [{ tool, item }] }
    for (const tool of Object.values(TOOLS)) {
      let items = [];
      try { items = tool.list({ limit: LIMIT }) || []; } catch { continue; }
      for (const it of items) {
        if (!it.cwd || !it.file || !fs.existsSync(it.file)) continue;
        if (known.has(String(it.id))) continue;
        const cwdAbs = expandPath(it.cwd);
        const key = cwdAbs.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
        if (!groups.has(key)) groups.set(key, { cwd: cwdAbs, items: [] });
        groups.get(key).items.push({ tool, item: it });
      }
    }

    let projectsCreated = 0, tasksCreated = 0, nodesAdded = 0, skipped = 0, readFail = 0;
    const detail = [];
    for (const g of groups.values()) {
      g.items.sort((a, b) => new Date(a.item.updatedAt) - new Date(b.item.updatedAt));
      // 每个分组开始前重新加载看板：扫描耗时较长，避免用旧快照覆盖用户并发改动
      const cur = store.load();
      const name = path.basename(g.cwd) || g.cwd;
      // 项目身份以目录为准：先按 cwd 匹配（手工建项目时填了目录也能复用），
      // 老数据没有 cwd 时按名称匹配并补绑目录，避免同一目录出现两个项目文件夹。
      let project = cur.projects.find((p) => p.cwd && normDir(p.cwd) === normDir(g.cwd));
      if (!project) {
        // 项目本身没记 cwd：用它已有任务里的会话目录反推（手工项目 + 接入过会话的情况）
        project = cur.projects.find((p) => cur.tasks
          .filter((t) => t.projectId === p.id)
          .some((t) => (t.nodes || []).some((n) => n.cwd && normDir(n.cwd) === normDir(g.cwd))));
        if (project && !project.cwd) { project.cwd = g.cwd; store.save(cur); }
      }
      if (!project) {
        const byName = cur.projects.find((p) => !p.cwd && (p.name || '').toLowerCase() === name.toLowerCase());
        if (byName) { byName.cwd = g.cwd; store.save(cur); project = byName; }
      }
      if (!project) {
        // 同名但不同目录：名字后面加父目录区分，避免看起来像重复项目
        let display = name;
        if (cur.projects.some((p) => (p.name || '').toLowerCase() === display.toLowerCase())) {
          const parent = path.basename(path.dirname(g.cwd));
          display = parent ? `${name} · ${parent}` : `${name} (${cur.projects.length + 1})`;
        }
        project = store.createProject(cur, display, g.cwd);
        projectsCreated++;
      }
      const taskTitle = `自动获取 · ${name}`;
      let task = cur.tasks.find((t) => t.projectId === project.id && t.title === taskTitle);
      if (!task) { task = store.createTask(cur, { projectId: project.id, title: taskTitle }); tasksCreated++; }
      let added = 0;
      for (const { tool, item } of g.items) {
        if (known.has(String(item.id))) { skipped++; continue; }
        try {
          const conv = tool.read(item.file);
          if (!conv.messages.some((m) => m.role === 'user')) { skipped++; continue; }
          // 每条会话落库前再重载一次：读取大文件期间用户可能新增/删除任务
          const fresh = store.load();
          if (!fresh.tasks.some((t) => t.id === task.id)) { skipped++; continue; }
          store.addNode(fresh, task.id, makeNode(tool.name, conv));
          known.add(String(item.id));
          added++; nodesAdded++;
        } catch { readFail++; }
      }
      if (added || tasksCreated) detail.push({ project: name, cwd: g.cwd, task: taskTitle, added });
    }
    return json(res, 200, { projectsCreated, tasksCreated, nodesAdded, skipped, readFail, groups: groups.size, detail });
  }

  if (req.method === 'POST' && resource === 'projects') {
    const body = await readBody(req);
    const cwdRaw = String(body.cwd || '').trim();
    const cwd = cwdRaw ? expandPath(cwdRaw) : null;
    if (cwd) {
      if (!fs.existsSync(cwd)) return json(res, 400, { error: `目录不存在: ${cwd}` });
      const clash = db.projects.find((p) => {
        if (p.cwd && normDir(p.cwd) === normDir(cwd)) return true;
        // 老数据/自动获取的项目可能没记 cwd：用其任务下的会话目录反推
        return db.tasks
          .filter((t) => t.projectId === p.id)
          .some((t) => (t.nodes || []).some((n) => n.cwd && normDir(n.cwd) === normDir(cwd)));
      });
      if (clash) return json(res, 409, { error: `这个目录已经属于项目「${clash.name}」，不能重复创建` });
    }
    const name = String(body.name || (cwd ? path.basename(cwd) : '')).trim();
    if (!name) return json(res, 400, { error: '请输入名称或目录' });
    return json(res, 200, store.createProject(db, name, cwd));
  }

  if (req.method === 'DELETE' && resource === 'projects' && id) {
    db.projects = db.projects.filter((p) => p.id !== id);
    for (const t of db.tasks) if (t.projectId === id) t.projectId = null;
    store.save(db);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && resource === 'tasks' && !id) {
    const body = await readBody(req);
    return json(res, 200, store.createTask(db, { projectId: body.projectId, title: body.title }));
  }

  if (resource === 'tasks' && id) {
    /* ---------- 动态上下文路由 ---------- */

    // 绑定任务 ↔ 上下文库；boardTask 的节点作为捕获输入
    if (req.method === 'POST' && sub === 'bind') {
      const body = await readBody(req);
      const boardTask = db.tasks.find((t) => t.id === id);
      if (!boardTask) return json(res, 404, { error: '任务不存在' });
      const cwd = body.cwd ? expandPath(body.cwd) : (boardTask.nodes.find((n) => n.cwd)?.cwd || null);
      const ctxTaskId = ctxdb.ensureTask({ boardTaskId: id, title: boardTask.title, cwd });
      const ctxTask = ctxdb.getTask(ctxTaskId);
      if (cwd && !ctxTask.project_id) {
        ctxdb.openDb().prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(ctxdb.upsertProject(cwd), ctxTaskId);
      }
      ctxdb.openDb().prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ctxdb.now(), ctxTaskId);
      return json(res, 200, { ctxTaskId, cwd });
    }

    if (req.method === 'POST' && sub === 'capture') {
      const ctxTaskId = requireCtxTask(id);
      if (!ctxTaskId) return json(res, 400, { error: '任务未绑定上下文，先调用 bind' });
      const t0 = Date.now();
      const stats = captureTask(ctxTaskId, { sessions: boardSessions(db, id) });
      ctxdb.recordMetric({ taskId: ctxTaskId, kind: 'capture', durationMs: Date.now() - t0, tokens: 0, extra: { newEvents: stats.newEvents } });
      return json(res, 200, { stats, summary: contextSummary(ctxTaskId) });
    }

    if (req.method === 'GET' && sub === 'context') {
      const ctxTaskId = requireCtxTask(id);
      if (!ctxTaskId) return json(res, 200, { unbound: true, summary: null });
      return json(res, 200, { unbound: false, ctxTaskId, summary: contextSummary(ctxTaskId), costs: ctxdb.metricsSummary(ctxTaskId) });
    }

    if (req.method === 'GET' && sub === 'checkpoints') {
      const ctxTaskId = requireCtxTask(id);
      if (!ctxTaskId) return json(res, 200, { checkpoints: [] });
      const rows = ctxdb.openDb().prepare('SELECT id, version, injected_tokens, llm_used, loss_json, created_at FROM checkpoints WHERE task_id = ? ORDER BY version DESC').all(ctxTaskId);
      return json(res, 200, {
        checkpoints: rows.map((r) => {
          let loss = null;
          try { loss = r.loss_json ? JSON.parse(r.loss_json) : null; } catch { /* 旧数据无 loss */ }
          return { id: r.id, version: r.version, injectedTokens: r.injected_tokens, llmUsed: !!r.llm_used, loss, createdAt: r.created_at };
        }),
      });
    }

    if (req.method === 'POST' && sub === 'checkpoint' && url.searchParams.get('rollback')) {
      // 回退：用历史版本 rendered 重新生成目标会话（走 handoff-smart 同管线）
      const body = await readBody(req);
      const to = TOOLS[body.toTool];
      if (!to) return json(res, 400, { error: '未知工具' });
      const bound = bindOrThrow(db, id);
      if (!bound.ok) return json(res, bound.status, { error: bound.error });
      const row = ctxdb.openDb().prepare('SELECT * FROM checkpoints WHERE task_id = ? AND version = ?').get(bound.ctxTaskId, Number(body.version));
      if (!row) return json(res, 404, { error: `检查点 v${body.version} 不存在` });
      const targetCwd = body.cwd ? expandPath(body.cwd) : bound.cwd;
      const embed = body.embed === true;
      const result = writeCheckpointSession(to, bound.ctxTaskId, row.rendered, targetCwd, row.version, { launch: body.launch !== false && !embed, embed });
      const node = store.addNode(db, id, {
        tool: to.name,
        sessionId: result.sessionId,
        file: result.file,
        cwd: targetCwd,
        title: `检查点 v${row.version} 回退接力`,
        createdAt: new Date().toISOString(),
        summary: { messageCount: 2, turnCount: 1, tokens: row.injected_tokens, firstUser: truncate(row.rendered, 300), lastAssistant: result.ack, files: [] },
        parentNodeId: body.nodeId || null,
        checkpointVersion: row.version,
        edgeKind: 'handoff',
        resumeCommand: result.resumeCommand,
        registration: result.registration || null,
        termId: result.termId || null,
      });
      return json(res, 200, { node, resumeCommand: result.resumeCommand, launched: result.launched, termId: result.termId || null, checkpointVersion: row.version, registration: result.registration || null });
    }

    if (req.method === 'POST' && sub === 'checkpoint') {
      const body = await readBody(req);
      const bound = bindOrThrow(db, id);
      if (!bound.ok) return json(res, bound.status, { error: bound.error });
      const cwd = body.cwd ? expandPath(body.cwd) : bound.cwd;
      const t0 = Date.now();
      try {
        const result = await buildCheckpoint(bound.ctxTaskId, {
          useLlm: body.useLlm !== false,
          cwd,
          sessions: boardSessions(db, id),
        });
        ctxdb.recordMetric({
          taskId: bound.ctxTaskId, kind: 'checkpoint', durationMs: Date.now() - t0,
          tokens: result.llmTokens, extra: { version: result.version, llmUsed: result.llmUsed, injectedTokens: result.injectedTokens },
        });
        return json(res, 200, result);
      } catch (err) {
        return json(res, 500, { error: `检查点生成失败: ${err.message}` });
      }
    }

    if (req.method === 'POST' && sub === 'handoff-smart') {
      const body = await readBody(req);
      const to = TOOLS[body.toTool];
      if (!to) return json(res, 400, { error: '未知工具' });
      const bound = bindOrThrow(db, id);
      if (!bound.ok) return json(res, bound.status, { error: bound.error });
      let targetCwd = body.cwd ? expandPath(body.cwd) : bound.cwd;
      if (!targetCwd) return json(res, 400, { error: '缺少工作目录' });
      // 接力目标同样默认落在独立 worktree（干净仓库时才建，避免新会话看不到未提交改动）
      let worktree = null;
      if (body.worktree !== false) {
        const wt = maybeCreateWorktree(targetCwd, `${to.name}-handoff`);
        if (wt.created) { targetCwd = wt.cwd; worktree = { path: wt.cwd, branch: wt.branch, repo: wt.repo }; }
        else worktree = { created: false, reason: wt.reason };
      }

      const t0 = Date.now();
      try {
        const ckpt = await buildCheckpoint(bound.ctxTaskId, {
          useLlm: body.useLlm !== false,
          cwd: targetCwd,
          sessions: boardSessions(db, id),
        });
        const embed = body.embed === true;
        // 合并/接力前扫描项目现状：不依赖「哪个会话最新」，以工作区事实兜底
        const truth = body.scanTruth === false ? null : scanProjectTruth(targetCwd);
        const finalRendered = truth?.text ? `${ckpt.rendered}\n\n${truth.text}` : ckpt.rendered;
        const injectedTokens = ckpt.injectedTokens + (truth?.text ? estimateTokens(truth.text) : 0);
        const result = writeCheckpointSession(to, bound.ctxTaskId, finalRendered, targetCwd, ckpt.version, { launch: body.launch !== false && !embed, embed });

        ctxdb.recordMetric({
          taskId: bound.ctxTaskId, kind: 'handoff', durationMs: Date.now() - t0,
          tokens: injectedTokens, extra: { toTool: to.name, version: ckpt.version, llmUsed: ckpt.llmUsed, llmTokens: ckpt.llmTokens, embed, truthScan: !!truth?.text },
        });

        // 接力是长任务（LLM 检查点 10-60 秒），写回前重载看板，避免用旧快照覆盖用户并发改动
        const freshDb = store.load();
        const node = store.addNode(freshDb, id, {
          tool: to.name,
          sessionId: result.sessionId,
          file: result.file,
          cwd: targetCwd,
          title: `检查点 v${ckpt.version} 接力`,
          createdAt: new Date().toISOString(),
          summary: { messageCount: 2, turnCount: 1, tokens: injectedTokens, firstUser: truncate(finalRendered, 300), lastAssistant: result.ack, files: [] },
          parentNodeId: body.nodeId || null,
          checkpointVersion: ckpt.version,
          edgeKind: 'handoff',
          llmUsed: ckpt.llmUsed,
          resumeCommand: result.resumeCommand,
          registration: result.registration || null,
          termId: result.termId || null,
        });

        return json(res, 200, {
          node, resumeCommand: result.resumeCommand, launched: result.launched,
          termId: result.termId || null, worktree,
          checkpointVersion: ckpt.version, injectedTokens,
          truthScan: !!truth?.text,
          llmUsed: ckpt.llmUsed, llmTokens: ckpt.llmTokens, lossReport: ckpt.lossReport || null,
          registration: result.registration || null,
        });
      } catch (err) {
        return json(res, 500, { error: `智能接力失败: ${err.message}` });
      }
    }

    /* ---------- 看板原有路由 ---------- */
    /* 子代理修复不设专门端点/按钮：能力由全局 AGENTS.md/CLAUDE.md 协议提供（subagent-protocol.mjs），
       用户直接对话触发；跨工具迭代场景走 handoff-smart 接力。 */

    if (req.method === 'GET' && !sub) {
      const detail = taskDetail(db, id);
      return detail ? json(res, 200, detail) : json(res, 404, { error: '任务不存在' });
    }
    if (req.method === 'PATCH' && !sub) {
      const body = await readBody(req);
      const updated = store.updateTask(db, id, body);
      return updated ? json(res, 200, updated) : json(res, 404, { error: '任务不存在' });
    }
    if (req.method === 'DELETE' && !sub) {
      return json(res, 200, { ok: store.deleteTask(db, id) });
    }

    if (req.method === 'POST' && sub === 'launch') {
      const body = await readBody(req);
      if (!TOOLS[body.tool]) return json(res, 400, { error: '未知工具' });
      const cwd = expandPath(body.cwd || '');
      if (!fs.existsSync(cwd)) return json(res, 400, { error: `目录不存在: ${cwd}` });
      // 并行隔离：默认在 git worktree 里起新会话（只对干净仓库；否则回退原目录并说明原因）
      let runCwd = cwd;
      let worktree = null;
      if (body.worktree !== false) {
        const wt = maybeCreateWorktree(cwd, `${body.tool}-${(body.title || 'session')}`);
        if (wt.created) { runCwd = wt.cwd; worktree = { path: wt.cwd, branch: wt.branch, repo: wt.repo }; }
        else worktree = { created: false, reason: wt.reason };
      }
      // 内嵌模式：agent 跑在 sbridge 窗口里的终端，不另开 PowerShell 窗口
      if (body.embed) {
        const term = termmod.spawnTerm({ tool: body.tool, cwd: runCwd, command: LAUNCH_COMMANDS[body.tool], label: `${TOOL_LABELS[body.tool]} · 新会话` });
        return json(res, 200, { ok: true, cwd: runCwd, worktree, since: new Date().toISOString(), termId: term.id });
      }
      // 在独立终端窗口启动交互式会话，工作目录即任务目录
      try {
        const cmd = LAUNCH_COMMANDS[body.tool] || body.tool;
        // Linux/macOS 没有可靠的通用「弹终端」命令：直接退回内嵌终端，能力一致
        if (process.platform !== 'win32') {
          const term = termmod.spawnTerm({ tool: body.tool, cwd: runCwd, command: cmd, label: `${TOOL_LABELS[body.tool]} · 新会话` });
          return json(res, 200, { ok: true, cwd: runCwd, worktree, since: new Date().toISOString(), termId: term.id, embedded: true });
        }
        spawn(`start "sbridge" powershell -NoExit -Command "${cmd}"`, {
          shell: true, cwd: runCwd, detached: true, stdio: 'ignore',
        }).unref();
      } catch (err) {
        return json(res, 500, { error: `启动终端失败: ${err.message}` });
      }
      return json(res, 200, { ok: true, cwd: runCwd, worktree, since: new Date().toISOString() });
    }

    // 无头发送（工作轨迹主路径）：聊天消息不经终端 TUI，直接用 CLI 无头模式恢复会话执行。
    // 消息与回复都写进会话文件，工作轨迹经捕获实时呈现。进程写完即退，不占终端。
    const headlessBusy = globalThis.__sbHeadlessBusy || (globalThis.__sbHeadlessBusy = new Set());
    const headlessStatus = globalThis.__sbHeadlessStatus || (globalThis.__sbHeadlessStatus = new Map());
    const headlessChildren = globalThis.__sbHeadlessChildren || (globalThis.__sbHeadlessChildren = new Map());
    const HEADLESS_TIMEOUT_MS = 10 * 60_000; // 看门狗：CLI 卡死时不能把该会话永久占住
    const HEADLESS_ENV = { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    if (req.method === 'GET' && sub === 'headless-status') {
      return json(res, 200, { status: headlessStatus.get(url.searchParams.get('nodeId')) || null });
    }
    // 取消无头执行（前端状态条上的「取消执行」）
    if (req.method === 'POST' && (sub === 'cancel-headless' || (sub === 'nodes' && subId && extra === 'cancel-headless'))) {
      const body = await readBody(req);
      const nid = subId || body.nodeId;
      if (!nid || !headlessBusy.has(nid)) return json(res, 409, { error: '没有正在执行的任务' });
      const child = headlessChildren.get(nid);
      headlessStatus.set(nid, { running: false, exitCode: -2, canceled: true, stderrTail: '已取消', endedAt: Date.now(), tool: headlessStatus.get(nid)?.tool });
      headlessBusy.delete(nid);
      headlessChildren.delete(nid);
      killProcessTree(child?.pid);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && sub === 'send-headless') {
      const body = await readBody(req);
      const node = db.tasks.flatMap((t) => (t.id === id ? t.nodes : [])).find((n) => n.id === body.nodeId);
      if (!node) return json(res, 404, { error: '节点不存在' });
      const tool = TOOLS[node.tool];
      if (!tool) return json(res, 400, { error: '未知工具' });
      const message = String(body.message || '').trim();
      if (!message) return json(res, 400, { error: '消息为空' });
      const cwd = expandPath(node.cwd || '');
      if (!cwd || !fs.existsSync(cwd)) return json(res, 400, { error: `工作目录不存在: ${cwd}` });
      let sessionId = node.sessionId || null;
      if (!sessionId && node.file && !node.file.startsWith('sqlite:')) {
        try { sessionId = tool.read(node.file).id; } catch { /* 读不出就开新会话 */ }
      }
      if (headlessBusy.has(node.id)) return json(res, 409, { error: '上一条消息还在执行中，等它完成再发' });
      // 无头命令：claude -p --resume <id> / pi --session <id> -p / codex exec resume <id>。
      // 消息一律走 stdin（避开 Windows 命令行引号地狱）；NO_PROXY 放行本地网关。
      const baseCmd = {
        claude: `claude -p --permission-mode acceptEdits${sessionId ? ` --resume ${sessionId}` : ''}`,
        pi: `pi${sessionId ? ` --session ${sessionId}` : ''} -p`,
        codex: `codex exec --skip-git-repo-check -s workspace-write${sessionId ? ` resume ${sessionId}` : ''} -`,
      }[node.tool];
      if (!baseCmd) return json(res, 400, { error: '该工具暂不支持无头发送' });
      const cmd = baseCmd + modelFlags(node.tool, node.model, node.modelProvider);
      headlessBusy.add(node.id);
      headlessStatus.set(node.id, { running: true, startedAt: Date.now(), tool: node.tool });
      let child;
      try {
        child = spawn(cmd, { cwd, env: HEADLESS_ENV, windowsHide: true, shell: true });
      } catch (err) {
        headlessBusy.delete(node.id);
        headlessStatus.set(node.id, { running: false, exitCode: -1, stderrTail: String(err.message || err), endedAt: Date.now(), tool: node.tool });
        return json(res, 500, { error: `启动无头执行失败: ${err.message}` });
      }
      child.unref();
      headlessChildren.set(node.id, child);
      let stderrTail = '';
      let settled = false;
      let watchdog = null;
      const finish = (code, extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        headlessBusy.delete(node.id);
        headlessChildren.delete(node.id);
        // 取消/超时已经写过终态，退出事件不要覆盖它
        const prev = headlessStatus.get(node.id);
        if (!prev || prev.running) headlessStatus.set(node.id, { running: false, exitCode: code, stderrTail, endedAt: Date.now(), tool: node.tool, ...extra });
      };
      watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        stderrTail = '执行超时（10 分钟），已终止';
        headlessBusy.delete(node.id);
        headlessChildren.delete(node.id);
        headlessStatus.set(node.id, { running: false, exitCode: -1, timedOut: true, stderrTail, endedAt: Date.now(), tool: node.tool });
        killProcessTree(child.pid);
      }, HEADLESS_TIMEOUT_MS);
      watchdog.unref?.();
      child.stderr?.on('data', (d) => { stderrTail = (stderrTail + d).slice(-600); });
      child.stdin?.write(message + '\n');
      child.stdin?.end();
      child.on('exit', (code) => finish(code));
      child.on('error', (err) => finish(-1, { stderrTail: String(err.message || err) }));
      return json(res, 200, { ok: true });
    }

    // 内嵌终端：在任务里直接启动/恢复一个 agent（接力或手动恢复用）
    if (req.method === 'POST' && sub === 'term') {
      const body = await readBody(req);
      if (!TOOLS[body.tool]) return json(res, 400, { error: '未知工具' });
      const cwd = expandPath(body.cwd || '');
      if (!fs.existsSync(cwd)) return json(res, 400, { error: `目录不存在: ${cwd}` });
      let command = body.resumeCommand || null;
      // 「接入已有会话」的节点只有会话文件、没有 resumeCommand：从文件反解会话 id
      // 构造 resume 命令。否则会当成全新会话启动——终端没有历史，发消息也进了一个
      // 新会话（用户看起来就是「没历史、发消息没反应」）。
      if (!command && body.file) {
        const file = expandPath(body.file);
        if (fs.existsSync(file)) {
          try {
            const conv = TOOLS[body.tool].read(file);
            if (conv?.id) command = RESUME_COMMANDS[body.tool]?.(conv.id) || null;
          } catch { /* 文件损坏则退回新会话启动 */ }
        }
      }
      command = command || LAUNCH_COMMANDS[body.tool];
      // 这个会话在工作轨迹里选过模型：新终端直接带同样的模型启动（两边保持一致）
      const modelNode = body.nodeId
        ? db.tasks.flatMap((t) => t.nodes).find((n) => n.id === body.nodeId)
        : null;
      if (modelNode?.model && !/--model\b/.test(command)) {
        command += modelFlags(body.tool, modelNode.model, modelNode.modelProvider);
      }
      // Claude/Codex 的 resume 不回放历史（CLI 无行式模式），从会话文件生成显示层回放；
      // pi 自带 --tui-mode regular 回放，注入反而重复。
      // 回放注入仅对「行式打印」工具有意义。Claude/Codex 的 TUI 启动用 \x1b[H 绝对定位
      // 重绘缓冲区，会原地擦掉注入的回放（分隔线下空白/历史被覆盖等伪影的根源）；
      // 它们的实况 TUI 原生显示，历史看「工作轨迹」。pi 有 --tui-mode regular 自行打印历史。
      const replay = false;
      const term = termmod.spawnTerm({ tool: body.tool, cwd, command, label: body.label || command, replay, nodeId: body.nodeId || null });
      return json(res, 200, { termId: term.id, command, cwd, replayed: !!replay, resumed: command !== LAUNCH_COMMANDS[body.tool] });
    }

    if (req.method === 'GET' && sub === 'scan-new') {
      const scanTask = db.tasks.find((t) => t.id === id);
      if (!scanTask) return json(res, 404, { error: '任务不存在' });
      const tool = TOOLS[url.searchParams.get('tool')];
      if (!tool) return json(res, 400, { error: '未知工具' });
      const since = new Date(url.searchParams.get('since') || 0).getTime() - 5000;
      const cwd = url.searchParams.get('cwd') ? expandPath(url.searchParams.get('cwd')) : null;
      const known = new Set(scanTask.nodes.map((n) => n.sessionId));
      const candidates = tool.list({ limit: 50 }).filter((it) =>
        new Date(it.updatedAt).getTime() > since
        && !known.has(it.id)
        && (!cwd || samePath(it.cwd, cwd))
      );
      for (const it of candidates) {
        try {
          const conv = tool.read(it.file);
          if (!conv.messages.some((m) => m.role === 'user')) continue;
          const node = store.addNode(db, id, makeNode(tool.name, conv));
          return json(res, 200, { node });
        } catch {
          continue;
        }
      }
      return json(res, 200, { node: null });
    }

    if (req.method === 'POST' && sub === 'nodes' && !subId) {
      const body = await readBody(req);
      const tool = TOOLS[body.tool];
      if (!tool) return json(res, 400, { error: '未知工具' });
      const file = body.file || (body.sessionId ? findSessionFile(tool, body.sessionId) : null);
      if (!file) return json(res, 400, { error: '找不到该会话' });
      try {
        const conv = tool.read(file);
        const node = store.addNode(db, id, makeNode(tool.name, conv, { parentNodeId: body.parentNodeId || null }));
        return node ? json(res, 200, node) : json(res, 404, { error: '任务不存在' });
      } catch (err) {
        return json(res, 500, { error: `读取会话失败: ${err.message}` });
      }
    }

    // 子代理修复记录（吸收 Paseo「可视化管理子代理」思路）：
    // 读项目下 .sbridge-fix 的修复窗口，把窗口内新出现的其他会话作为「子代理会话」列出，
    // 前端可一键打开（已在看板里的直接开，没有的以 parentNodeId 接进当前链）。
    if (req.method === 'GET' && sub === 'nodes' && subId && extra === 'subagents') {
      const node = taskDetail(db, id)?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '卡片不存在' });
      const cwd = expandPath(node.cwd || '');
      const fixDir = path.join(cwd, '.sbridge-fix');
      let fix = { exists: false };
      let startMs = 0;
      let endMs = 0;
      if (fs.existsSync(fixDir)) {
        const pick = (name) => {
          const f = path.join(fixDir, name);
          try { return { name, text: fs.readFileSync(f, 'utf8'), mtime: fs.statSync(f).mtimeMs }; } catch { return null; }
        };
        const prompt = pick('prompt.md');
        const runner = pick('run-fix.cmd');
        let logs = [];
        try {
          logs = fs.readdirSync(fixDir).filter((f) => /\.log$/i.test(f)).map((f) => {
            const st = fs.statSync(path.join(fixDir, f));
            return { name: f, size: st.size, mtime: st.mtimeMs };
          });
        } catch { /* ignore */ }
        const times = [prompt?.mtime, runner?.mtime, ...logs.map((l) => l.mtime)].filter(Boolean);
        if (times.length) {
          startMs = Math.min(...times);
          endMs = Math.max(...times);
        }
        const worker = runner?.text ? (/claude/i.test(runner.text) ? 'claude' : /codex/i.test(runner.text) ? 'codex' : /pi\b/i.test(runner.text) ? 'pi' : null) : null;
        fix = {
          exists: true,
          worker,
          prompt: truncate(prompt?.text || '', 1400),
          logs,
          startedAt: startMs ? new Date(startMs).toISOString() : null,
          updatedAt: endMs ? new Date(endMs).toISOString() : null,
        };
      }
      const sessions = [];
      if (fix.exists && startMs) {
        const known = new Set((db.tasks.find((t) => t.id === id)?.nodes || []).map((n) => n.sessionId).filter(Boolean));
        const nodeBySession = new Map((db.tasks.find((t) => t.id === id)?.nodes || []).map((n) => [n.sessionId, n.id]));
        for (const tool of Object.values(TOOLS)) {
          let list = [];
          try { list = tool.list({ limit: 120 }); } catch { /* 单个工具失败不影响 */ }
          for (const it of list) {
            if (!samePath(it.cwd || '', cwd)) continue;
            if (it.id === node.sessionId) continue;
            const ts = new Date(it.updatedAt).getTime();
            if (ts < startMs - 5 * 60_000 || ts > endMs + 15 * 60_000) continue;
            let title = '';
            try {
              const conv = tool.read(it.file);
              title = conv.messages.find((m) => m.role === 'user')?.text || '';
            } catch { /* 读不出标题就留空 */ }
            sessions.push({
              tool: tool.name, file: it.file, sessionId: it.id,
              title: truncate(title || '(子代理会话)', 80),
              updatedAt: it.updatedAt,
              nodeId: nodeBySession.get(it.id) || null,
              imported: known.has(it.id),
            });
          }
        }
      }
      const seen = new Set();
      const unique = sessions
        .filter((s) => (seen.has(s.sessionId) ? false : (seen.add(s.sessionId), true)))
        .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
        .slice(0, 8);
      return json(res, 200, { fix, sessions: unique });
    }

    /* 项目现状详情（结构化 + 可直接塞检查点的文本）：git/磁盘事实，与具体工具无关 */
    if (req.method === 'GET' && sub === 'project-state') {
      const detail = taskDetail(db, id);
      if (!detail) return json(res, 404, { error: '任务不存在' });
      const cwd = url.searchParams.get('cwd')
        || detail.nodes.find((n) => n.cwd)?.cwd
        || '';
      if (!cwd || !fs.existsSync(cwd)) return json(res, 200, { project: null, text: null });
      const state = scanProjectState(cwd, { force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, { project: state, text: renderProjectTruth(state, cwd) });
    }

    /* 会话分支：用对应 CLI 的原生 fork 复制当前会话（保留完整历史），新建节点挂在父节点下 */
    if (req.method === 'POST' && sub === 'nodes' && subId && extra === 'fork') {
      const task = db.tasks.find((t) => t.id === id);
      const node = task?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '节点不存在' });
      const tool = TOOLS[node.tool];
      if (!tool) return json(res, 400, { error: '未知工具' });
      const cwd = expandPath(node.cwd || '');
      if (!cwd || !fs.existsSync(cwd)) return json(res, 400, { error: `工作目录不存在: ${cwd}` });
      const sid = String(node.sessionId || '').trim();
      if (!sid) return json(res, 400, { error: '这个会话没有 session id，无法分支' });
      let before = new Set();
      try { before = new Set((tool.list({ limit: 200 }) || []).map((it) => String(it.id))); } catch { /* ignore */ }

      /* Claude 的 fork 要等第一条输入才落盘：先无头注入一条中性消息，再建节点 + 开交互终端 */
      if (node.tool === 'claude') {
        // 只要一句极短回复触发新会话落盘：不让模型读文件/跑工具，避免分支创建变慢
        const prompt = 'Reply with OK only. Do not read files. Do not run any tools.';
        const exitCode = await new Promise((resolve) => {
          let child;
          try {
            child = spawn(`claude --resume ${sid} --fork-session -p "${prompt}"`, [], {
              cwd, shell: true, windowsHide: true, stdio: 'ignore',
              env: { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' },
            });
          } catch { resolve(-1); return; }
          const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } resolve(-1); }, 120000);
          child.on('exit', (c) => { clearTimeout(timer); resolve(c ?? 0); });
          child.on('error', () => { clearTimeout(timer); resolve(-1); });
        });
        let created = null;
        for (let i = 0; i < 40 && !created; i++) {
          try {
            created = (tool.list({ limit: 200 }) || [])
              .find((it) => !before.has(String(it.id)) && normDir(it.cwd) === normDir(cwd)) || null;
          } catch { /* ignore */ }
          if (!created) await new Promise((r) => setTimeout(r, 250));
        }
        if (!created) {
          return json(res, 500, { error: `Claude 分支创建失败（无头返回 ${exitCode}），请重试或改用终端命令` });
        }
        try {
          const conv = tool.read(created.file);
          // 分支创建耗时数秒，写回前重载看板
          const freshDb = store.load();
          const newNode = store.addNode(freshDb, id, makeNode(tool.name, conv, {
            parentNodeId: node.id,
            resumeCommand: `claude --resume ${conv.id}`,
            edgeKind: 'branch',
          }));
          const term = termmod.spawnTerm({ tool: 'claude', cwd, command: `claude --resume ${conv.id}`, label: `${TOOL_LABELS.claude} · 分支` });
          termmod.setTermNode(term.id, newNode.id);
          return json(res, 200, { ok: true, node: newNode, termId: term.id });
        } catch (err) {
          return json(res, 500, { error: `读取分支会话失败: ${err.message}` });
        }
      }

      let command = '';
      let resumeCommand = '';
      if (node.tool === 'codex') { command = `codex fork ${sid}`; resumeCommand = 'codex resume'; }
      else { command = `pi --fork ${sid}`; resumeCommand = 'pi --session'; }

      const term = termmod.spawnTerm({ tool: node.tool, cwd, command, label: `${TOOL_LABELS[node.tool] || node.tool} · 分支` });

      let created = null;
      for (let i = 0; i < 48 && !created; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const items = tool.list({ limit: 200 }) || [];
          created = items.find((it) => !before.has(String(it.id)) && normDir(it.cwd) === normDir(cwd)) || null;
        } catch { /* ignore */ }
      }
      if (!created) {
        return json(res, 200, {
          ok: true, node: null, termId: term.id,
          warning: '分支终端已启动，但还没检测到新会话文件；可在终端里继续，稍后自动获取会收录',
        });
      }
      try {
        const conv = tool.read(created.file);
        // 分支创建耗时数秒，写回前重载看板
        const freshDb = store.load();
        const newNode = store.addNode(freshDb, id, makeNode(tool.name, conv, {
          parentNodeId: node.id,
          resumeCommand: `${resumeCommand} ${conv.id}`,
          edgeKind: 'branch',
        }));
        termmod.setTermNode(term.id, newNode.id);
        return json(res, 200, { ok: true, node: newNode, termId: term.id });
      } catch (err) {
        return json(res, 500, { error: `读取分支会话失败: ${err.message}`, termId: term.id });
      }
    }

    /* 侧边对话：拿当前会话最近的上下文，生成一个独立会话（新文件，不改动原会话），
       供右侧面板并行对话；之后面板用 send-headless 继续。 */
    if (req.method === 'POST' && sub === 'nodes' && subId && extra === 'side-chat') {
      const task = db.tasks.find((t) => t.id === id);
      const node = task?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '节点不存在' });
      const to = TOOLS[node.tool];
      if (!to) return json(res, 400, { error: '未知工具' });
      const cwd = expandPath(node.cwd || '');
      if (!cwd || !fs.existsSync(cwd)) return json(res, 400, { error: `工作目录不存在: ${cwd}` });
      const digest = buildSideDigest(node);
      const seedTokens = estimateTokens(digest.text);
      const ack = `已接收主会话上下文摘录（约 ${seedTokens} tokens）。这是一条独立的侧边对话，不会改动主会话。`;
      let result;
      try {
        const modelOpt = node.model && node.modelProvider
          ? { provider: node.modelProvider, modelId: node.model } : undefined;
        result = to.write({
          sourceTool: 'sbridge', id: 'side', cwd,
          messages: [
            { role: 'user', text: digest.text, ts: new Date().toISOString(), tools: [] },
            { role: 'assistant', text: ack, ts: new Date().toISOString(), tools: [] },
          ],
        }, { cwd, model: modelOpt });
      } catch (err) {
        return json(res, 500, { error: `创建侧边会话失败: ${err.message}` });
      }
      // 生成会话文件是本地写盘，很快；写回前重载，避免覆盖用户并发改动
      const freshDb = store.load();
      const sideNode = store.addNode(freshDb, id, {
        tool: node.tool,
        sessionId: result.id,
        file: result.file,
        cwd,
        title: `侧边对话 · ${truncate(node.title || '(会话)', 40)}`,
        createdAt: new Date().toISOString(),
        summary: {
          messageCount: 2, turnCount: 1, tokens: seedTokens,
          firstUser: truncate(digest.text, 300), lastAssistant: ack, files: [],
        },
        parentNodeId: node.id,
        edgeKind: 'side',
        sideOf: node.id,
        model: node.model || null,
        modelProvider: node.modelProvider || null,
        modelSeen: node.model || null,
        resumeCommand: result.resumeCommand,
        registration: result.registration || null,
      });
      return json(res, 200, { ok: true, node: sideNode, seedTokens, seedChars: digest.messageChars });
    }

    /* 上下文用量（单节点，轻量）：读工具自己的用量记录 + 该节点终端里的状态栏 */
    if (req.method === 'GET' && sub === 'nodes' && subId && extra === 'usage') {
      const node = db.tasks.find((t) => t.id === id)?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '节点不存在' });
      const ctx = computeContextUsage(node, termmod.tailTextForNode(node.id));
      return json(res, 200, { ctx: ctx || null });
    }

    /* 会话导出 Markdown：只读会话文件，供用户归档；Codex sqlite 会话暂不支持 */
    if (req.method === 'GET' && sub === 'nodes' && subId && extra === 'export') {
      const node = db.tasks.find((t) => t.id === id)?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '节点不存在' });
      const file = node.file && !String(node.file).startsWith('sqlite:') ? expandPath(node.file) : null;
      if (!file || !fs.existsSync(file)) return json(res, 400, { error: '该会话没有可导出的本地文件（Codex 数据库会话暂不支持）' });
      const parser = PARSERS[node.tool];
      if (!parser) return json(res, 400, { error: '未知工具' });
      const evts = parseSessionEvents(parser, file);
      res.writeHead(200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="sbridge-${node.id}.md"`,
        'cache-control': 'no-cache',
      });
      return res.end(renderSessionMarkdown(node, evts));
    }

    /* 模型：读取当前模型 + 可选列表（数据来自各 CLI 自己的配置） */
    if (req.method === 'GET' && sub === 'nodes' && subId && extra === 'model') {
      const node = db.tasks.find((t) => t.id === id)?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '节点不存在' });
      const catalog = listModels(node.tool);
      const detected = detectSessionModel(node);
      const sync = url.searchParams.get('sync') !== '0';
      // modelSeen = 上次记录时会话文件里的模型值；两者不同 = 终端里真的换过模型
      const terminalChanged = !!detected && detected !== (node.modelSeen || '');
      // 同步开启时：终端里改过模型就回填到节点，保证无头执行用同一个
      if (sync && terminalChanged) {
        try {
          const fresh = store.load();
          const n2 = fresh.tasks.find((t) => t.id === id)?.nodes.find((n) => n.id === subId);
          if (n2) { n2.model = detected; n2.modelSeen = detected; store.save(fresh); }
        } catch { /* 写回失败不影响展示 */ }
      }
      const current = sync && terminalChanged
        ? (detected || node.model || catalog.configModel || '')
        : (node.model || detected || catalog.configModel || '');
      return json(res, 200, {
        tool: node.tool, current, sync, detected: detected || null,
        stored: node.model || null, configModel: catalog.configModel || '',
        options: catalog.options || [],
      });
    }

    /* 切换模型：写入节点；终端在跑且同步开启时同时给 TUI 发 /model */
    if (req.method === 'POST' && sub === 'nodes' && subId && extra === 'model') {
      const body = await readBody(req);
      const model = String(body.model || '').trim();
      if (!model) return json(res, 400, { error: '模型为空' });
      const fresh = store.load();
      const task = fresh.tasks.find((t) => t.id === id);
      const node = task?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '节点不存在' });
      node.model = model;
      node.modelProvider = body.provider ? String(body.provider) : null;
      // 记住此刻会话文件里的模型：之后它变了，说明是在终端里改的
      node.modelSeen = detectSessionModel(node) || null;
      node.modelAt = new Date().toISOString();
      store.save(fresh);
      const sync = body.sync !== false;
      let applied = 'saved';
      if (sync && termmod.runningTermForNode(node.id)) {
        // pi 的 TUI /model 需要 provider/id；其它工具直接用模型名
        const termModel = node.modelProvider && !model.includes('/')
          ? `${node.modelProvider}/${model}` : model;
        if (termmod.writeToNode(node.id, `/model ${termModel}`)) applied = 'term';
      }
      return json(res, 200, { ok: true, model, provider: node.modelProvider, applied, sync });
    }

    /* 右侧面板：改动（git status / 单文件 diff），只读 */
    if (req.method === 'GET' && sub === 'nodes' && subId && extra === 'changes') {
      const node = db.tasks.find((t) => t.id === id)?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '节点不存在' });
      const cwd = expandPath(node.cwd || '');
      if (!cwd || !fs.existsSync(cwd)) return json(res, 400, { error: '会话工作目录不存在' });
      try {
        const data = inspectChanges(cwd, url.searchParams.get('path') || '');
        return json(res, 200, { cwd, ...data });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    /* 右侧面板：文件树 / 文本预览，只读且限制在会话工作目录内 */
    if (req.method === 'GET' && sub === 'nodes' && subId && extra === 'files') {
      const node = db.tasks.find((t) => t.id === id)?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '节点不存在' });
      const cwd = expandPath(node.cwd || '');
      if (!cwd || !fs.existsSync(cwd)) return json(res, 400, { error: '会话工作目录不存在' });
      const rel = url.searchParams.get('path') || '';
      try {
        if (url.searchParams.get('read') === '1') return json(res, 200, { cwd, ...readFilePreview(cwd, rel) });
        return json(res, 200, { cwd, ...listDir(cwd, rel) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }

    if (req.method === 'GET' && sub === 'nodes' && subId) {
      const node = taskDetail(db, id)?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '卡片不存在' });
      const tool = TOOLS[node.tool];
      const missing = !tool || (!node.file.startsWith('sqlite:') && !fs.existsSync(node.file));
      if (missing) return json(res, 200, { node, messages: [], missing: true });
      try {
        const conv = tool.read(node.file);
        return json(res, 200, {
          node,
          messages: conv.messages.map((m) => ({
            role: m.role,
            text: m.text ? truncate(m.text, 1600) : '',
            tools: (m.tools || []).map((t) => t.name),
            ts: m.ts,
          })),
        });
      } catch (err) {
        return json(res, 500, { error: err.message });
      }
    }

    if (req.method === 'DELETE' && sub === 'nodes' && subId) {
      return json(res, 200, { ok: store.removeNode(db, id, subId) });
    }

    if (req.method === 'POST' && sub === 'handoff') {
      const body = await readBody(req);
      const task = db.tasks.find((t) => t.id === id);
      const node = task?.nodes.find((n) => n.id === body.nodeId);
      if (!node) return json(res, 404, { error: '会话卡片不存在' });
      const from = TOOLS[node.tool];
      const to = TOOLS[body.toTool];
      if (!from || !to) return json(res, 400, { error: '未知工具' });

      try {
        const conv = from.read(node.file);
        const ratio = Number(body.budget || 0.3);
        const maxTokens = Math.floor(Number(body.contextWindow || 200000) * ratio);
        const trimmed = applyBudget(conv.messages, { maxTokens });
        const targetCwd = body.cwd ? expandPath(body.cwd) : (node.cwd || process.cwd());
        const result = to.write({ ...conv, messages: trimmed.messages }, { cwd: targetCwd });
        const newConv = to.read(result.file);
        const newNode = store.addNode(db, id, makeNode(to.name, newConv, {
          parentNodeId: node.id,
          edgeKind: 'handoff',
          trimmedCount: trimmed.droppedCount,
          resumeCommand: result.resumeCommand,
          registration: result.registration || null,
        }));
        return json(res, 200, { node: newNode, resumeCommand: result.resumeCommand, registration: result.registration || null });
      } catch (err) {
        return json(res, 500, { error: `复制失败: ${err.message}` });
      }
    }
    /* worktree 生命周期：列出任务下由 sbridge 创建的 worktree（状态、改动、领先提交） */
    if (req.method === 'GET' && sub === 'worktrees') {
      const task = db.tasks.find((t) => t.id === id);
      if (!task) return json(res, 404, { error: '任务不存在' });
      const seen = new Set();
      const worktrees = [];
      for (const n of task.nodes) {
        const cwd = expandPath(n.cwd || '');
        if (!cwd || seen.has(cwd) || !isSbridgeWorktree(cwd)) continue;
        seen.add(cwd);
        const info = worktreeInfo(cwd);
        if (info) worktrees.push({ nodeId: n.id, title: n.title, tool: n.tool, ...info });
      }
      return json(res, 200, { worktrees });
    }

    /* 把某个会话的 worktree 分支合并回主仓库当前分支 */
    if (req.method === 'POST' && sub === 'worktrees' && subId === 'merge') {
      const body = await readBody(req);
      const task = db.tasks.find((t) => t.id === id);
      const node = task?.nodes.find((n) => n.id === body.nodeId);
      if (!node) return json(res, 404, { error: '会话不存在' });
      const result = mergeWorktree(expandPath(node.cwd || ''));
      if (!result.ok) return json(res, 400, { error: result.error });
      return json(res, 200, result);
    }

    /* 这个会话的 worktree 里的具体改动（文件列表 / 单文件 diff），供右侧面板查看 */
    if (req.method === 'GET' && sub === 'nodes' && subId && extra === 'worktree-changes') {
      const node = db.tasks.find((t) => t.id === id)?.nodes.find((n) => n.id === subId);
      if (!node) return json(res, 404, { error: '会话不存在' });
      const cwd = expandPath(node.cwd || '');
      if (!cwd || !isSbridgeWorktree(cwd)) return json(res, 404, { error: '这个会话没有独立的 sbridge worktree' });
      const info = worktreeInfo(cwd);
      if (!info) return json(res, 404, { error: 'worktree 已不存在或无法读取' });
      try {
        return json(res, 200, inspectChanges(info.path, url.searchParams.get('path') || ''));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
  }

  return json(res, 404, { error: '未知接口' });
}

function findSessionFile(tool, sessionId) {
  if (fs.existsSync(sessionId)) return expandPath(sessionId);
  const hit = tool.list({ limit: 200 }).find((it) => it.id === sessionId || String(it.id).startsWith(sessionId));
  return hit ? hit.file : null;
}

/* ---------- 动态上下文辅助 ---------- */

/** board 任务是否已绑定上下文库；已绑定返回 ctxTaskId */
function requireCtxTask(boardTaskId) {
  return ctxdb.findTaskByBoardId(boardTaskId)?.id || null;
}

/** checkpoint / handoff-smart 共用：不存在则自动绑定 */
function bindOrThrow(db, boardTaskId) {
  const boardTask = db.tasks.find((t) => t.id === boardTaskId);
  if (!boardTask) return { ok: false, status: 404, error: '任务不存在' };
  const cwd = boardTask.nodes.find((n) => n.cwd)?.cwd || null;
  if (!cwd) return { ok: false, status: 400, error: '任务还没有任何会话，无法确定工作目录' };
  const ctxTaskId = ctxdb.ensureTask({ boardTaskId, title: boardTask.title, cwd });
  const ctxTask = ctxdb.getTask(ctxTaskId);
  if (!ctxTask.project_id) {
    ctxdb.openDb().prepare('UPDATE tasks SET project_id = ? WHERE id = ?').run(ctxdb.upsertProject(cwd), ctxTaskId);
  }
  return { ok: true, ctxTaskId, cwd: expandPath(cwd) };
}

/** 把检查点文本写入目标工具原生新会话（handoff-smart 与回退共用）
 *  embed=true 时 agent 直接跑在 sbridge 内嵌终端里（不另开窗口） */
function writeCheckpointSession(to, ctxTaskId, rendered, targetCwd, version, { launch = true, embed = false } = {}) {
  const ack = `已接收上下文检查点 v${version}（${estimateTokens(rendered)} tokens）。我将基于以上认知继续当前任务，需要精确代码时先重新读取对应文件。`;
  const conv = {
    sourceTool: 'sbridge',
    id: 'ckpt',
    cwd: targetCwd,
    messages: [
      { role: 'user', text: rendered, ts: new Date().toISOString(), tools: [] },
      { role: 'assistant', text: ack, ts: new Date().toISOString(), tools: [] },
    ],
  };
  const result = to.write(conv, { cwd: targetCwd });
  ctxdb.insertAgentSession({ taskId: ctxTaskId, tool: to.name, sessionId: result.id, file: result.file, role: 'checkpoint' });

  let launched = false;
  let termId = null;
  if (embed && result.resumeCommand) {
    // 内嵌终端：新 agent 就地在 sbridge 窗口里跑起来。回放注入已停用（见 /term 处注释）：
    // Claude/Codex 的 [H 启动重绘会擦掉注入的回放；pi 自带 --tui-mode regular 历史打印。
    const replay = null;
    const term = termmod.spawnTerm({ tool: to.name, cwd: targetCwd, command: result.resumeCommand, label: `检查点 v${version} · ${to.name}`, replay, nodeId: body.nodeId || null });
    termId = term.id;
  } else if (launch && result.resumeCommand && process.platform === 'win32') {
    try {
      // 统一用适配器返回的恢复命令拉起（codex resume / pi --session / claude --resume）
      spawn(`start "sbridge" powershell -NoExit -Command "${result.resumeCommand}"`, {
        shell: true, cwd: targetCwd, detached: true, stdio: 'ignore',
      }).unref();
      launched = true;
    } catch { /* 拉起失败时用户可手动执行恢复命令 */ }
  }
  return { sessionId: result.id, file: result.file, resumeCommand: result.resumeCommand, registration: result.registration || null, launched, termId, ack };
}

/** 侧边对话的种子文本：从当前会话文件尾部提取最近对话（不调用 LLM，秒级返回）。
 *  只取 user/assistant 正文与工具名，按字数预算从新往旧回填，避免把大工具输出搬进去。 */
function buildSideDigest(node, maxChars = 14000) {
  const chunks = [];
  const parser = PARSERS[node.tool];
  const file = node.file && !String(node.file).startsWith('sqlite:') ? node.file : '';
  if (file && parser) {
    try {
      const st = fs.statSync(file);
      const len = Math.min(st.size, 512 * 1024);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, 'r');
      try { fs.readSync(fd, buf, 0, len, Math.max(0, st.size - len)); } finally { fs.closeSync(fd); }
      let text = buf.toString('utf8');
      if (st.size > len) text = text.slice(text.indexOf('\n') + 1); // 丢掉被截断的首行
      const evts = [];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try { parser(JSON.parse(t), evts); } catch { /* 半行/坏行跳过 */ }
      }
      const recent = evts.filter((e) => e.kind === 'user' || e.kind === 'assistant' || e.kind === 'tool_call').slice(-40);
      let used = 0;
      for (let i = recent.length - 1; i >= 0; i--) {
        const e = recent[i];
        const body = e.kind === 'tool_call'
          ? `（调用工具：${e.toolName || 'tool'}）`
          : `[${e.kind === 'user' ? '用户' : 'AI'}] ${truncate(String(e.text || ''), 1600)}`;
        if (!body.trim()) continue;
        if (used + body.length > maxChars) break;
        used += body.length + 1;
        chunks.unshift(body);
      }
    } catch { /* 读不到就只带标题与目录 */ }
  }
  const head = [
    '【侧边对话】',
    '你现在在一个「侧边对话」里：和主会话并行、互不影响。下面是主会话最近的对话摘录，用来帮你理解任务背景。',
    '摘录可能不完整；需要精确代码或细节时，请重新读取相关文件，不要假设摘录之外的内容。',
    '',
    `主会话：${truncate(node.title || '(无标题)', 80)}`,
    `工具：${TOOL_LABELS[node.tool] || node.tool}`,
    `目录：${node.cwd || '(未知)'}`,
    '',
    '--- 最近对话（从旧到新）---',
  ];
  if (!chunks.length) chunks.push('（这个会话还没有可提取的对话内容，请直接处理我接下来的问题。）');
  chunks.push('--- 摘录结束 ---');
  return { text: [...head, ...chunks].join('\n'), messageChars: chunks.join('\n').length };
}

/** board 任务的全部会话文件（去重），供增量捕获。
 *  接力生成的检查点会话（node.checkpointVersion 存在）与侧边对话的种子会话必须排除，
 *  否则同一段上下文会被再次捕获为事件，造成认知重复累积。 */
function boardSessions(db, boardTaskId) {
  const task = db.tasks.find((t) => t.id === boardTaskId);
  if (!task) return [];
  const seen = new Set();
  return task.nodes
    .filter((n) => {
      if (!n.file || seen.has(n.file)) return false;
      if (n.checkpointVersion || n.edgeKind === 'side') return false;
      seen.add(n.file);
      return true;
    })
    .map((n) => ({ tool: n.tool, file: n.file }));
}

function openBrowser(port = PORT) {
  try {
    const url = `http://127.0.0.1:${port}`;
    const child = process.platform === 'win32'
      ? spawn(`start "" "${url}"`, { shell: true, detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    // 精简系统/无桌面环境可能没有 xdg-open：忽略 ENOENT，不能让未处理的 error 事件杀掉服务
    child.on('error', () => { /* 打不开就让用户手动访问 */ });
    child.unref();
  } catch { /* 打不开就让用户手动访问 */ }
}

function serveStatic(req, res, url) {
  // 诊断台样本：TUI 回放数据（数据目录，不在 web 资产里）
  if (url.pathname === '/diag-sample.txt') {
    const file = path.join(DATA_DIR, 'tui-sample.txt');
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('sample not found'); }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(buf);
    });
    return;
  }
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const name = rel.replace(/^\/+/, '');
  const type = MIME[path.extname(name)] || 'application/octet-stream';

  // exe 模式：页面资源内嵌在可执行文件里
  if (IS_SEA) {
    try {
      const buf = Buffer.from(getAsset(`web/${name}`));
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      return res.end(buf);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
  }

  const file = path.join(WEB_DIR, name);
  if (!file.startsWith(WEB_DIR)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

/** 探测某个端口上是不是已有的 sbridge（避免把别的程序当成本应用） */
function isSbridgeAt(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/tools', timeout: 800 }, (res) => {
      let raw = '';
      res.on('data', (d) => { raw += d; });
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          resolve(Array.isArray(data.tools) && data.tools.some((t) => ['codex', 'pi', 'claude'].includes(t.id)));
        } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch { /* ignore */ } resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** 尝试监听指定端口；EADDRINUSE 时抛错交给上层换端口 */
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { server.removeListener('listening', onListening); reject(err); };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address()?.port || port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

/* ---------- 内嵌终端 WebSocket ---------- */
server.on('upgrade', (req, socket, head) => {
  const m = (req.url || '').match(/^\/ws\/term\/([\w-]+)/);
  if (!m) {
    socket.destroy();
    return;
  }
  try {
    const WebSocket = termmod.getWs();
    const wss = new WebSocket.Server({ noServer: true });
    wss.handleUpgrade(req, socket, head, (ws) => {
      const term = termmod.attachTerm(m[1], ws);
      if (!term) ws.close();
    });
  } catch (err) {
    console.warn(`[终端] WebSocket 接入失败: ${err.message}`);
    socket.destroy();
  }
});

// 只监听本机回环：API 可启动终端/执行命令，暴露到局域网等于把本机交给同网段任何人
function onStarted(port) {
  PORT = port;
  console.log(`SBRIDGE_PORT=${port}`); // 机器可读：Electron 壳据此加载正确端口（冲突时会自动换端口）
  const bootMs = Math.round(process.uptime() * 1000);
  console.log(`sbridge 看板已启动: http://127.0.0.1:${port}（进程启动 ${bootMs}ms）`);
  console.log(`数据目录: ${DATA_DIR}`);
  console.log('关闭此窗口即退出服务');
  server.on('error', (err) => console.error(`[服务错误] ${err.message}`));
  // 已退出的终端记录定期回收（每条最多 200KB 缓冲，长时间运行不回收会只增不减）
  setInterval(() => { try { termmod.pruneTerms(); } catch { /* ignore */ } }, 10 * 60_000).unref?.();
  // 双击便携 exe 启动时自动打开浏览器；桌面版（Electron 壳负责窗口）与开发模式不弹
  if (IS_SEA && !process.env.SBRIDGE_NO_BROWSER) openBrowser(port);
  // 后台任务延后一拍：先让首屏 HTML/JS 请求走完，再做目录监听与协议文件同步
  setTimeout(() => {
    // 后台自动捕获：监听各工具会话目录，文件变化即增量入库
    startAutoCapture({
      getBoardTasks: () => store.load().tasks,
      findCtxTaskId: (boardTaskId) => ctxdb.findTaskByBoardId(boardTaskId)?.id || null,
      capture: (ctxTaskId, sessions) => captureTask(ctxTaskId, { sessions }),
      roots: Object.values(TOOLS).map((t) => t.sessionsRoot?.()).filter(Boolean),
    });
    // 子代理修复协议随软件分发：装了 sbridge 的机器，Codex/Pi 自动获得子代理修复能力（幂等）
    ensureSubagentProtocols();
  }, 200);
}

/** 端口被占时自动往后找（最多 20 个），都满则交给系统分配 */
async function startServer() {
  const wanted = PORT;
  const candidates = [wanted];
  for (let i = 1; i <= 20; i++) candidates.push(wanted + i);
  for (const p of candidates) {
    try {
      onStarted(await listenOn(p));
      return;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') {
        console.error(`[启动失败] 端口 ${p}: ${err.message}`);
        process.exit(1);
      }
      // 端口上已有 sbridge → 便携版复用现有实例；桌面版传 SBRIDGE_NO_REUSE=1，
      // 强制用自己的实例，避免连到别的数据目录。
      if (!process.env.SBRIDGE_NO_REUSE && await isSbridgeAt(p)) {
        PORT = p;
        console.log(`SBRIDGE_REUSE_PORT=${p}`);
        console.log(`端口 ${p} 上已有 sbridge 在运行，直接复用现有实例`);
        if (IS_SEA && !process.env.SBRIDGE_NO_BROWSER) openBrowser(p);
        process.exit(0);
      }
      console.log(`端口 ${p} 被其他程序占用，自动尝试下一个端口…`);
    }
  }
  try {
    onStarted(await listenOn(0));
  } catch (err) {
    console.error(`[启动失败] 无法分配可用端口: ${err.message}`);
    process.exit(1);
  }
}

startServer().catch((err) => {
  console.error(`[启动失败] ${err.message}`);
  process.exit(1);
});
