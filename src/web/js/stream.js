/* sbridge · 工作轨迹渲染：事件 → 工具卡片 / 思维链步骤（纯展示层） */

/* ---------------- 结构化会话视图（Herdr 式富渲染） ---------------- */

const EDIT_RE = /^(edit|write|create|apply_patch|applypatch|str_replace|str_replace_editor|multiedit|notebook_edit|replace)/i;
const CMD_RE = /^(bash|shell|exec|command|powershell|cmd|terminal)/i;
const READ_RE = /^(read|view|cat|grep|glob|ls|list|search|find|head|tail|code_index)/i;

/* 简易行 diff：掐头去尾后中间即变更块（对典型编辑足够直观） */
function lineDiff(oldStr, newStr, maxLines = 14) {
  const a = String(oldStr ?? '').split('\n');
  const b = String(newStr ?? '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const del = a.slice(start, endA + 1);
  const add = b.slice(start, endB + 1);
  const cap = (arr, no0) => arr.length > maxLines
    ? [...arr.slice(0, maxLines).map((t, i) => ({ no: no0 + i, text: t })), { no: '…', text: `（还有 ${arr.length - maxLines} 行）` }]
    : arr.map((t, i) => ({ no: no0 + i, text: t }));
  return { del: cap(del, start + 1), add: cap(add, start + 1), total: del.length + add.length };
}

/* 从补丁文本（codex apply_patch 的 V4A 格式）提取 ± 行 */
function parsePatch(patchText) {
  const del = [], add = [];
  let file = '';
  for (const line of String(patchText).split('\n')) {
    if (line.startsWith('*** Update File:') || line.startsWith('*** Add File:')) file = line.split(':')[1]?.trim() || '';
    else if (line.startsWith('***')) continue;
    else if (line.startsWith('---')) continue;
    else if (line.startsWith('+')) add.push({ no: '', text: line.slice(1) });
    else if (line.startsWith('-')) del.push({ no: '', text: line.slice(1) });
  }
  return { file, del, add };
}

function extractToolInfo(name, args) {
  // 返回 {kind:'edit'|'cmd'|'read'|'other', path, command, del, add}
  let a = args;
  if (typeof a === 'string') {
    if (a.includes('*** Begin Patch')) {
      const p = parsePatch(a);
      return { kind: 'edit', path: p.file, del: p.del, add: p.add };
    }
    try { a = JSON.parse(a); } catch { return { kind: 'other' }; }
  }
  if (!a || typeof a !== 'object') return { kind: 'other' };
  const pathArg = a.path || a.file_path || a.filePath || a.filename || a.target_file || a.notebook_path || '';
  const cmd = Array.isArray(a.command) ? a.command.join(' ') : (typeof a.command === 'string' ? a.command : '');

  if (typeof a.patch === 'string' && a.patch.includes('*** Begin Patch')) {
    const p = parsePatch(a.patch);
    return { kind: 'edit', path: p.file || pathArg, del: p.del, add: p.add };
  }
  if (EDIT_RE.test(name || '')) {
    const oldStr = a.old_string ?? a.oldText ?? a.old_str ?? '';
    const newStr = a.new_string ?? a.newText ?? a.new_str ?? a.content ?? a.file_text ?? '';
    if (oldStr || newStr) {
      const d = lineDiff(oldStr, newStr);
      return { kind: 'edit', path: pathArg, del: d.del, add: d.add, trunc: d.total > 28 };
    }
    return { kind: 'edit', path: pathArg, del: [], add: [] };
  }
  if (CMD_RE.test(name || '') || cmd) return { kind: 'cmd', command: cmd || truncate(String(args), 200) };
  if (READ_RE.test(name || '')) return { kind: 'read', path: pathArg || truncate(String(args), 120), query: a.pattern || a.query || '' };
  return { kind: 'other' };
}

function diffHtml(del, add) {
  const line = (cls, l) => `<div class="dl ${cls}"><span class="no">${l.no || ''}</span><span class="sign">${cls === 'del' ? '-' : '+'}</span><span class="code">${escapeHtml(l.text)}</span></div>`;
  return `<div class="diff">${del.map((l) => line('del', l)).join('')}${add.map((l) => line('add', l)).join('')}</div>`;
}

/* 会话正文是 Markdown 风格文本：先 HTML 转义，再做少量保守的块级格式化。
   不引入第三方渲染器，也不允许原始 HTML 通过。 */
function inlineMessageHtml(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

/* 净化助手正文：剥离 Codex 原文内嵌的内容——
 * 1) [工具调用记录] 整段（这些调用在对话流里已有独立折叠行，正文里是重复展示）
 * 2) :codex-file-citation{...} 行内引用标记（纯元数据，无阅读价值） */
function stripEmbeddedToolTrail(text) {
  let t = String(text ?? '');
  // [工具调用记录] 及其后的整个列表（直到段落结束/EOF）；出现在任意位置都剥
  t = t.replace(/\n?\[工具调用记录\][\s\S]*?(?=\n\n(?!\s*[-*+] )|\n#{1,6}\s|$)/g, '\n');
  // 单独成行的 citation 标记（:codex-file-citation{...} 可跨行，{ 内无 } 则吞到行尾）
  t = t.replace(/^[ \t]*:codex-file-citation\{[^}]*\}[ \t]*$/gm, '');
  t = t.replace(/:codex-file-citation\{[^}]*\}/g, '');
  // 清理剥离后留下的连续空行
  t = t.replace(/\n{3,}/g, '\n\n').trim();
  return t;
}

const mdTableCells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
const mdIsTableSep = (line) => /\|/.test(line) && mdTableCells(line).every((c) => /^:?-{2,}:?$/.test(c));
const unescapeHtmlEntities = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
function mdTableHtml(header, rows) {
  const head = header.map((c) => `<th>${inlineMessageHtml(c)}</th>`).join('');
  const body = rows.map((r) => `<tr>${header.map((_, k) => `<td>${inlineMessageHtml(r[k] || '')}</td>`).join('')}</tr>`).join('');
  return `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
/* 图表块：把已转义的源码还原后交给 mermaid；data-src 留一份，主题切换时重渲染 */
function mdMermaidHtml(escapedSrc) {
  const src = unescapeHtmlEntities(escapedSrc);
  return `<pre class="mermaid" data-src="${escapeHtml(src)}">${escapeHtml(src)}</pre>`;
}

function renderMessageHtml(text, max, opts = {}) {
  const allowMermaid = opts.allowMermaid !== false;
  const lines = escapeHtml(clipText(stripEmbeddedToolTrail(text), max)).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let listTag = '';
  let inCode = false;
  let codeLines = [];
  let mermaidLines = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    out.push(`<p>${inlineMessageHtml(paragraph.join('<br>'))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listTag) return;
    out.push(`</${listTag}>`);
    listTag = '';
  };
  const openList = (tag) => {
    if (listTag === tag) return;
    flushParagraph();
    closeList();
    out.push(`<${tag}>`);
    listTag = tag;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^```/.test(trimmed) && !mermaidLines) {
      const lang = trimmed.slice(3).trim().toLowerCase();
      if (inCode) {
        out.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else if (allowMermaid && lang === 'mermaid') {
        flushParagraph();
        closeList();
        mermaidLines = [];
      } else {
        flushParagraph();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (mermaidLines) {
      if (/^```/.test(trimmed)) {
        out.push(mdMermaidHtml(mermaidLines.join('\n')));
        mermaidLines = null;
      } else {
        mermaidLines.push(line);
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (!trimmed) { flushParagraph(); closeList(); continue; }
    // Markdown 表格：表头 + 分隔行 + 若干行；单元格内容仍走保守的行内格式化
    if (trimmed.startsWith('|') && mdIsTableSep((lines[i + 1] || '').trim())) {
      const header = mdTableCells(trimmed);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|')) { rows.push(mdTableCells(lines[j].trim())); j += 1; }
      flushParagraph();
      closeList();
      out.push(mdTableHtml(header, rows));
      i = j - 1;
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph(); closeList(); out.push('<hr>'); continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph(); closeList();
      const level = Math.min(6, Math.max(3, heading[1].length + 2));
      out.push(`<h${level}>${inlineMessageHtml(heading[2])}</h${level}>`);
      continue;
    }
    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph(); closeList();
      out.push(`<blockquote>${inlineMessageHtml(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*+]\s+(.+)$/);
    if (bullet) {
      openList('ul');
      out.push(`<li>${inlineMessageHtml(bullet[1])}</li>`);
      continue;
    }
    const ordered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (ordered) {
      openList('ol');
      out.push(`<li>${inlineMessageHtml(ordered[1])}</li>`);
      continue;
    }
    closeList();
    paragraph.push(trimmed);
  }
  if (mermaidLines) out.push(`<pre><code>${mermaidLines.join('\n')}</code></pre>`); // 未闭合：退回代码块
  if (inCode && codeLines.length) out.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
  flushParagraph();
  closeList();
  return out.join('');
}

/* ---------- mermaid 图表：按需加载，主题切换时按原始源码重渲染 ---------- */
let mermaidLoading = null;
function mermaidConfig() {
  const css = (name, fb) => getComputedStyle(document.body).getPropertyValue(name).trim() || fb;
  const dark = document.body.classList.contains('theme-dark');
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    fontFamily: getComputedStyle(document.body).fontFamily || 'sans-serif',
    themeVariables: {
      background: css('--panel', dark ? '#191a1d' : '#ffffff'),
      primaryColor: css('--accent-soft', dark ? '#26263a' : '#efedfb'),
      primaryTextColor: css('--text', dark ? '#e8e6e1' : '#1c1b19'),
      primaryBorderColor: css('--line-strong', dark ? '#3a3b40' : '#dcd8cf'),
      lineColor: css('--muted', dark ? '#9a978f' : '#74726b'),
      textColor: css('--text', dark ? '#e8e6e1' : '#1c1b19'),
      secondaryColor: css('--card', dark ? '#1e1f23' : '#ffffff'),
      tertiaryColor: css('--bg', dark ? '#111214' : '#f7f5f1'),
      mainBkg: css('--card', dark ? '#1e1f23' : '#ffffff'),
      nodeBorder: css('--line-strong', dark ? '#3a3b40' : '#dcd8cf'),
      clusterBkg: css('--panel', dark ? '#191a1d' : '#fffefb'),
      clusterBorder: css('--line', dark ? '#2a2b2f' : '#e9e6df'),
      edgeLabelBackground: css('--panel', dark ? '#191a1d' : '#fffefb'),
      // 饼图/图例：用项目已有的语义色，浅深主题都能分得开
      pie1: css('--accent', dark ? '#8b87f0' : '#5b5bd6'),
      pie2: css('--codex', dark ? '#3fb695' : '#0e7a63'),
      pie3: css('--claude', dark ? '#e09a4a' : '#b45309'),
      pie4: css('--pi', dark ? '#a678f2' : '#7c4ddc'),
      pie5: '#2f9e8f',
      pie6: '#d97757',
      pieTitleTextColor: css('--text', dark ? '#e8e6e1' : '#1c1b19'),
      pieSectionTextColor: dark ? '#f5f4f0' : '#ffffff',
      pieLegendTextColor: css('--text', dark ? '#e8e6e1' : '#1c1b19'),
      pieStrokeColor: css('--panel', dark ? '#191a1d' : '#fffefb'),
      pieStrokeWidth: '2px',
      pieOpacity: '0.92',
    },
  };
}
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/mermaid.min.js';
    script.async = true;
    script.onload = () => {
      try { window.mermaid.initialize(mermaidConfig()); } catch { /* ignore */ }
      resolve(window.mermaid);
    };
    script.onerror = () => { mermaidLoading = null; reject(new Error('mermaid 加载失败')); };
    document.head.appendChild(script);
  });
  return mermaidLoading;
}
function renderMermaidIn(root) {
  const nodes = [...root.querySelectorAll('pre.mermaid:not([data-processed])')];
  if (!nodes.length) return;
  ensureMermaid().then((mermaid) => {
    const live = nodes.filter((n) => n.isConnected);
    if (live.length) mermaid.run({ nodes: live }).catch(() => { /* 语法错误不打断会话 */ });
  }).catch(() => { /* 加载失败保留原文 */ });
}
document.addEventListener('sbridge:theme', () => {
  document.querySelectorAll('pre.mermaid[data-processed]').forEach((n) => {
    if (n.dataset.src == null) return;
    n.removeAttribute('data-processed');
    n.textContent = n.dataset.src;
  });
  if (window.mermaid) { try { window.mermaid.initialize(mermaidConfig()); } catch { /* ignore */ } }
  renderMermaidIn(document.body);
});

function renderEvtHtml(evt) {
  if (evt.kind === 'user') {
    return `<div class="sev user"><div class="sev-text">${renderMessageHtml(evt.text, 3000)}</div></div>`;
  }
  if (evt.kind === 'assistant') {
    return `<div class="sev assistant"><div class="sev-text">${renderMessageHtml(evt.text, 4000)}</div></div>`;
  }
  if (evt.kind === 'tool_call') {
    const info = extractToolInfo(evt.toolName, evt.args);
    const head = `<div class="sev-head"><span class="sev-icon">${info.kind === 'edit' ? '✏️' : info.kind === 'cmd' ? '⚡' : info.kind === 'read' ? '📖' : '🔧'}</span><span class="sev-title">${escapeHtml(
      info.kind === 'edit' ? `编辑 ${info.path || '(未知文件)'}`
        : info.kind === 'cmd' ? `运行 ${truncate(info.command || '', 110)}`
        : info.kind === 'read' ? `读取 ${truncate(info.path || info.query || '', 110)}`
        : `${evt.toolName}(${truncate(String(evt.args ?? ''), 110)})`
    )}</span><span class="sev-state" data-call="${escapeHtml(evt.callId || '')}">…</span></div>`;
    const body = info.kind === 'edit' && (info.del?.length || info.add?.length) ? diffHtml(info.del, info.add) : '';
    return `<div class="sev tool ${info.kind}" data-call="${escapeHtml(evt.callId || '')}">${head}${body}</div>`;
  }
  if (evt.kind === 'tool_result') {
    return { outcome: evt }; // 由调用侧合并进对应工具卡片
  }
  return '';
}

/* ---------- 工作轨迹：把 SSE 事件增量整理成 ChainOfThought 风格步骤 ---------- */
const COT_KIND_META = {
  user: { icon: '💬', label: '收到任务' },
  assistant: { icon: '✨', label: '整理回复' },
  edit: { icon: '✏️', label: '编辑文件' },
  cmd: { icon: '⚡', label: '运行命令' },
  read: { icon: '📖', label: '检索 / 读取' },
  other: { icon: '🔧', label: '调用工具' },
};

function cotFirstLine(value, max = 120) {
  return truncate(String(value ?? '').replace(/\s+/g, ' ').trim(), max);
}

function cotNormalizeTs(ts) {
  const d = ts ? new Date(ts) : new Date();
  return Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
}

function cotDuration(ms) {
  const sec = Math.max(0, (ms || 0) / 1000);
  if (sec < 60) return `${sec.toFixed(1)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function cotCountFromOutcome(outcome, isError) {
  const text = String(outcome ?? '');
  const foundFiles = text.match(/Found\s+(\d+)\s+files?/i);
  if (foundFiles) return `${isError ? '失败 · ' : ''}${foundFiles[1]} 个文件`;
  const totalLines = text.match(/Total output lines:\s*(\d+)/i);
  if (totalLines) return `${isError ? '失败 · ' : ''}${totalLines[1]} 行输出`;
  const lines = text.split(/\r?\n/).filter((line) => line.trim()).length;
  if (lines > 1) return `${isError ? '失败 · ' : ''}${lines} 行结果`;
  if (text.trim()) return `${isError ? '失败 · ' : ''}${text.length} 字符`;
  return isError ? '失败' : '完成';
}

function cotSourceMeta(tool) {
  const known = { codex: ['Codex', 'C'], pi: ['Pi', 'π'], claude: ['Claude Code', '✦'] };
  const [label, initial] = known[tool] || [toolLabel(tool), String(toolLabel(tool) || '?').slice(0, 1)];
  return { key: known[tool] ? tool : 'other', label, initial };
}

function createCotTimeline(listEl, options) {
  const { node, isFirstBatch, nearBottom, toBottom, scheduleStreamUi, isTerminalRunning, isHeadlessRunning, headlessElapsed, scrollEl } = options;
  const source = cotSourceMeta(node.tool);
  const uid = `cot-${Math.random().toString(36).slice(2, 9)}`;
  const steps = [];
  const byCall = new Map();
  const copyTexts = new Map(); // step 下标 -> 该复制按钮对应的文本（整段回答 / 用户原文）

  /* 消息下方「复制」：按索引取 step.text 原文（复制 Markdown 原文，不是渲染后的 HTML）。
     listEl 不会重建，事件委托挂一次即可。 */
  listEl.addEventListener('click', async (e) => {
    const branchBtn = e.target.closest('[data-branch]');
    if (branchBtn) {
      if (branchBtn.disabled) return;
      branchBtn.disabled = true;
      const t0 = Date.now();
      const ticker = setInterval(() => {
        toast(`正在创建分支… ${Math.round((Date.now() - t0) / 1000)}s（Claude 可能需 1 分钟）`);
      }, 2000);
      try {
        toast('正在创建分支…（会用当前工具复制这个会话）');
        const r = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/fork`, { method: 'POST' });
        if (r.node) {
          await refreshTask();
          openSessionTab(r.node.id);
          toast('分支已创建，已在新标签打开（原会话不变）');
        } else {
          toast(r.warning || '分支终端已启动，但还没检测到新会话文件');
        }
      } catch (err) {
        toast(`分支失败: ${err.message}`);
      } finally {
        clearInterval(ticker);
        branchBtn.disabled = false;
      }
      return;
    }
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const idx = Number(btn.dataset.copy);
    const text = copyTexts.get(idx) ?? steps[idx]?.text ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    }
    const orig = btn.innerHTML;
    btn.classList.add('copied');
    btn.innerHTML = icon('check', 12);
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = orig;
    }, 1200);
  });
  const openDetails = new Set();
  let connected = false;
  let gone = false;
  let firstTs = null;
  let lastTs = null;
  let emptyMessage = '会话还没有可展示的工作轨迹；在下方输入框发第一条消息吧。';
  let localUserPending = null; // 本地乐观显示的用户消息文本（等 SSE 真事件到达后丢弃重复）
  let titleEl = null;
  let workingEl = null;
  let workingLabelEl = null;
  let workingTimeEl = null;
  /* 超大会话尾部分批加载：更早历史经 /api/session-history 按需回溯 */
  const OLDER_LIMIT = 200;
  const STEPS_CAP = 3000;
  let hasOlder = false;
  let olderBefore = 0;
  let olderLoading = false;

  const activeStep = () => {
    for (let i = steps.length - 1; i >= 0; i--) if (steps[i].status === 'active') return steps[i];
    return null;
  };
  const elapsed = () => (firstTs && lastTs ? Date.parse(lastTs) - Date.parse(firstTs) : 0);
  const touch = (ts) => {
    const value = cotNormalizeTs(ts);
    if (!firstTs) firstTs = value;
    lastTs = value;
  };
  const statusMeta = (status) => ({
    active: ['进行中：', '●', 'is-active'],
    error: ['出错：', '✗', 'is-error'],
    done: ['已完成：', '✓', 'is-done'],
    pending: ['待处理：', '○', 'is-pending'],
  }[status] || ['已完成：', '✓', 'is-done']);

  const workingState = (active) => {
    if (gone) return { cls: 'is-done', label: '会话文件已不存在', time: '' };
    if (active) return { cls: 'is-working', label: '正在工作…', time: cotDuration(Date.now() - Date.parse(active.startTs || firstTs || lastTs || Date.now())) };
    if (!connected) return { cls: 'is-done', label: '连接已断开', time: '' };
    // 无头执行（工作轨迹主路径）：CLI 在后台跑，界面要明确告诉用户「正在执行」，
    // 否则几十秒没有任何新事件，看起来就像消息没发出去。
    if (isHeadlessRunning?.()) {
      const ms = headlessElapsed?.() || 0;
      return { cls: 'is-working', label: 'AI 正在执行…', time: ms ? cotDuration(ms) : '' };
    }
    if (isTerminalRunning?.()) {
      return { cls: 'is-working', label: '监听新消息…', time: lastTs ? `最后活动 ${cotDuration(Date.now() - Date.parse(lastTs))} 前` : '' };
    }
    return { cls: 'is-done', label: '', time: '' };
  };

  /* ChatGPT 风对话流：消息成气泡/正文；连续工具步骤在执行中逐条显示，整段结束后收成一行摘要 */

  // 把 steps 切分成块：连续的 tool 步骤聚成一组（组内有活跃步骤 = 正在执行，保持展开）
  const buildBlocks = () => {
    const blocks = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.phase === 'command') { blocks.push({ type: 'command', step: s }); continue; }
      if (s.phase === 'message') { blocks.push({ type: 'message', step: s }); continue; }
      const block = blocks.length && blocks[blocks.length - 1].type === 'tools'
        ? blocks[blocks.length - 1] : { type: 'tools', items: [] };
      if (!blocks.includes(block)) blocks.push(block);
      block.items.push({ step: s, i });
    }
    return blocks;
  };

  const toolLineHtml = (step, i) => {
    const [srText, statusIcon, statusClass] = statusMeta(step.status);
    const expanded = openDetails.has(i);
    return `<li class="chat-tool ${statusClass}${step.fresh ? ' is-fresh' : ''}" style="--i:${Math.min(i, 30)}" ${step.status === 'active' ? 'aria-current="step"' : ''}>
      <button type="button" class="chat-tool-row" data-step-toggle="${i}" aria-expanded="${expanded}" aria-controls="${uid}-detail-${i}">
        <span class="chat-tool-icon" aria-hidden="true">${escapeHtml(step.icon)}</span>
        <span class="chat-tool-label">${escapeHtml(step.label)}</span>
        ${step.query ? `<span class="chat-tool-query" title="${escapeHtml(step.query)}">${escapeHtml(step.query)}</span>` : ''}
        <span class="chat-tool-status" aria-hidden="true">${statusIcon}</span>
        <span class="cot-chevron" aria-hidden="true">›</span>
      </button>
      <div class="cot-detail" id="${uid}-detail-${i}" data-cot-detail="${i}" ${expanded ? '' : 'hidden'}>
        ${step.bodyHtml || '<div class="cot-detail-label">暂无更多详情</div>'}
      </div>
    </li>`;
  };

  // 一组工具步骤：执行中逐条展开；结束后收成一行摘要（点开看全部明细）
  const toolsBlockHtml = (block) => {
    const items = block.items;
    const running = items.some(({ step }) => step.status === 'active');
    if (running) {
      return `<li class="chat-toolgroup is-running"><ul class="chat-tools">${items.map(({ step, i }) => toolLineHtml(step, i)).join('')}</ul></li>`;
    }
    const errCount = items.filter(({ step }) => step.status === 'error').length;
    const firstRun = items[0]?.step?.startTs;
    const lastEnd = items.map(({ step }) => step.endTs).filter(Boolean).pop();
    const spanMs = firstRun && lastEnd ? Math.max(0, Date.parse(lastEnd) - Date.parse(firstRun)) : 0;
    const label = errCount ? `执行了 ${items.length} 步工具调用（${errCount} 步出错）` : `执行了 ${items.length} 步工具调用`;
    const open = openDetails.has('g' + items[0].i);
    return `<li class="chat-toolgroup is-folded">
      <button type="button" class="chat-toolgroup-row" data-group-toggle="g${items[0].i}" aria-expanded="${open}" aria-controls="${uid}-group-${items[0].i}">
        <span class="chat-toolgroup-icon" aria-hidden="true">🔧</span>
        <span class="chat-toolgroup-label">${escapeHtml(label)}</span>
        ${spanMs > 0 ? `<span class="chat-toolgroup-time">${escapeHtml(cotDuration(spanMs))}</span>` : ''}
        <span class="cot-chevron" aria-hidden="true">›</span>
      </button>
      <div class="chat-toolgroup-detail" id="${uid}-group-${items[0].i}" ${open ? '' : 'hidden'}>
        <ul class="chat-tools">${items.map(({ step, i }) => toolLineHtml(step, i)).join('')}</ul>
      </div>
    </li>`;
  };

  /* ---------- 更早历史回溯（超大会话尾部分批） ---------- */

  const setHistoryTruncated = (evt) => {
    if (!evt || !(evt.skipped > 0)) return;
    hasOlder = true;
    olderBefore = evt.before ?? evt.skipped;
  };

  const prependSteps = (evts) => {
    // 本地先组装再整体前插，避免与 render 交错；结果匹配同时查本批与已登记的 byCall（跨页回填）
    const local = [];
    const localByCall = new Map();
    for (const evt of evts) {
      if (!evt) continue;
      if (evt.kind === 'user' || evt.kind === 'assistant') {
        local.push(messageStep(evt));
      } else if (evt.kind === 'tool_call') {
        const step = toolStep(evt);
        if (step.callId) localByCall.set(step.callId, step);
        local.push(step);
      } else if (evt.kind === 'tool_result') {
        const step = evt.callId ? (localByCall.get(evt.callId) || byCall.get(evt.callId)) : null;
        if (step) {
          step.status = evt.isError ? 'error' : 'done';
          step.count = cotCountFromOutcome(evt.outcome, evt.isError);
          step.endTs = cotNormalizeTs(evt.ts);
          step.bodyHtml += resultDetailHtml(evt);
        } else {
          const summary = cotFirstLine(String(evt.outcome ?? ''), 120) || '(工具结果)';
          local.push({
            phase: 'tool', status: 'done', icon: '→', label: '收到工具结果', query: summary,
            count: cotCountFromOutcome(evt.outcome, evt.isError), startTs: cotNormalizeTs(evt.ts), endTs: cotNormalizeTs(evt.ts),
            sourceDetail: '工具结果', bodyHtml: resultDetailHtml(evt),
          });
        }
      }
    }
    if (!local.length) return;
    for (const s of local) if (s.callId && !byCall.has(s.callId)) byCall.set(s.callId, s);
    const first = local.find((s) => s.startTs);
    if (first && (!firstTs || first.startTs < firstTs)) firstTs = first.startTs;
    // 滚动锚定：前插后视口停在原内容上，不跳动
    const prevHeight = scrollEl.scrollHeight;
    const prevTop = scrollEl.scrollTop;
    steps.unshift(...local);
    render();
    scrollEl.scrollTop = prevTop + (scrollEl.scrollHeight - prevHeight);
  };

  const loadOlder = async () => {
    if (!hasOlder || olderLoading || steps.length >= STEPS_CAP) return;
    olderLoading = true;
    render();
    try {
      const r = await fetch(`/api/session-history?tool=${encodeURIComponent(node.tool)}&file=${encodeURIComponent(node.file)}&before=${olderBefore}&limit=${OLDER_LIMIT}`);
      const data = await r.json();
      if (Array.isArray(data.events) && data.events.length) prependSteps(data.events);
      hasOlder = !!data.hasMore;
      olderBefore = data.before ?? olderBefore;
    } catch { /* 失败保留原状，可重试 */ }
    olderLoading = false;
    render();
  };

  const render = () => {
    const stick = nearBottom();
    if (!steps.length) {
      listEl.innerHTML = `<div class="cot-empty"><strong>还没有对话</strong>${escapeHtml(emptyMessage)}</div>`;
      titleEl = workingEl = workingLabelEl = workingTimeEl = null;
      scheduleStreamUi();
      return;
    }
    const active = activeStep();
    const work = workingState(active);

    /* 复制粒度 = 一整段回答：一个用户消息到下一个用户消息之间的全部助手正文
       （工具调用不参与复制）。只有该段最后一轮助手消息带复制按钮；
       用户消息复制自己的原文。 */
    copyTexts.clear();
    {
      let group = [];
      let lastAssistant = -1;
      const finalize = () => {
        if (lastAssistant >= 0) {
          const merged = group.join('\n\n').trim();
          if (merged) copyTexts.set(lastAssistant, merged);
        }
        lastAssistant = -1;
        group = [];
      };
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i];
        if (s.phase !== 'message') continue; // 工具步骤不算正文
        if (s.kind === 'user') {
          finalize();
          copyTexts.set(i, String(s.text || ''));
        } else {
          group.push(String(s.text || '').trim());
          lastAssistant = i;
        }
      }
      finalize();
    }

    // 消息直出气泡；连续工具步骤聚组：执行中展开、结束后收成一行摘要
    const bodyHtml = buildBlocks().map((block) => {
      if (block.type === 'command') {
        // TUI 命令标记行：斜杠命令不是消息，居中一条小指令签
        const step = block.step;
        return `<div class="chat-cmdrow" title="TUI 指令：在终端里执行（效果见终端视图）">
          <span class="chat-cmdicon">⌘</span><span class="chat-cmdtext">${escapeHtml(step.text || '')}</span>
        </div>`;
      }
      if (block.type === 'message') {
        const step = block.step;
        const isUser = step.kind === 'user';
        const idx = steps.indexOf(step);
        const canCopy = copyTexts.has(idx);
        const canBranch = canCopy && !isUser; // 只在一整段回答的末尾提供「创建分支」
        // 靠左右对齐区分说话人，不需要头像图标；整段回答的末尾才放复制/分支组件
        return `<div class="chat-msg ${isUser ? 'is-user' : 'is-assistant'}">
          <div class="chat-msg-body">
            <div class="chat-bubble">${step.bodyHtml || `<div class="sev-text">${renderMessageHtml(step.text || '', isUser ? 3000 : 6000, { allowMermaid: !isUser })}</div>`}</div>
            ${canCopy ? `<div class="chat-actions">
              <button type="button" class="chat-copy" data-copy="${idx}" title="复制整段内容">${icon('copy', 12)}</button>
              ${canBranch ? `<button type="button" class="chat-copy chat-branch" data-branch="${idx}" title="创建分支：复制当前会话（保留完整历史），原会话不变">${icon('git', 12)}</button>` : ''}
            </div>` : ''}
          </div>
        </div>`;
      }
      return toolsBlockHtml(block);
    }).join('');
    const pendingRow = work.cls === 'is-working' && connected && !active && !gone
      ? `<li class="chat-tool is-pending"><span class="chat-tool-row"><span class="chat-tool-icon" aria-hidden="true">○</span><span class="cot-pending-label">等待下一步…</span></span></li>`
      : '';
    const olderBanner = hasOlder
      ? `<div class="cot-older">${steps.length >= STEPS_CAP
        ? `<span class="cot-older-label">会话过大，仅展示最近部分</span>`
        : `<span class="cot-older-label">已省略更早的 ${olderBefore} 条记录</span><button type="button" class="cot-older-btn" data-older-load ${olderLoading ? 'disabled' : ''}>${olderLoading ? '加载中…' : `${icon('history', 13)} 加载更早`}</button>`}</div>`
      : '';

    listEl.innerHTML = `<div class="chat-stream source-${source.key}">
      ${olderBanner}
      <div class="chat-thread">${bodyHtml}</div>
      <ol class="chat-tools" aria-label="AI 工作步骤" hidden></ol>
      <div class="chat-working ${work.cls}" role="status" aria-live="polite">
        <span class="chat-spark" aria-hidden="true">${work.cls === 'is-done' ? '' : '✦'}</span>
        <span class="chat-working-label">${escapeHtml(work.label)}</span>
        <span class="chat-working-time" aria-hidden="true">${escapeHtml(work.time)}</span>
      </div>
    </div>`;

    renderMermaidIn(listEl);

    // 工具行需要按顺序插在消息之间：上面 bodyHtml 已含工具行，隐藏冗余容器
    titleEl = listEl.querySelector('.chat-working-label');
    workingEl = listEl.querySelector('.chat-working');
    workingLabelEl = listEl.querySelector('.chat-working-label');
    workingTimeEl = listEl.querySelector('.chat-working-time');
    for (const step of steps) step.fresh = false;
    if (stick) toBottom();
    else scheduleStreamUi();
  };

  const closePreviousActive = () => {
    for (const s of steps) {
      if (s.status === 'active') {
        s.status = 'done';
        s.count = s.count === '等待结果' ? '已切换' : s.count;
      }
    }
  };

  const pushStep = (step, evt) => {
    closePreviousActive();
    step.fresh = !isFirstBatch();
    steps.push(step);
    if (step.callId) byCall.set(step.callId, step);
    touch(evt?.ts);
    if (!isFirstBatch()) render();
  };

  const messageStep = (evt) => {
    const isUser = evt.kind === 'user';
    const text = String(evt.text ?? '');
    // 斜杠命令不是聊天消息，是 TUI 指令：单独渲染成命令标记行
    if (isUser && text.startsWith('/')) {
      return {
        phase: 'command',
        kind: 'user',
        icon: '⌘',
        label: 'TUI 命令',
        query: cotFirstLine(text, 120),
        count: '指令',
        startTs: cotNormalizeTs(evt.ts),
        endTs: cotNormalizeTs(evt.ts),
        text,
        bodyHtml: '',
      };
    }
    const meta = COT_KIND_META[isUser ? 'user' : 'assistant'];
    return {
      phase: 'message',
      kind: isUser ? 'user' : 'assistant',
      status: 'done',
      icon: meta.icon,
      label: meta.label,
      query: cotFirstLine(text, 120),
      count: `${text.length} 字`,
      startTs: cotNormalizeTs(evt.ts),
      endTs: cotNormalizeTs(evt.ts),
      text,
      sourceDetail: isUser ? '用户输入' : '助手回复',
      bodyHtml: `<div class="sev-text">${renderMessageHtml(text, isUser ? 3000 : 6000, { allowMermaid: !isUser })}</div>`,
    };
  };

  const toolStep = (evt) => {
    const info = extractToolInfo(evt.toolName, evt.args);
    const meta = COT_KIND_META[info.kind] || COT_KIND_META.other;
    const query = info.command || info.query || info.path || cotFirstLine(String(evt.args ?? ''), 130);
    const label = info.kind === 'other'
      ? `${meta.label} ${evt.toolName || '工具'}`
      : `${meta.label}${info.kind === 'edit' && info.path ? ` · ${truncate(info.path, 56)}` : ''}`;
    const diff = info.kind === 'edit' && (info.del?.length || info.add?.length) ? diffHtml(info.del, info.add) : '';
    const argsText = clipText(String(evt.args ?? ''), 1800);
    return {
      phase: 'tool',
      status: 'active',
      icon: meta.icon,
      label,
      query,
      count: '等待结果',
      startTs: cotNormalizeTs(evt.ts),
      endTs: null,
      callId: evt.callId || null,
      toolName: evt.toolName || null,
      sourceDetail: evt.toolName || meta.label,
      bodyHtml: `<div class="cot-detail-label">调用参数</div><pre class="cot-output">${escapeHtml(argsText || '（无参数）')}</pre>${diff}`,
    };
  };

  const resultDetailHtml = (evt) => {
    const outcome = clipText(String(evt.outcome ?? ''), 2800);
    return `<div class="cot-detail-label" style="margin-top:10px">${evt.isError ? '工具返回错误' : '工具结果'}</div><pre class="cot-output">${escapeHtml(outcome || '（无输出）')}</pre>`;
  };

  const applyResult = (evt) => {
    let step = evt.callId ? byCall.get(evt.callId) : null;
    if (!step) {
      const summary = cotFirstLine(String(evt.outcome ?? ''), 120) || '(工具结果)';
      step = {
        phase: 'tool', status: 'done', icon: '→', label: '收到工具结果', query: summary,
        count: cotCountFromOutcome(evt.outcome, evt.isError), startTs: cotNormalizeTs(evt.ts), endTs: cotNormalizeTs(evt.ts),
        sourceDetail: '工具结果', bodyHtml: resultDetailHtml(evt),
      };
      pushStep(step, evt);
      return;
    }
    step.status = evt.isError ? 'error' : 'done';
    step.count = cotCountFromOutcome(evt.outcome, evt.isError);
    step.endTs = cotNormalizeTs(evt.ts);
    step.bodyHtml += resultDetailHtml(evt);
    step.fresh = !isFirstBatch();
    touch(evt.ts);
    if (!isFirstBatch()) render();
  };

  listEl.addEventListener('click', (e) => {
    const olderBtn = e.target.closest('[data-older-load]');
    if (olderBtn) { loadOlder(); return; }
    const groupRow = e.target.closest('[data-group-toggle]');
    if (groupRow) {
      const key = groupRow.dataset.groupToggle;
      const detail = listEl.querySelector(`[id$="-group-${key.slice(1)}"]`);
      if (!detail) return;
      const willOpen = detail.hidden;
      detail.hidden = !willOpen;
      groupRow.setAttribute('aria-expanded', String(willOpen));
      if (willOpen) openDetails.add(key);
      else openDetails.delete(key);
      scheduleStreamUi();
      return;
    }
    const row = e.target.closest('[data-step-toggle]');
    if (!row) return;
    const i = Number(row.dataset.stepToggle);
    const detail = listEl.querySelector(`[data-cot-detail="${i}"]`);
    if (!detail) return;
    const willOpen = detail.hidden;
    detail.hidden = !willOpen;
    row.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) openDetails.add(i);
    else openDetails.delete(i);
    scheduleStreamUi();
  });

  return {
    /* 本地乐观插入用户消息：无头 CLI 往往要到执行结束才落盘，先显示出来，
       等 SSE 里真正的同文本 user 事件到达时再丢弃重复项 */
    addLocalUser(text) {
      localUserPending = String(text ?? '').trim();
      const ts = new Date().toISOString();
      pushStep(messageStep({ kind: 'user', text, ts, local: true }), { ts });
    },
    handle(evt) {
      if (!evt) return;
      if (evt.type === 'history-truncated') { setHistoryTruncated(evt); return; }
      if (evt.type === 'gone') { gone = true; connected = false; render(); return; }
      // 乐观消息去重：SSE 收到同一句用户消息时，保留本地那条（避免出现两个一模一样的用户气泡）
      if (evt.kind === 'user' && localUserPending != null
        && String(evt.text ?? '').trim() === localUserPending) {
        localUserPending = null;
        return;
      }
      if (evt.kind === 'user' || evt.kind === 'assistant') pushStep(messageStep(evt), evt);
      else if (evt.kind === 'tool_call') pushStep(toolStep(evt), evt);
      else if (evt.kind === 'tool_result') applyResult(evt);
    },
    refresh() { render(); },
    finishBatch() { render(); },
    showEmpty(message) { if (message) emptyMessage = message; render(); },
    setConnected(value) {
      if (connected === value) return;
      connected = value;
      if (!isFirstBatch()) render();
    },
    tick() {
      const active = activeStep();
      if (!workingEl || !workingLabelEl || !workingTimeEl) return;
      if (active) {
        workingEl.className = 'cot-working is-working';
        workingLabelEl.textContent = '正在工作';
        workingTimeEl.textContent = cotDuration(Date.now() - Date.parse(active.startTs));
      } else if (isHeadlessRunning?.()) {
        // 无头执行期间 CLI 不产生增量事件，靠这里持续走秒，给出「还活着」的反馈
        workingEl.className = 'cot-working is-working';
        workingLabelEl.textContent = 'AI 正在执行';
        workingTimeEl.textContent = cotDuration(headlessElapsed?.() || 0);
      } else if (connected && !gone && isTerminalRunning?.() && lastTs) {
        workingEl.className = 'cot-working is-working';
        workingLabelEl.textContent = '监听新步骤';
        workingTimeEl.textContent = `最后活动 ${cotDuration(Date.now() - Date.parse(lastTs))} 前`;
      }
    },
    isEmpty() { return steps.length === 0; },
    destroy() { /* 无定时器需要清理 */ },
  };
}

