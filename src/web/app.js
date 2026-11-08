const api = async (path, options = {}) => {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
};

const $ = (id) => document.getElementById(id);

/* ---------- 用户设置：localStorage 持久化 ---------- */
const SETTINGS_KEY = 'sbridge-settings';
const DEFAULT_SETTINGS = { autoStartTerm: true }; // 打开会话自动启动终端（默认开，设置里可关）
let userSettings = loadUserSettings();
function loadUserSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}
function saveUserSettings(next) {
  userSettings = { ...userSettings, ...next };
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(userSettings)); } catch { /* 隐私模式等 */ }
}
function openSettingsModal() {
  openModal({
    title: '设置',
    bodyHtml: `
      <label class="set-row">
        <span class="set-text"><span class="pick-title">打开会话时自动启动终端</span>
        <span class="pick-sub">焦点面板的会话直接拉起终端进程，不用再点「启动此会话的终端」；关闭后回到手动模式</span></span>
        <span class="switch"><input type="checkbox" id="set-autoterm" ${userSettings.autoStartTerm ? 'checked' : ''}/><i></i></span>
      </label>`,
    submitLabel: '保存',
    onSubmit: () => {
      saveUserSettings({ autoStartTerm: $('set-autoterm').checked });
      toast('设置已保存');
    },
  });
}

/* ---------- 赞助入口：填好链接后侧栏才会出现「♥ 支持」 ---------- */
const SUPPORT_LINKS = {
  afdian: '',   // 爱发电主页，例如 https://afdian.com/a/yourname
  github: '',   // GitHub Sponsors，例如 https://github.com/sponsors/yourname
  note: '',     // 可选：公众号 / 交流群 / 邮箱等一句说明
};

function openSupportModal() {
  const rows = [];
  if (SUPPORT_LINKS.afdian) {
    rows.push(`<a class="support-link" href="${escapeHtml(SUPPORT_LINKS.afdian)}" target="_blank" rel="noopener">${icon('heart', 15)} 爱发电 · 请我喝杯咖啡</a>`);
  }
  if (SUPPORT_LINKS.github) {
    rows.push(`<a class="support-link" href="${escapeHtml(SUPPORT_LINKS.github)}" target="_blank" rel="noopener">${icon('link', 15)} GitHub Sponsors</a>`);
  }
  openModal({
    title: '支持 sbridge',
    submitLabel: '',
    bodyHtml: `
      <p class="support-lead">sbridge 完全免费，所有功能都不加锁。持续维护、跟进 Codex / Pi / Claude 的更新和修 bug 都要花时间，欢迎赞助支持。</p>
      <div class="support-links">${rows.join('')}</div>
      ${SUPPORT_LINKS.note ? `<div class="support-note">${escapeHtml(SUPPORT_LINKS.note)}</div>` : ''}
      <p class="support-sub">赞助不影响任何功能；支持者的名字会记进项目的支持者名单。</p>`,
  });
}

/* ---------- 主题系统：浅色（Solarized Light 风格）/ 深色（原版），右上角切换 ---------- */
const XTERM_THEMES = {
  light: {
    background: '#fdf6e3',
    foreground: '#586e75',
    cursor: '#657b83',
    cursorAccent: '#fdf6e3',
    selectionBackground: '#eee8d5',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900',
    blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#839496',
    brightBlue: '#6c71c4', brightMagenta: '#d33682', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    scrollbarSliderBackground: 'rgba(147, 161, 161, 0.45)',
    scrollbarSliderHoverBackground: 'rgba(101, 123, 131, 0.6)',
    scrollbarSliderActiveBackground: 'rgba(88, 110, 117, 0.75)',
  },
  dark: {
    background: '#0d120f',
    foreground: '#d7e4da',
    cursor: '#8fb89a',
    cursorAccent: '#0d120f',
    selectionBackground: '#2c3a31',
    black: '#1a201c', red: '#e07a6a', green: '#7ec98f', yellow: '#d9b96c',
    blue: '#7aa7d8', magenta: '#d18fc0', cyan: '#7ec4b5', white: '#c9d6cc',
    brightBlack: '#4d5a52', brightRed: '#f0958a', brightGreen: '#9adba6', brightYellow: '#ead695',
    brightBlue: '#9cc0ea', brightMagenta: '#e5aed3', brightCyan: '#a3ded2', brightWhite: '#eef5ef',
    scrollbarSliderBackground: 'rgba(151, 181, 162, 0.58)',
    scrollbarSliderHoverBackground: 'rgba(190, 218, 199, 0.84)',
    scrollbarSliderActiveBackground: 'rgba(210, 232, 217, 0.92)',
  },
};

const theme = {
  current: localStorage.getItem('sbridge-theme') || 'light',
  liveTerms: new Set(), // mountTerm 注册进来，切换时热换肤
  xtermTheme() { return XTERM_THEMES[this.current] || XTERM_THEMES.light; },
  apply() {
    document.body.classList.toggle('theme-dark', this.current === 'dark');
    const btn = $('btn-theme');
    if (btn) btn.innerHTML = this.current === 'dark' ? icon('sun') : icon('moon');
    for (const t of this.liveTerms) {
      try { t.options.theme = this.xtermTheme(); } catch { /* ignore */ }
    }
  },
  toggle() {
    this.current = this.current === 'dark' ? 'light' : 'dark';
    localStorage.setItem('sbridge-theme', this.current);
    this.apply();
  },
};

let state = { projects: [], tasks: [] };
let currentTask = null;
let currentTaskId = null;

const fmtTime = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const truncate = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
};
// 会话正文保留原段落与换行，只做长度上限；truncate 用于单行标题/摘要
const clipText = (s, max) => {
  const t = String(s ?? '');
  return t.length <= max ? t : t.slice(0, max - 1) + '…';
};
const toolLabel = (t) => state.tools?.find((x) => x.id === t)?.label || (t === 'codex' ? 'Codex' : t === 'pi' ? 'Pi' : t);
const DEFAULT_TOOLS = [{ id: 'codex', label: 'Codex' }, { id: 'pi', label: 'Pi' }];
const toolButtonsHtml = (activeId, exceptId = null) => (state.tools?.length ? state.tools : DEFAULT_TOOLS)
  .filter((t) => t.id !== exceptId)
  .map((t) => `<button data-tool="${t.id}" class="${t.id === activeId ? 'active' : ''}">${escapeHtml(t.label)}</button>`)
  .join('');
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

window.addEventListener('error', (e) => toast(`前端错误: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => toast(`前端错误: ${e.reason?.message || e.reason}`));

/* ---------------- 内联 SVG 图标（Lucide 风格线性图标，替代字符图标） ---------------- */
const ICONS = {
  timeline: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',                                   // 工作轨迹：脉冲时间线
  terminal: '<path d="M4 17l6-5-6-5"/><path d="M12 19h8"/>',                        // 终端
  context: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5"/>',      // 上下文：同心圆
  handoff: '<path d="M4 12h13"/><path d="M12 6l6 6-6 6"/>',                         // 接力：传递箭头
  stop: '<rect x="6" y="6" width="12" height="12" rx="2.5"/>',                      // 停止
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>', // 白板：三栏
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',   // 分屏：对半
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  play: '<path d="M7 5.5v13l11-6.5z"/>',                                            // 启动
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.4"/><path d="M3.5 3.5v4.9h4.9"/><path d="M12 7.5V12l3 2.5"/>', // 历史
  down: '<path d="M12 5v13M6.5 12.5 12 18l5.5-5.5"/>',                              // 回到底部
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
  moon: '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.8 6.8 0 0 0 9.7 9.7z"/>',
  check: '<path d="M4.5 12.5l5 5L20 7"/>',                                          // 标记完成
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13.5h9l1-13.5"/>',                 // 删除
  link: '<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2.8-2.8a4.5 4.5 0 0 0-6.4-6.4L11.9 5.7"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2.8 2.8a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4"/>', // 接入
  chat: '<path d="M21 12a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1L3 21l1.6-4.4A8.5 8.5 0 1 1 21 12z"/>', // 新开会话
  radar: '<path d="M19.07 4.93a10 10 0 1 0 .43 10.24"/><path d="M16.24 7.76a6 6 0 1 0 .36 6.14"/><circle cx="12" cy="12" r="1.6"/>', // 自动获取扫描
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>', // 设置
  heart: '<path d="M19.5 12.6 12 20l-7.5-7.4a5 5 0 0 1 7.5-6.6 5 5 0 0 1 7.5 6.6z"/>', // 支持/赞助
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
/** 生成内联 SVG 图标（currentColor 随按钮着色） */
function icon(name, size = 14) {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/* ---------------- 内嵌终端 ---------------- */
async function refreshTerms() {
  try { state.terms = (await api('/api/terms')).terms; } catch { /* 服务未起时忽略 */ }
}

/* 终端状态变化后立刻同步「顶部标签页 + 侧栏会话链 + 白板」的绿点：
   之前只有 8s 定时刷新 renderBoard（顺带 mini-chain），标签页要等下一次显式 renderTabs
   才更新——所以会出现「左边有绿点、上面标签没有」的短暂不同步。 */
function refreshTermIndicators() {
  return refreshTerms().then(() => {
    try { renderTabs(); } catch { /* 任务未就绪 */ }
    try { renderBoard(); } catch { /* ignore */ }
  }).catch(() => {});
}

/* 该节点「自己」的运行中终端：节点级绑定（nodeTermBindings / node.termId）+ 服务端记录的
   term.nodeId 归属。禁止用 cwd+tool 回退——同一目录同工具的多个会话（例如 huabu 下 4 个
   Claude 会话）会全部挂到同一个 PTY，切到终端后四个面板显示同一份内容。 */
function nodeTermFor(node) {
  const terms = state.terms || [];
  const tid = nodeTermBindings.get(node.id) || node.termId || null;
  if (tid) {
    const bound = terms.find((t) => t.running && t.id === tid);
    if (bound) return bound;
  }
  return terms.find((t) => t.running && t.nodeId === node.id) || null;
} 
function boundRunningTerm(node) { return nodeTermFor(node); }

/* 把原始终端挂进指定容器（面板「⌨」切换用；agent 进程挂在服务上，关页面不中断） */
async function mountTerm(hostEl, node, retries = 0, hooks = {}) {
  if (typeof Terminal === 'undefined' || typeof FitAddon === 'undefined') throw new Error('终端组件加载失败');
  // 只认「本节点自己的」终端；找不到就为它单独 spawn 一个（绝不按 cwd+tool 复用别人的）
  let term = nodeTermFor(node);
  const fromAttach = !!term; // 挂载已存在的终端（区别于本函数内新 spawn）
  if (!term) {
    const r = await api(`/api/tasks/${currentTask.id}/term`, {
      method: 'POST',
      body: { tool: node.tool, cwd: node.cwd || undefined, resumeCommand: node.resumeCommand || undefined, file: node.file || undefined, label: toolLabel(node.tool), nodeId: node.id },
    });
    await refreshTerms();
    term = { id: r.termId, replayed: !!r.replayed }; // 服务端已注入历史回放
  }
  // 登记绑定：本节点 spawn 的终端归本节点；已被其他节点绑定的终端只作展示、不抢
  //（分屏同目录场景，防止 reintroduce 串台）
  let owner = null;
  for (const [nid, tid] of nodeTermBindings) if (tid === term.id) owner = nid;
  if (!owner) nodeTermBindings.set(node.id, term.id);
  window.__sbLastMount = { id: term.id, node: node.id, at: Date.now() }; // 调试口
  hostEl.innerHTML = '';
  const t = new Terminal({
    // 终端字体对齐 Windows Terminal（默认 Cascadia Mono 16px，该处再降 1 档缓解偏大）
    // 15px + lineHeight 1.2 + DOM 渲染（ClearType 风格 subpixel，canvas 灰度 AA 会发虚）
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "Microsoft YaHei UI", monospace',
    fontSize: 15,
    lineHeight: 1.2,
    fontWeight: 'normal',
    fontWeightBold: 'bold',
    letterSpacing: 0,
    cursorBlink: true,
    scrollback: 5000,
    theme: theme.xtermTheme(),
  });
  const fit = new FitAddon.FitAddon();
  t.loadAddon(fit);
  /* 渲染器：改用 xterm 默认 DOM（不再加载 canvas addon）。
     实测在 155% DPI 下 canvas 是灰度抗锯齿，Cascadia 笔画发虚、观感「奇怪」；
     DOM 走浏览器 subpixel（ClearType 风格）渲染，字形清晰度对齐 Windows Terminal。
     色块边缘在 xterm 6 DOM 下按单元格铺满，实测 Claude TUI 深色块右缘整齐。 */
  t.open(hostEl);
  theme.liveTerms.add(t); // 主题切换时热换肤
  window.__sbTerms = window.__sbTerms || new Set();
  window.__sbTerms.add(t); // 调试口：诊断 buffer 状态
  window.__sbLastMountTerm = t; // 调试口：最近挂载的实例
  // 仅 Pi 拦截 alternate buffer：pi regular 模式逐行打印，历史要留在 normal buffer
  // 供滚轮回看（滑块/trimBlank 逻辑也都建立在 normal buffer 上）。
  // Claude/Codex 的全屏 TUI 用 \x1b[H 绝对定位从缓冲区顶部重绘——拦截 alt-screen 会让
  // 它们的实况画进 normal buffer 顶部，视口却停在底部的回放+垫行上，用户看到的就是
  // 「只有历史回放+大片空白、实况不知去向」。放回原生 alt-screen：实况直接可见，
  // 历史走工作轨迹。（实测 Claude 卡信任框/恢复选择等确认框也是这个原因看不见）
  const blockAltScreen = (params) => Array.isArray(params)
    && params.some((v) => v === 47 || v === 1047 || v === 1049);
  const altScreenHandlers = [];
  if (node.tool === 'pi') {
    try {
      altScreenHandlers.push(t.parser.registerCsiHandler({ prefix: '?', final: 'h' }, blockAltScreen));
      altScreenHandlers.push(t.parser.registerCsiHandler({ prefix: '?', final: 'l' }, blockAltScreen));
    } catch { /* 版本不支持时至少保持原有行为 */ }
  }
  // 注入回放的会话：agent 启动时的首次全屏清屏（CSI 2J/3J）只擦可视区，回放已在
  // 回滚区里安然无恙。抓住这「第一次清屏」把视口跳到回放顶部——用户打开终端直接
  // 看到本会话历史，而不是底部一片空白垫行。仅此一次，之后的清屏不再动视口。
  if (term.replayed) {
    try {
      // 回放未收缩（还在 400 行高屏可视区）时，吞掉所有 2J/3J 清屏——否则 agent 启动的
      // 清屏会把仍留在可视区的回放整体抹掉（旧方案靠回放末尾垫 120 行盲文空白顶出去，
      // 但垫行被 trimBlank 计为内容永远不裁，堆出「历史下面一大段空白」，已废弃垫行）。
      // 收缩完成后回放已落回滚区，首个清屏放行并跳到顶部，之后的清屏不再动视口。
      let clearJumped = false;
      altScreenHandlers.push(t.parser.registerCsiHandler({ final: 'J' }, (params) => {
        const p0 = Array.isArray(params) ? params[0] : params;
        if (p0 !== 2 && p0 !== 3) return false; // 0J 只擦光标下方，无碍
        if (!replayShrunk) return true; // 吞掉：回放还在可视区
        if (!clearJumped) {
          clearJumped = true;
          setTimeout(() => {
            try { t.scrollToLine(0); scheduleScrollUi(); } catch { /* ignore */ }
            needRebottom = true; // 跳顶只是让你瞥一眼历史：下一帧实况到达立刻回底部
          }, 80);
        }
        return false;
      }));
    } catch { /* ignore */ }
  }
  try { fit.fit(); } catch { /* 容器未就绪 */ }
  // 高屏回放：大窗口里 TUI 回放内容一屏装得下 → buffer 永不溢出 → 没有可滚动历史。
  // 挂载时先临时把行数扩到 400（Pi/Codex 长会话重绘可轻松超过 150 行），回放完成后
  // （数据流停止 300ms）收缩回真实高度，被挤出的行全部变成真正的 scrollback。
  // 服务端已注入历史回放的会话不走这套：回放本身就是历史，且高屏 resize 会引发
  // ConPTY 按 400 行重绘、在回放与实际输出之间塞进数百行空白（实测），反而把回放
  // 从 trimBlank 的「保留最新 N 行」窗口里挤出去。
  // 历史回放注入已停用（见 server.mjs /term 注释），400 行高屏相位不再有意义：
  // 实测 pi 在 400 行视口下会按 400 行重绘、满屏输出清行序列，终端看起来就是一片空白，
  // 缩回真实行数后才正常绘制。现在所有工具都直接用容器真实行数挂载（由 sendResize/refit 负责）。
  let replayShrunk = true;
  const viewEl = hostEl.closest('.term-view');
  /* 自动贴底：新输出默认跟随滚到最下面（Claude/Codex 的改动与确认框都出现在最新一行）。
     用户主动往上翻时暂停跟随，滚回底部或点「最新」后恢复。 */
  let followBottom = true;
  const isAtBottom = () => {
    try {
      const b = t.buffer.active;
      return (b.viewportY || 0) >= (b.baseY || 0);
    } catch { return true; }
  };
  const syncFollow = () => { followBottom = isAtBottom(); };
  /* 终端启动提示：pi/codex 启动阶段只发清行序列，屏幕看起来空白十几秒。
     buffer 出现第一行非空内容即隐藏；不要用「收到数据」判定——清行也是数据。 */
  const loadingEl = viewEl?.querySelector('[data-role="termloading"]');
  let loadingTimer = 0;
  if (loadingEl) {
    loadingEl.hidden = false;
    const checkTermContent = () => {
      try {
        const b = t.buffer.active;
        const total = Math.min(b.length, (b.baseY || 0) + t.rows);
        for (let i = 0; i < total; i++) {
          if ((b.getLine(i)?.translateToString(true) || '').trim()) {
            loadingEl.hidden = true;
            clearInterval(loadingTimer);
            return;
          }
        }
      } catch { /* 终端尚未就绪 */ }
    };
    loadingTimer = setInterval(checkTermContent, 500);
  }
  const bottomBtn = viewEl?.querySelector('[data-role="termbottom"]');
  const historyBtn = viewEl?.querySelector('[data-role="termhistory"]');
  let scrollUiFrame = 0;
  let sliderDragging = false; // 滑块拖动接管中：syncScrollUi 暂停写 --sb-slider-top，由拖动逻辑直接控制
  // TUI（pi/codex）重绘会把 buffer 收缩回一屏，baseY 归 0，但历史输出确实发生过。
  // 判定用「粘性」：一旦出现过回滚内容就保持 has-scrollback，直到终端销毁。
  let stickyHasScrollback = false;
  const evalScrollback = () => {
    try {
      if (!stickyHasScrollback) stickyHasScrollback = (t.buffer.active.baseY || 0) > 0;
    } catch { /* 终端尚未就绪 */ }
    return stickyHasScrollback;
  };
  const syncScrollUi = () => {
    scrollUiFrame = 0;
    try {
      const buffer = t.buffer.active;
      const hasScrollback = evalScrollback();
      const atBottom = (buffer.viewportY || 0) >= (buffer.baseY || 0);
      viewEl?.classList.toggle('has-scrollback', hasScrollback);
      if (bottomBtn) bottomBtn.hidden = !hasScrollback || atBottom;
      // resume 出来的新终端没有本地回滚（TUI 只重绘最后一屏）：
      // 此时提示用户去工作轨迹看本会话的历史内容
      if (historyBtn) historyBtn.hidden = hasScrollback;
      // 滑块高度与位置：xterm 6 在 scrollback 裁剪后不重算 slider 内联 height/top
      //（停在 0px/旧值），只接管 height 会出现「滑块沉底只露头」。这里一并接管：
      // 高度 = rows/(baseY+rows) × 轨道；位置 = viewportY/(baseY+rows) × 轨道。
      const trackH = viewEl?.querySelector('.xterm-scrollable-element')?.clientHeight
        || viewEl?.clientHeight || 0;
      const total = (buffer.baseY || 0) + t.rows;
      if (trackH > 0 && total > 0) {
        const hPx = Math.max(28, Math.round(trackH * Math.min(1, t.rows / total)));
        const maxTop = trackH - hPx;
        const topPx = Math.round(Math.min(maxTop, Math.max(0,
          (buffer.viewportY || 0) / Math.max(1, total - t.rows) * maxTop)));
        viewEl.style.setProperty('--sb-slider-h', `${hPx}px`);
        // 拖动期间滑块位置由 startSliderDrag 直接控制（同一公式反算，避免两边拉扯）
        if (!sliderDragging) viewEl.style.setProperty('--sb-slider-top', `${topPx}px`);
      }
    } catch { /* 终端尚未就绪 */ }
  };
  const scheduleScrollUi = () => {
    if (scrollUiFrame) return;
    scrollUiFrame = requestAnimationFrame(syncScrollUi);
  };
  // 滚轮只回滚 xterm 自己的历史缓冲：不让空 viewport 吞事件，也不让 xterm
  // 在无本地回滚时把 wheel 转成 ↑/↓ 发回 PTY（表现为输入框翻命令历史）。
  const wheelHandler = (e) => {
    if (!viewEl || e.ctrlKey || e.metaKey || !e.deltaY) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('.sess-input')) return; // 页面输入框保持原有滚轮行为
    e.preventDefault();
    e.stopImmediatePropagation();
    let lines = e.deltaMode === 1 ? Math.abs(e.deltaY)
      : e.deltaMode === 2 ? t.rows
        : Math.abs(e.deltaY) / 40;
    lines = Math.max(1, Math.min(10, Math.round(lines)));
    t.scrollLines(e.deltaY > 0 ? lines : -lines);
    syncFollow();
    scheduleScrollUi();
  };
  viewEl?.addEventListener('wheel', wheelHandler, { capture: true, passive: false });
  /* 滑块拖动接管：我们用 CSS 变量强制接管了 slider 的 height/top，但 xterm 6 内部
     拖动逻辑按它自己的（未重算的）slider 尺寸换算指针位置，两边互相拉扯导致拖动
     不跟手。这里在 capture 阶段拦下 mousedown（先于 xterm 在目标元素上的监听），
     用与 syncScrollUi 完全相同的公式把指针位置反算成 viewportY：
       topPx/maxTop = viewportY/(total-rows)
     拖动期间由本逻辑直接写 --sb-slider-top，松手后交还 syncScrollUi。 */
  const startSliderDrag = (ev) => {
    // 只劫持「滚动条区域」的点击。判定不能用 closest('.xterm-scrollable-element')——
    // xterm 6 的终端正文（.xterm-screen）和键盘捕获层都在它内部，那样会把点正文
    // 的 mousedown 也拦掉，xterm 拿不到焦点，终端就没法直接输入（↑翻历史、/命令）。
    // 几何测量仍用 scrollable element（.scrollbar.vertical 是 xterm 内部高度，会失真）。
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target?.closest('.xterm-scrollable-element > .scrollbar.vertical')) return;
    const scrollable = target.closest('.xterm-scrollable-element');
    const slider = scrollable?.querySelector(':scope > .scrollbar.vertical > .slider');
    if (!scrollable || !slider || !viewEl?.classList.contains('has-scrollback')) return;
    ev.preventDefault();
    ev.stopPropagation(); // capture 阶段拦下，xterm 内部拖动逻辑不再收到事件
    sliderDragging = true;
    slider.classList.add('active');
    const sliderRect = slider.getBoundingClientRect();
    const onSlider = ev.target === slider;
    // 点在滑块上保持抓取点相对位置；点在轨道空白处则让滑块中心跳到点击处
    const grabOffset = onSlider ? ev.clientY - sliderRect.top : sliderRect.height / 2;
    const onMove = (mv) => {
      try {
        const buffer = t.buffer.active;
        const trackRect = scrollable.getBoundingClientRect();
        const hPx = slider.getBoundingClientRect().height;
        const maxTop = Math.max(0, scrollable.clientHeight - hPx);
        const total = (buffer.baseY || 0) + t.rows;
        const scrollableRows = Math.max(1, total - t.rows);
        const topPx = Math.min(maxTop, Math.max(0, mv.clientY - trackRect.top - grabOffset));
        viewEl.style.setProperty('--sb-slider-top', `${Math.round(topPx)}px`);
        const target = Math.round((maxTop ? topPx / maxTop : 1) * scrollableRows);
        t.scrollToLine(Math.min(buffer.baseY || 0, Math.max(0, target)));
        syncFollow();
      } catch { /* ignore */ }
    };
    if (!onSlider) onMove(ev); // 轨道点击立即跳转
    const onUp = () => {
      sliderDragging = false;
      slider.classList.remove('active');
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      scheduleScrollUi(); // 松手后按实际 viewportY 校准一次
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  };
  viewEl?.addEventListener('mousedown', startSliderDrag, true);
  const scrollListener = t.onScroll(scheduleScrollUi);
  // 历史回放/重绘时同步滚动条状态，避免 has-scrollback 晚一拍。
  const renderListener = typeof t.onRender === 'function' ? t.onRender(scheduleScrollUi) : null;
  const writeParsedListener = typeof t.onWriteParsed === 'function' ? t.onWriteParsed(scheduleScrollUi) : null;
  // 兜底轮询：resume 回放后 buffer.baseY 的最终值可能晚于最后一次 onRender/onWriteParsed，
  // 事件全部触发完 has-scrollback 仍是旧值。每 600ms 核对一次。这里直接走 syncScrollUi：
  // 滑块 CSS 变量同样依赖 baseY/viewportY，trimBlank 裁剪后 xterm 不发任何事件，
  // 只靠事件驱动的滑块尺寸会停在挂载时的陈旧值（实测假 28px 滑块）。
  let followCursor = false; // 内嵌面板打开期间置位：轮询跟随光标（TUI 重绘位置=光标处）
  const scrollToCursor = () => {
    try {
      const b = t.buffer.active;
      t.scrollToLine(Math.max(0, b.cursorY - Math.floor(t.rows / 2)));
      scheduleScrollUi();
    } catch { /* ignore */ }
  };
  const pollScrollUi = setInterval(() => {
    syncScrollUi();
    if (followCursor) scrollToCursor();
    // 对话框特征 15s 未再出现 = 交互结束，通知切回工作轨迹
    if (dialogReported && Date.now() - lastDialogAt > 15000) {
      dialogReported = false;
      try { hooks.onTuiDialog?.(false); } catch { /* ignore */ }
    }
  }, 600);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/term/${term.id}`);
  let gotTermData = false; // onclose 时区分「连上但没收到任何数据」（终端记录失效）与正常断开
  let termDisposed = false;
  let needRebottom = false; // 回放首清屏跳顶后置位：下一帧实况数据到达就回底部（否则视口钉死在历史区，实况全在视野外）
  let lastDialogAt = 0; // TUI 对话框特征（确认/选择框）最后出现时间，驱动工作轨迹⇄终端自动切换
  let dialogReported = false;
  const sendResize = () => {
    try {
      // 容器隐藏（默认工作轨迹视图）时 fit 拿到 0 尺寸，resize 会把 buffer 清成空壳——
      // 跳过，等视图显示时 refit 再补偿
      if (viewEl?.hidden || !hostEl.clientHeight) return;
      fit.fit();
      if (ws.readyState === 1) ws.send(JSON.stringify({ resize: { cols: t.cols, rows: t.rows } }));
      if (followBottom) { try { t.scrollToBottom(); } catch { /* ignore */ } }
      scheduleScrollUi();
    } catch { /* 布局未就绪 */ }
  };
  ws.onopen = sendResize;
  // 同步采样：回放期间 buffer 可能瞬时超过一屏（baseY>0），但 scheduleScrollUi 的 rAF
  // 去抖会把整段回放合并成一帧，等帧执行时 TUI 已重绘收缩、baseY 归 0 —— 峰值躲过采样。
  // 所以在 write 之前直接同步判定一次（sticky 只会单向置 true，开销可忽略）。
  let shrinkTimer = 0;
  let replayDone = false; // 服务端回放结束标记（REPLAY_DONE）
  // 空白清理：Pi 的 TUI 用绝对定位跳行重绘（无论回放还是正常运行），buffer 里会
  // 持续积累「跳行空白」。方案：周期性把 scrollback 动态调小到「非空内容行数 + 余量」，
  // xterm 监听该选项变化，从 buffer 头部丢掉最老的行——横幅和空白段一起被裁。
  // 开销：每 5 秒全 buffer 扫一遍字符串（≤5100 行），可忽略。
  // 裁剪后 buffer 骤减，但 xterm 内部 slider 高度要等下一次滚动/尺寸事件才重算——
  // 实测 slider 的内联 height 会停在 '0px'（CSS min-height 顶了个假滑块）。
  // scrollLines(±1) 在视口已在底部时会被抵消，无法触发重算；
  // 有效方法：同尺寸 resize 重入（xterm resize 会重算 scrollDimensions 并同步 slider）。
  const refreshScrollbar = () => {
    try {
      t.resize(t.cols, t.rows);
      t.scrollLines(1);
      t.scrollLines(-1);
      if (followBottom) t.scrollToBottom();
    } catch { /* ignore */ }
  };
  const trimBlank = () => {
    try {
      if (viewEl?.hidden || !hostEl.clientHeight) return; // 隐藏时不裁剪（尺寸语义不对，会误伤）
      const buf = t.buffer.active;
      const sbRows = buf.baseY || 0;
      // 只统计「回滚区」的非空行——可视区行不受 scrollback 影响，不该撑大 keep。
      // 之前用全 buffer 内容计数，可视区 40+ 行内容把 keep 撑到与 baseY 相同，
      // 裁剪等于没裁（这正是修了几轮都没效果的最后一个坑）。
      let sbContent = 0;
      let replayHeaderY = -1; // 历史回放头行位置（注入回放的会话需要保护）
      for (let y = 0; y < sbRows; y++) {
        const s = buf.getLine(y)?.translateToString(true) || '';
        if (s.trim()) sbContent++;
        if (replayHeaderY === -1 && s.includes('📜 本会话历史回放')) replayHeaderY = y;
      }
      let keep = Math.max(10, Math.min(sbContent + 8, 2000));
      // 注入回放的会话：回放头行之上的空白随便裁，回放本体到视口之间不许动。
      // 否则 TUI 重绘/ConPTY 重绘产生的空白行（在回放之后写入）会把回放挤出
      // 「最新 sbContent+8 行」窗口，历史被裁没（实测采样抓到 sbOpt=92 那一刀）。
      if (replayHeaderY >= 0) keep = Math.max(keep, Math.min(sbRows - replayHeaderY + 8, 2000));
      // 只在空白「压倒性占多数」时才裁（空白 > 2× 非空行）。这个清理是为 Pi 全屏
      // TUI 的跳行空白洪水设计的——那种场景空白占 90%+。regular 行式模式的会话
      // 历史里天然有 ~1/3 空白行（对话格式），按「keep=非空+8」的比例裁剪会把
      // 最老的历史一刀刀吃掉：实测 resume 回放 2259 行（非空 848）在 20 秒内被
      // 裁到 344 行，用户发一条消息（触发重绘+下一轮裁剪）滚动条比例就跳变一次。
      const blankRows = sbRows - sbContent;
      if (sbRows > 20 && blankRows > Math.max(15, sbContent * 2)) {
        t.options.scrollback = keep;
        setTimeout(() => {
          try {
            t.options.scrollback = 5000;
            // scrollback 恢复 5000 后 buffer 尺寸语义又变了，此刻再同步才有效
            setTimeout(refreshScrollbar, 50);
          } catch { /* ignore */ }
        }, 150);
      } else if (sbRows > 5) {
        refreshScrollbar(); // 没裁也同步一次：滑块比例可能因早期收缩而失真
      }
    } catch { /* ignore */ }
  };
  const shrinkNow = () => {
    replayShrunk = true;
    if (viewEl?.hidden || !hostEl.clientHeight) return;
    try {
      trimBlank(); // 回放结束：先裁掉启动横幅/大段空白
      refreshScrollbar();
      setTimeout(() => { trimBlank(); refreshScrollbar(); }, 2500);
    } catch { /* ignore */ }
    scheduleScrollUi();
  };
  const blankTrimTimer = setInterval(trimBlank, 5000); // 常驻：运行期空白持续清理
  /* 大回放分块写入：一条 WS 消息可能带 120k 回放 + 200k PTY 缓冲，一次性 t.write
     会让 xterm 同步解析整段、主线程卡住。按 64k 分块、块间让出事件循环；所有写入
     （分块/哨兵收缩/后续 live 数据）串在同一条 promise 链上，保证严格按到达顺序落盘。 */
  const WRITE_CHUNK = 64000;
  let writeChain = Promise.resolve();
  window.__sbW = window.__sbW || [];
  const wlog = (m, data) => {
    const a = window.__sbW;
    if (a.length > 120) a.length = 0;
    a.push({ m, t: Date.now() % 100000, h: typeof data === 'string' ? data.slice(0, 60).replace(/\x1b/g, '\\e') : undefined });
  };
  const writeBig = (data) => {
    wlog('write ' + data.length, data);
    const job = writeChain.then(() => new Promise((done) => {
      if (data.length <= WRITE_CHUNK) { t.write(data, done); return; }
      let i = 0;
      const step = () => {
        if (i >= data.length) { done(); return; }
        t.write(data.slice(i, i + WRITE_CHUNK));
        i += WRITE_CHUNK;
        setTimeout(step, 0);
      };
      step();
    }));
    job.catch((err) => wlog('CHAIN-ERR ' + (err && err.stack || err)));
    // 链上失败不能毒化后续写入：catch 后返回 resolved，保证新数据还能继续写
    writeChain = job.catch(() => {});
    return job;
  };
  const queueShrink = () => {
    // 收缩必须等「分块全部发出并解析完」之后：未发出的块还不在 xterm 解析队列里，
    // 直接 t.write('', shrinkNow) 只会排在已发出写入之后，剩余块会被 resize 丢弃。
    // 关键：xterm 的 write 回调必须显式 resolve 我们的 Promise——这里曾把 shrinkNow
    // 直接当回调，done 永远不调用 → writeChain 永久 pending，REPLAY_DONE 之后
    // 所有实况数据都不再写入（终端一片空白的真正根因）。
    wlog('shrink-queue');
    writeChain = writeChain.then(() => new Promise((done) => {
      try {
        t.write('', () => { try { shrinkNow(); } catch { /* ignore */ } done(); });
      } catch { done(); }
    })).catch(() => {});
  };
  ws.onmessage = (e) => {
    gotTermData = true;
    // TUI 对话框特征：claude/codex 的确认框/选择框都带这类页脚。出现即上报（自动切终端视图）
    if (typeof e.data === 'string' && /Enter to confirm|Esc to cancel/i.test(e.data)) {
      lastDialogAt = Date.now();
      if (!dialogReported) {
        dialogReported = true;
        try { hooks.onTuiDialog?.(true); } catch { /* 回调异常不影响终端 */ }
      }
    }
    // 回放结束哨兵：服务端 buffer 回放完才发。Pi 启动横幅分段输出之间常有
    // >300ms 停顿，仅靠静默计时会误判「回放提前结束」，在回放中途就收缩小屏，
    // 导致剩余回放全部覆写在可视区内、挤不出 scrollback（首次启动无滚动条的根因）。
    if (typeof e.data === 'string' && e.data.includes('\u0000REPLAY_DONE\u0000')) {
      replayDone = true;
      clearTimeout(shrinkTimer);
      queueShrink();
      return;
    }
    evalScrollback();
    if (needRebottom) {
      needRebottom = false;
      try { t.scrollToBottom(); } catch { /* ignore */ }
    }
    writeBig(e.data).then(() => {
      // 必须在写入解析完成后滚，否则滚到的还是旧底部（新行还没进 buffer）
      if (followBottom) {
        try { t.scrollToBottom(); } catch { /* ignore */ }
      }
    });
    scheduleScrollUi();
    // 回放未结束时不收缩：数据流静默 1.2s 且已收到结束标记才缩（正常路径由哨兵触发，
    // 此计时仅作哨兵丢失的兜底）；回放结束后交给 PTY 正常节奏。
    if (!replayDone && !replayShrunk) {
      clearTimeout(shrinkTimer);
      shrinkTimer = setTimeout(queueShrink, 1200);
    }
  };
  t.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  /* 静默空白修复：ws 关闭且从未收到任何数据 = 挂到了已失效的终端记录
     （服务端重启/记录被清，服务端 attachTerm 查不到直接 close）。不处理的话
     终端永远空白、无任何提示。自动清绑定重拉一次（带 retries 防循环）。 */
  ws.onclose = () => {
    if (termDisposed || gotTermData || !hostEl.isConnected) return;
    if (retries >= 1) {
      toast('终端连接失效，请点「启动此会话的终端」手动重试');
      return;
    }
    console.warn('[终端] 连接关闭且未收到数据，自动重新拉起', term.id);
    toast('终端连接已失效，正在重新拉起…');
    nodeTermBindings.delete(node.id);
    if (node.termId === term.id) node.termId = null;
    // 关键：把失效记录从本地 state 剔除并刷新服务端列表，否则重挂的 nodeTermFor
    // 会再次匹配到同一条死记录（实测第二次挂载仍然零字节、终端依旧空白）
    state.terms = (state.terms || []).filter((x) => x.id !== term.id);
    refreshTerms().catch(() => {});
    setTimeout(() => {
      if (termDisposed || !hostEl.isConnected) return;
      mountTerm(hostEl, node, retries + 1, hooks).then((h) => {
        if (h && !termDisposed) Object.assign(handle, h); // 嫁接新句柄：面板 close() 仍能正确释放新实例
      }).catch(() => {});
    }, 400);
  };
  /* 输入法候选框定位修正：系统 IME 的候选框锚定在键盘捕获层（helper textarea）上，
     xterm 把它放在「真实终端光标」处——但 pi 的 regular TUI 空闲时把真实光标放在
     状态行（右下角），视觉输入行（画出来的 ┃ 假光标）在它上面几行，候选框于是
     出现在状态行上。关键时序：IME 在第一个拼音键的 keydown 时就定位候选框，
     compositionstart 才挪已经晚了（实测仍跳右下角），所以 focus/keydown 时就挪，
     compositionupdate 期间保持，compositionend/blur 还原为 xterm 的值。 */
  const imeTa = t.textarea;
  let imeSaved = null;
  if (imeTa) {
    const imeCellH = () => {
      const r = imeTa.closest('.xterm').getBoundingClientRect();
      return r.height / t.rows;
    };
    const imeReposition = () => {
      try {
        const b = t.buffer.active;
        if (b.cursorY < t.rows - 1) return; // 光标本来就是输入位（shell 等），跟随即可
        const cellH = imeCellH();
        if (!(cellH > 0)) return;
        if (!imeSaved) imeSaved = { left: imeTa.style.left, top: imeTa.style.top };
        imeTa.style.left = '0px';
        imeTa.style.top = `${Math.max(0, Math.round((t.rows - 4) * cellH))}px`;
      } catch { /* ignore */ }
    };
    const imeRestore = () => {
      if (!imeSaved) return;
      try {
        imeTa.style.left = imeSaved.left;
        imeTa.style.top = imeSaved.top;
      } catch { /* ignore */ }
      imeSaved = null;
    };
    imeTa.addEventListener('focus', imeReposition);
    imeTa.addEventListener('keydown', imeReposition);
    imeTa.addEventListener('compositionstart', imeReposition);
    imeTa.addEventListener('compositionupdate', imeReposition);
    imeTa.addEventListener('compositionend', imeRestore);
    imeTa.addEventListener('blur', imeRestore);
  }
  // Shift+PgUp / Shift+PgDn 翻页回看（普通 PgUp/PgDn 仍交给终端程序）
  t.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown' || !ev.shiftKey) return true;
    if (ev.key === 'PageUp') { t.scrollPages(-1); syncFollow(); return false; }
    if (ev.key === 'PageDown') { t.scrollPages(1); syncFollow(); return false; }
    return true;
  });
  setTimeout(sendResize, 80);
  window.addEventListener('resize', sendResize);
  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sendResize);
  resizeObserver?.observe(hostEl);
  scheduleScrollUi();
  // 命名句柄：onclose 自动重拉后用 Object.assign 把新实例的方法嫁接进来，
  // 面板持有的旧 rawTerm 仍能正确 dispose 最新实例
  const handle = {
    // 视图切换/窗口变化后必须把「新尺寸」同步给 PTY：只 fit 本地 canvas 会让
    // 终端里的 TUI 仍按旧列数绘制，宽屏右侧留出一条空白（Claude/Codex 的历史
    // 行不会重排，只有新的 resize 才会让它们按新宽度重画）。
    refit() { sendResize(); },
    setFollowCursor(v) { followCursor = v; },
    scrollToBottom() { followBottom = true; try { t.scrollToBottom(); scheduleScrollUi(); } catch { /* ignore */ } },
    dispose() {
      termDisposed = true;
      theme.liveTerms.delete(t);
      resizeObserver?.disconnect();
      viewEl?.removeEventListener('wheel', wheelHandler, true);
      viewEl?.removeEventListener('mousedown', startSliderDrag, true);
      window.removeEventListener('resize', sendResize);
      clearInterval(pollScrollUi);
      clearInterval(blankTrimTimer);
      clearInterval(loadingTimer);
      clearTimeout(shrinkTimer);
      if (scrollUiFrame) cancelAnimationFrame(scrollUiFrame);
      for (const h of altScreenHandlers) { try { h.dispose(); } catch { /* ignore */ } }
      try { scrollListener?.dispose(); } catch { /* ignore */ }
      try { renderListener?.dispose(); } catch { /* ignore */ }
      try { writeParsedListener?.dispose(); } catch { /* ignore */ }
      try { ws.close(); } catch { /* ignore */ }
      try { t.dispose(); } catch { /* ignore */ }
      hostEl.innerHTML = '';
      viewEl?.classList.remove('has-scrollback');
      if (bottomBtn) bottomBtn.hidden = true;
      if (historyBtn) historyBtn.hidden = true;
    },
  };
  return handle;
}

/* ---------------- 会话标签页管理（主战场 / 支持左右分屏） ---------------- */
let openTabs = [];        // 已打开会话的 nodeId（有序）
let activeTabId = null;   // 当前焦点槽位的 nodeId
let paneHandles = new Map(); // nodeId -> pane handle
let boardMode = false;    // 主区显示完整白板
let boardSel = new Set(); // 白板框选中的会话 id（仅白板视图内生效）
let layout = { mode: 'single', slots: [null, null], focused: 0 };

function findNode(nodeId) { return currentTask?.nodes.find((n) => n.id === nodeId) || null; }

function validTabIds() { return openTabs.filter((id) => findNode(id)); }
function visiblePaneIds() {
  return layout.mode === 'split' ? layout.slots.filter(Boolean) : [layout.slots[0]].filter(Boolean);
}
function syncActiveTabId() {
  const ids = visiblePaneIds();
  activeTabId = layout.slots[layout.focused] || ids[ids.length - 1] || null;
}
function normalizeLayout() {
  const valid = new Set(validTabIds());
  layout.slots = layout.slots.map((id) => (valid.has(id) ? id : null));
  if (layout.mode === 'split') {
    if (!layout.slots[0] || !layout.slots[1]) {
      const rest = [...valid].filter((id) => !layout.slots.includes(id));
      if (!layout.slots[0]) layout.slots[0] = rest.shift() || null;
      if (!layout.slots[1]) layout.slots[1] = rest.shift() || null;
    }
    if (!layout.slots[0] || !layout.slots[1] || layout.slots[0] === layout.slots[1]) {
      layout.mode = 'single';
      layout.slots[1] = null;
      layout.focused = 0;
    }
  } else {
    if (!layout.slots[0]) layout.slots[0] = [...valid][0] || null;
    layout.slots[1] = null;
    layout.focused = 0;
  }
  syncActiveTabId();
}

function openSessionTab(nodeId, { activate = true, slot = null, split = false } = {}) {
  if (!findNode(nodeId)) return;
  if (!openTabs.includes(nodeId)) openTabs.push(nodeId);
  boardMode = false;
  if (split) layout.mode = 'split';
  if (layout.mode === 'split') {
    const target = slot === 0 || slot === 1 ? slot : layout.focused;
    if (!layout.slots[0]) {
      layout.slots[0] = activeTabId && activeTabId !== nodeId && findNode(activeTabId)
        ? activeTabId
        : openTabs.find((id) => id !== nodeId && findNode(id)) || null;
    }
    const existing = layout.slots.indexOf(nodeId);
    if (existing !== -1 && existing !== target) {
      layout.focused = existing; // 同一会话不重复占两个槽位
    } else {
      layout.slots[target] = nodeId;
      layout.focused = target;
    }
    if (layout.slots[0] === layout.slots[1]) {
      layout.slots[1] = openTabs.find((id) => id !== layout.slots[0] && findNode(id)) || null;
      layout.focused = 0;
    }
  } else {
    layout.slots[0] = nodeId;
    layout.slots[1] = null;
    layout.focused = 0;
  }
  normalizeLayout();
  renderTabs();
  renderPanes();
}

function closeTab(nodeId) {
  const h = paneHandles.get(nodeId);
  if (h) { try { h.close(); } catch { /* ignore */ } paneHandles.delete(nodeId); }
  openTabs = openTabs.filter((id) => id !== nodeId);
  if (layout.mode === 'split') {
    const closedSlot = layout.slots.indexOf(nodeId);
    if (closedSlot !== -1) layout.slots[closedSlot] = null;
    const rest = openTabs.filter((id) => findNode(id) && !layout.slots.includes(id));
    for (let i = 0; i < 2; i++) {
      if (!layout.slots[i] && rest.length) layout.slots[i] = rest.shift();
    }
    if (!layout.slots[0] || !layout.slots[1] || layout.slots[0] === layout.slots[1]) {
      layout.mode = 'single';
      layout.slots[1] = null;
      if (!layout.slots[0]) layout.slots[0] = rest[0] || openTabs[openTabs.length - 1] || null;
      layout.focused = 0;
    } else if (layout.focused === closedSlot) {
      layout.focused = closedSlot === 0 ? 1 : 0;
    }
  } else {
    layout.slots[0] = openTabs[openTabs.length - 1] || null;
    layout.slots[1] = null;
    layout.focused = 0;
  }
  normalizeLayout();
  renderTabs();
  renderPanes();
}

function toggleBoardView(force) {
  boardMode = force !== undefined ? force : !boardMode;
  if (!boardMode) { boardSel.clear(); closeBoardMenu(); }
  renderTabs();
  renderPanes();
  if (boardMode) renderBoard();
}

function renderTabs() {
  const el = $('sess-tabs');
  const visible = visiblePaneIds();
  el.innerHTML = openTabs.map((id) => {
    const n = findNode(id);
    if (!n) return '';
    const run = nodeTermFor(n);
    return `<div class="stab ${visible.includes(id) && !boardMode ? 'active' : ''} ${id === activeTabId && !boardMode ? 'focused' : ''}" data-tab="${id}" title="${escapeHtml(n.title || '')}">
      <span class="chip ${n.tool}">${toolLabel(n.tool)}</span>
      <span class="stab-title">${escapeHtml(truncate(n.title || '(会话)', 22))}</span>
      ${run ? '<span class="run-dot"></span>' : ''}
      <span class="stab-x" data-close="${id}" title="关闭标签">×</span>
    </div>`;
  }).join('') || '<div class="tabs-empty">没有打开的会话</div>';
  updateSplitControls();
  // 侧栏高亮跟顶部标签同源（activeTabId/slots）——挂在这里保证打开/关闭/切换标签时
  // 左侧会话链立刻跟上。此前只在全量 render() 里刷新，点卡片切换时侧栏高亮慢几拍。
  renderMiniChain();
}

function renderPanes() {
  const area = $('pane-area');
  normalizeLayout();
  // 清理已关闭标签的面板句柄
  for (const [id, h] of [...paneHandles]) {
    if (!openTabs.includes(id)) {
      try { h.close(); } catch { /* ignore */ }
      paneHandles.delete(id);
    }
  }
  // closeTab() 会先删句柄再调用这里；必须按 openTabs 清理全部孤儿宿主，
  // 否则残留的 .pane-host 仍可见，但按钮监听已经失效。
  area.querySelectorAll('.pane-host').forEach((host) => {
    if (!openTabs.includes(host.dataset.paneHost)) host.remove();
  });
  $('board-wrap').hidden = !boardMode;
  const boardHint = $('board-hint');
  if (boardHint) boardHint.hidden = !boardMode;
  area.classList.toggle('hidden', boardMode);
  area.classList.toggle('split', layout.mode === 'split' && !boardMode);
  if (boardMode) return;

  const visible = visiblePaneIds();
  // 确保每个打开的 tab 都有常驻面板（后台 SSE 持续积累，切走不中断）
  for (const id of openTabs) {
    const node = findNode(id);
    if (!node) continue;
    let host = area.querySelector(`[data-pane-host="${id}"]`);
    if (host && !paneHandles.has(id)) host.remove(); // 有 DOM 没句柄的空壳，重建
    if (!host || !paneHandles.has(id)) {
      host = document.createElement('div');
      host.dataset.paneHost = id;
      host.className = 'pane-host';
      area.appendChild(host);
      paneHandles.set(id, createSessionPane(host, node, { active: true }));
    }
    host.hidden = !visible.includes(id);
    host.classList.toggle('focused', id === activeTabId && !boardMode);
  }
  // flex 顺序必须跟 slots 一致；openTabs 的创建顺序不能决定左右位置。
  const ordered = [...visible, ...openTabs.filter((id) => !visible.includes(id))];
  for (const id of ordered) {
    const host = area.querySelector(`[data-pane-host="${id}"]`);
    if (host) area.appendChild(host);
  }
  for (const id of visible) setTimeout(() => paneHandles.get(id)?.refit(), 60);
  area.querySelector('#ws-empty')?.remove();
  if (!openTabs.length && !area.querySelector('.workspace-empty')) {
    area.insertAdjacentHTML('beforeend', `<div class="workspace-empty" id="ws-empty"><div class="empty-icon">⌨</div><h2>选择或新建一个会话</h2><p>点侧栏「会话链」里的卡片，或「新开会话 / 接入已有会话」。</p></div>`);
  } else {
    area.querySelector('#ws-empty')?.remove();
  }
}

function updateFocusClasses() {
  document.querySelectorAll('.pane-host').forEach((host) => {
    host.classList.toggle('focused', host.dataset.paneHost === activeTabId && !boardMode);
  });
}

function setFocusedPane(nodeId) {
  const slot = layout.slots.indexOf(nodeId);
  if (slot === -1) return;
  if (layout.mode === 'single' && slot !== 0) return;
  layout.focused = slot;
  syncActiveTabId();
  renderTabs(); // 侧栏高亮由 renderTabs 内部的 renderMiniChain 同步刷新
  updateFocusClasses();
}

function openInOtherSlot(nodeId) {
  if (!findNode(nodeId)) return;
  if (!currentTask || currentTask.nodes.length < 2) {
    toast('当前任务至少要有两个会话才能分屏');
    return;
  }
  const existing = layout.slots.indexOf(nodeId);
  if (existing !== -1) {
    setFocusedPane(nodeId);
    return;
  }
  const target = layout.focused === 0 ? 1 : 0;
  layout.mode = 'split';
  if (!layout.slots[0]) layout.slots[0] = activeTabId || openTabs.find((id) => id !== nodeId) || null;
  openSessionTab(nodeId, { slot: target, split: true });
}

function toggleSplit(force) {
  const enable = force !== undefined ? force : layout.mode !== 'split';
  if (!enable) {
    layout.mode = 'single';
    layout.slots[1] = null;
    layout.focused = 0;
    normalizeLayout();
    renderTabs();
    renderPanes();
    return;
  }
  if (!currentTask || currentTask.nodes.length < 2) {
    toast('当前任务至少要有两个会话才能分屏');
    return;
  }
  const fallback = currentTask.nodes[currentTask.nodes.length - 1];
  const leftNode = findNode(layout.slots[0] || activeTabId || openTabs[0]) || fallback;
  const candidates = currentTask.nodes.filter((n) => n.id !== leftNode.id);
  const rightNode = candidates.find((n) => n.tool !== leftNode.tool) || candidates[0];
  if (!rightNode) {
    toast('没有可放到另一侧的会话');
    return;
  }
  layout.mode = 'split';
  layout.slots[0] = leftNode.id;
  layout.slots[1] = null;
  layout.focused = 0;
  if (!openTabs.includes(leftNode.id)) openTabs.push(leftNode.id);
  openSessionTab(rightNode.id, { slot: 1, split: true });
}

function updateSplitControls() {
  const btn = $('btn-split');
  const wrap = $('split-right-wrap');
  const select = $('split-right');
  if (!btn || !wrap || !select) return;
  const isSplit = layout.mode === 'split' && !!currentTask;
  btn.classList.toggle('active', isSplit);
  btn.setAttribute('aria-pressed', String(isSplit));
  btn.innerHTML = isSplit ? (icon('split') + ' 退出分屏') : (icon('split') + ' 分屏');
  wrap.hidden = !isSplit || boardMode;
  if (!isSplit || !currentTask) return;
  const left = layout.slots[0];
  const options = currentTask.nodes.filter((n) => n.id !== left);
  select.innerHTML = options.map((n) => `<option value="${escapeHtml(n.id)}">${escapeHtml(`${toolLabel(n.tool)} · ${truncate(n.title || '(会话)', 24)}`)}</option>`).join('');
  select.value = layout.slots[1] || '';
}

/* 侧栏迷你会话链（白板收敛到侧栏的形态）
 * 排序与白板视觉一致：先按行（y），再按列（x）——白板上一行的节点在链里连续 */
function renderMiniChain() {
  const el = $('mini-chain');
  if (!currentTask || !currentTask.nodes.length) {
    el.innerHTML = '<div class="empty-tree">选择任务后显示接力链</div>';
    return;
  }
  const visible = visiblePaneIds();
  const { positions } = computeLayout(currentTask.nodes);
  const items = [...currentTask.nodes].sort((a, b) => {
    const pa = positions.get(a.id) || { x: 0, y: 0 };
    const pb = positions.get(b.id) || { x: 0, y: 0 };
    return pa.y - pb.y || pa.x - pb.x || String(a.createdAt).localeCompare(String(b.createdAt));
  });
  el.innerHTML = items.map((n) => {
    const depth = Math.round((positions.get(n.id)?.x || 0) / 318);
    const run = nodeTermFor(n);
    return `<div class="mini-card ${visible.includes(n.id) && !boardMode ? 'active' : ''} ${n.id === activeTabId && !boardMode ? 'focused' : ''}" data-mnode="${n.id}" style="margin-left:${Math.min(depth, 6) * 14}px" title="${escapeHtml(n.title || '')}">
      <span class="chip ${n.tool}">${toolLabel(n.tool)}</span>
      <span class="mini-title">${escapeHtml(truncate(n.title || '(会话)', 16))}</span>
      ${run ? '<span class="run-dot"></span>' : ''}
    </div>`;
  }).join('');
  el.querySelectorAll('[data-mnode]').forEach((c) => c.addEventListener('click', (e) => {
    if (e.shiftKey) openInOtherSlot(c.dataset.mnode);
    else openSessionTab(c.dataset.mnode);
  }));
}

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

function renderMessageHtml(text, max) {
  const lines = escapeHtml(clipText(stripEmbeddedToolTrail(text), max)).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let listTag = '';
  let inCode = false;
  let codeLines = [];
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

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      if (inCode) {
        out.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (!trimmed) { flushParagraph(); closeList(); continue; }
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
  if (inCode && codeLines.length) out.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
  flushParagraph();
  closeList();
  return out.join('');
}

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
        // 靠左右对齐区分说话人，不需要头像图标
        return `<div class="chat-msg ${isUser ? 'is-user' : 'is-assistant'}">
          <div class="chat-bubble">${step.bodyHtml || `<div class="sev-text">${renderMessageHtml(step.text || '', isUser ? 3000 : 6000)}</div>`}</div>
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
      bodyHtml: `<div class="sev-text">${renderMessageHtml(text, isUser ? 3000 : 6000)}</div>`,
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

/* 一个会话面板：默认终端（主视图）+ 工作轨迹（⌁ 切换查看）+ 输入 + 工具条 */
/* 子代理修复记录弹窗：展示 .sbridge-fix 的 prompt/日志，并一键打开/接入子代理会话 */
function openSubagentModal(parentNode, data) {
  const fix = data.fix || {};
  const sessions = data.sessions || [];
  const logTxt = (fix.logs || []).map((l) => `${l.name}（${Math.round(l.size / 1024)}KB）`).join(' · ');
  const bodyHtml = `
    <div class="sub-fix-meta">
      ${fix.worker ? `worker：${escapeHtml(toolLabel(fix.worker))} · ` : ''}
      ${fix.startedAt ? `开始：${escapeHtml(fmtTime(fix.startedAt))} · ` : ''}
      日志：${escapeHtml(logTxt || '无')}
    </div>
    ${fix.prompt ? `<pre class="sub-prompt">${escapeHtml(fix.prompt)}</pre>` : '<div class="sub-fix-meta">未读取到 prompt.md</div>'}
    <div class="sub-fix-meta" style="margin-top:12px">修复窗口内的子代理会话（点击打开；未接入的会自动挂到当前会话下面）：</div>
    ${sessions.length ? sessions.map((s, i) => `
      <button type="button" class="sub-session" data-i="${i}">
        <span class="chip ${s.tool}">${escapeHtml(toolLabel(s.tool))}</span>
        <span class="t">${escapeHtml(truncate(s.title || '(子代理会话)', 70))}</span>
        <span class="sub-time">${escapeHtml(fmtTime(s.updatedAt))}</span>
        ${s.imported ? '<span class="sub-tag">已在看板</span>' : '<span class="sub-tag">接入</span>'}
      </button>`).join('') : '<div class="sub-fix-meta">没有识别到本次修复窗口内的新会话（可能还没开始，或 worker 会话未落盘）</div>'}`;
  const close = openModal({ title: '子代理修复记录', bodyHtml, submitLabel: '' });
  $('modal-body').querySelectorAll('.sub-session').forEach((btn) => {
    btn.onclick = async () => {
      const s = sessions[Number(btn.dataset.i)];
      if (!s) return;
      close();
      if (s.nodeId) { openSessionTab(s.nodeId); return; }
      try {
        const n = await api(`/api/tasks/${currentTask.id}/nodes`, {
          method: 'POST',
          body: { tool: s.tool, file: s.file, parentNodeId: parentNode.id },
        });
        currentTask.nodes.push(n);
        renderMiniChain();
        renderBoard();
        openSessionTab(n.id);
        toast('子代理会话已接入当前接力链');
      } catch (err) { toast(err.message); }
    };
  });
}

function createSessionPane(host, node, { active = true, caption } = {}) {
  const lastTs = { v: null };
  host.innerHTML = `
    <div class="session-pane ${active ? 'active' : 'idle'}">
      <div class="pane-head">
        <span class="chip ${node.tool}">${toolLabel(node.tool)}</span>
        <span class="pane-caption" title="${escapeHtml(node.title || '')}">${escapeHtml(caption || node.title || '(会话)')}</span>
        <span class="pane-status" data-role="status"></span>
        <span class="pane-tools">
          <button type="button" class="pbtn" data-pact="stream" aria-pressed="false" title="查看 AI 工作轨迹（步骤、查询、结果与来源）">${icon('timeline')} 工作轨迹</button>
          <button type="button" class="pbtn ctx-btn" data-pact="ctx" title="会话上下文用量"><svg class="ctx-ring" viewBox="0 0 20 20" aria-hidden="true"><circle class="ctx-ring-track" cx="10" cy="10" r="8"/><circle class="ctx-ring-val" cx="10" cy="10" r="8"/></svg><span class="ctx-ring-text" data-role="ctxtext">–</span></button>
          <button type="button" class="pbtn" data-pact="handoff" title="智能接力到其他工具">${icon('handoff')} 接力</button>
          <button type="button" class="pbtn danger" data-pact="stopterm" title="停止该会话的终端进程（相当于在终端里输入退出命令）" hidden>${icon('stop')} 停止</button>
          <button type="button" class="pbtn danger" data-pact="close" title="关闭标签" aria-label="关闭标签">${icon('x', 13)}</button>
        </span>
      </div>
      <div class="fork-alert" data-role="forkalert" hidden></div>
      <div class="subagent-bar" data-role="subagentbar" hidden></div>
      <div class="term-view" data-role="termview">
        <button type="button" class="tui-overlay-close" data-role="tuioverlayclose" hidden title="收起终端面板，返回工作轨迹">收起 ✕</button>
        <div class="term-mount" data-role="termmount"></div>
        <div class="term-loading" data-role="termloading" hidden>终端正在启动…</div>
        <button type="button" class="term-start" data-role="termstart" hidden>${icon('play')} 启动此会话的终端</button>
        <button type="button" class="term-history" data-role="termhistory" hidden title="这个终端是刚恢复的新进程，之前的内容在工作轨迹里">${icon('history')} 本会话历史在工作轨迹里 →</button>
        <button type="button" class="term-bottom" data-role="termbottom" title="滚到最新输出" hidden>${icon('down')} 最新</button>
      </div>
      <div class="sev-scroll" data-role="streamscroll" hidden><div class="sev-list" data-role="list"></div></div>
      <button type="button" class="stream-bottom" data-role="streambottom" title="滚到最新工作轨迹" hidden>${icon('down')} 回到最新</button>
      <div class="sess-input">
        <textarea rows="1" placeholder="输入发给 ${toolLabel(node.tool)}…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button class="btn-primary">发送</button>
      </div>
    </div>`;

  host.addEventListener('click', () => setFocusedPane(node.id), true);
  const listEl = host.querySelector('[data-role="list"]');
  const scrollEl = host.querySelector('[data-role="streamscroll"]');
  const statusEl = host.querySelector('[data-role="status"]');
  const termViewEl = host.querySelector('[data-role="termview"]');
  const termMountEl = host.querySelector('[data-role="termmount"]');
  const termStartBtn = host.querySelector('[data-role="termstart"]');
  const termBottomBtn = host.querySelector('[data-role="termbottom"]');
  const termHistoryBtn = host.querySelector('[data-role="termhistory"]');
  const streamBottomBtn = host.querySelector('[data-role="streambottom"]');
  // 进度分叉提示，两个按钮时机不同：
  //   跳转到最新会话 = 仅链内有更新的后代时出现（同链新会话取代了本会话）
  //   合并全部进度并继续 = 只要本会话不是全任务最新就出现（它没掌握全部最新进度，跨链动态也算）
  // 本会话已是全任务最新 → 都不出
  const forkAlertEl = host.querySelector('[data-role="forkalert"]');
  const renderForkAlert = () => {
    try {
      if (!forkAlertEl) return;
      if (!currentTask) { forkAlertEl.hidden = true; return; }
      // 进度判断只看「实质代码活动」（编辑/命令/commit），不看会话文件 mtime：
      // 用户跟旧会话闲聊几句不该把闲聊会话顶成「最新」。
      const nodes = currentTask.nodes || [];
      const myCode = node.lastCodeActivity || '';
      const hasAnyCode = nodes.some((n) => n.lastCodeActivity);
      if (!myCode && !hasAnyCode) { forkAlertEl.hidden = true; return; }
      // 链内：只看「本会话的后代」（接力链上有继承关系的新会话才谈得上「跳过去」）
      const children = new Map();
      for (const n of nodes) {
        if (n.parentNodeId && n.id !== node.id) {
          if (!children.has(n.parentNodeId)) children.set(n.parentNodeId, []);
          children.get(n.parentNodeId).push(n);
        }
      }
      const chainNewer = [];
      const stack = [node.id];
      while (stack.length) {
        const cur = stack.pop();
        for (const c of children.get(cur) || []) {
          if (c.lastCodeActivity && String(c.lastCodeActivity) > myCode) chainNewer.push(c);
          stack.push(c.id);
        }
      }
      chainNewer.sort((a, b) => String(b.lastCodeActivity).localeCompare(String(a.lastCodeActivity)));
      // 全任务：有更晚代码活动的会话（合并按钮的触发条件）
      const anyNewer = nodes
        .filter((n) => n.id !== node.id && n.lastCodeActivity && String(n.lastCodeActivity) > myCode)
        .sort((a, b) => String(b.lastCodeActivity).localeCompare(String(a.lastCodeActivity)));
      if (!anyNewer.length) { forkAlertEl.hidden = true; return; }
      const top = anyNewer[0];
      forkAlertEl.hidden = false;
      const chainNote = chainNewer.length
        ? `接力链上有更新的代码改动 ${toolLabel(chainNewer[0].tool)}「${escapeHtml(truncate(chainNewer[0].title || '(会话)', 28))}」· ${fmtTime(chainNewer[0].lastCodeActivity)}${chainNewer.length > 1 ? `（链上另有 ${chainNewer.length - 1} 个更新会话）` : ''}`
        : `其他会话有更新的代码改动（可能来自不同功能方向）：${toolLabel(top.tool)}「${escapeHtml(truncate(top.title || '(会话)', 28))}」· ${fmtTime(top.lastCodeActivity)}${anyNewer.length > 1 ? `（另有 ${anyNewer.length - 1} 个更新会话）` : ''}`;
      forkAlertEl.innerHTML = `<span class="fork-warn">${icon('history', 13)} 本会话可能未掌握项目最新进度：${chainNote}</span>
        ${chainNewer.length ? `<button type="button" class="btn-primary small" data-role="jumplatest">${icon('handoff', 12)} 跳转到最新会话</button>` : ''}
        <button type="button" class="btn-ghost small" data-role="mergeckpt" title="把本任务所有会话的最新进展合并成一份摘要，并自动扫描项目现状（git 分支/提交/未提交改动/最近修改文件），生成一个掌握全部进度的新会话继续开发；原会话保留不动">${icon('context', 12)} 合并全部进度并继续</button>
        <button type="button" class="pbtn" data-role="forkclose" title="关闭提示">×</button>`;
      forkAlertEl.querySelector('[data-role="jumplatest"]')?.addEventListener('click', () => {
        forkAlertEl.hidden = true;
        openSessionTab(chainNewer[0].id); // 跳链上最新的；若它之后还有更新，它自己的提醒条会继续指路
      });
      forkAlertEl.querySelector('[data-role="mergeckpt"]').onclick = async (ev) => {
        const b = ev.currentTarget;
        b.disabled = true;
        b.textContent = '合并全部进度中…（十几秒）';
        try {
          const data = await api(`/api/tasks/${currentTask.id}/handoff-smart`, {
            method: 'POST',
            body: { toTool: node.tool, cwd: node.cwd || undefined, nodeId: node.id, launch: false, embed: false },
          });
          toast(`已生成合并会话（检查点 v${data.checkpointVersion}，含全部会话进展${data.truthScan ? ' + 项目现状扫描' : ''}），已在新标签打开`);
          forkAlertEl.hidden = true;
          openSessionTab(data.node.id);
        } catch (err) {
          toast(`合并失败: ${err.message}`);
          b.disabled = false;
          b.textContent = '合并全部进度并继续';
        }
      };
      forkAlertEl.querySelector('[data-role="forkclose"]').onclick = () => { forkAlertEl.hidden = true; };
    } catch { /* ignore */ }
  };
  renderForkAlert();
  /* 子代理修复记录条（Paseo 式可视化）：只在项目下存在 .sbridge-fix 时出现 */
  const subagentBarEl = host.querySelector('[data-role="subagentbar"]');
  const renderSubagents = async () => {
    if (!subagentBarEl) return;
    try {
      const r = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/subagents`);
      if (!r.fix?.exists) { subagentBarEl.hidden = true; return; }
      const n = r.sessions?.length || 0;
      const worker = r.fix.worker ? ` · worker: ${toolLabel(r.fix.worker)}` : '';
      subagentBarEl.hidden = false;
      subagentBarEl.innerHTML = `
        <button type="button" class="btn-ghost small" data-role="subagentopen">${icon('handoff', 13)} 子代理修复记录${n ? ` · ${n} 个会话` : ''}${escapeHtml(worker)}</button>
        <span class="sub-note">${r.fix.startedAt ? `开始于 ${escapeHtml(fmtTime(r.fix.startedAt))}` : '项目下有 .sbridge-fix 记录'}</span>`;
      subagentBarEl.querySelector('[data-role="subagentopen"]').onclick = () => openSubagentModal(node, r);
    } catch { subagentBarEl.hidden = true; }
  };
  renderSubagents();
  let firstBatch = true;
  let gone = false;
  let rawTerm = null; // { dispose, refit }
  let showingStream = true; // 默认显示工作轨迹（终端退居「TUI 交互层」，检测到确认框自动切过去）
  let streamRevealed = false;
  let streamUiFrame = 0;
  let cotTimer = 0;

  const nearBottom = () => scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 80;
  const toBottom = () => { scrollEl.scrollTop = scrollEl.scrollHeight; scheduleStreamUi(); };
  const syncStreamUi = () => {
    streamUiFrame = 0;
    const scrollable = scrollEl.scrollHeight > scrollEl.clientHeight + 48;
    streamBottomBtn.hidden = !showingStream || !scrollable || nearBottom();
  };
  const scheduleStreamUi = () => {
    if (streamUiFrame) return;
    streamUiFrame = requestAnimationFrame(syncStreamUi);
  };
  const touch = (ts) => { if (ts) lastTs.v = ts; };
  const isTerminalRunning = () => !!boundRunningTerm(node);
  /* 无头执行状态：工作轨迹主路径下，CLI 在后台跑、终端不挂载，界面靠这个状态
     给出「正在执行」反馈；执行结束（成功/失败）再刷新一次。 */
  let headlessRunning = false;
  let headlessStartedAt = 0;
  let headlessPollTimer = 0;
  const isHeadlessRunning = () => headlessRunning;
  const headlessElapsed = () => (headlessStartedAt ? Date.now() - headlessStartedAt : 0);
  /* 无头执行进度轮询：发完消息后每 2 秒查一次 headless-status。
     成功 → 结束「正在执行」状态；失败 → 立刻把 stderr 尾部用 toast 提示
     （模型失效/账号问题/代理问题都会在这里暴露，而不是静默等 30 秒）。 */
  const startHeadlessStatusPoll = () => {
    clearTimeout(headlessPollTimer);
    const tick = async () => {
      if (!headlessRunning) return;
      let st = null;
      try { st = (await api(`/api/tasks/${currentTask.id}/headless-status?nodeId=${node.id}`)).status; } catch { /* 下轮再试 */ }
      if (st && !st.running) {
        headlessRunning = false;
        if (st.exitCode !== 0 && st.stderrTail) {
          toast('执行失败: ' + st.stderrTail.slice(-140));
        }
        cot.setConnected(true);
        cot.refresh();
        try { renderSubagents(); } catch { /* ignore */ }
        return;
      }
      headlessPollTimer = setTimeout(tick, 2000);
    };
    tick();
  };
  scrollEl.addEventListener('scroll', scheduleStreamUi, { passive: true });

  const cot = createCotTimeline(listEl, {
    node,
    isFirstBatch: () => firstBatch,
    nearBottom,
    toBottom,
    scheduleStreamUi,
    isTerminalRunning,
    isHeadlessRunning,
    headlessElapsed,
    scrollEl,
  });
  cot.showEmpty('正在载入工作轨迹…');

  /* 会话上下文用量环：优先用工具自己记录的数字（node.ctx：codex token_count / claude usage /
     pi 状态栏，服务端从会话文件与终端输出里读），读不到才退回按事件估算 */
  const CTX_WINDOWS = { codex: 272000, claude: 200000, pi: 200000 };
  const CTX_SOURCE_LABEL = {
    'codex-token-count': 'Codex token_count',
    'claude-usage': 'Claude 会话 usage',
    'pi-status': 'Pi 状态栏',
    'pi-usage': 'Pi 会话 usage',
  };
  const RING_LEN = 50.27; // 2πr, r=8
  const ctxInit = node.ctx || null;
  let ctxTokens = ctxInit?.used ?? (Number(node.summary?.tokens) || 0);
  let ctxWindow = ctxInit?.window || CTX_WINDOWS[node.tool] || 200000;
  let ctxSource = ctxInit?.source || null;
  let ctxModel = ctxInit?.model || null;
  let ctxRaw = ctxInit?.raw || '';
  const ctxBtn = host.querySelector('[data-pact="ctx"]');
  const ctxVal = ctxBtn.querySelector('.ctx-ring-val');
  const ctxText = ctxBtn.querySelector('.ctx-ring-text');
  const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u3000-\u303f]/g;
  const estTokens = (text) => {
    const s = typeof text === 'string' ? text : text == null ? '' : JSON.stringify(text);
    if (!s) return 0;
    const cjk = (s.match(CJK_RE) || []).length;
    return Math.ceil(cjk / 1.15 + (s.length - cjk) / 3.6);
  };
  const updateCtxRing = () => {
    const pct = Math.min(1, ctxTokens / Math.max(1, ctxWindow));
    ctxVal.style.strokeDashoffset = String(RING_LEN * (1 - pct));
    ctxBtn.classList.toggle('ctx-warn', pct > 0.7);
    ctxBtn.classList.toggle('ctx-danger', pct >= 0.9);
    // 圆环中间直接写占比：不用悬浮也能一眼看到
    if (ctxText) {
      const n = pct * 100;
      ctxText.textContent = n > 0 && n < 1 ? '<1%' : `${Math.min(100, Math.round(n))}%`;
    }
    const src = ctxSource
      ? ` · 来源：${CTX_SOURCE_LABEL[ctxSource] || ctxSource}${ctxModel ? `（${ctxModel}）` : ''}`
      : ' · 估算（未读到工具用量）';
    ctxBtn.title = `本会话上下文：已用 ${Math.round(pct * 100)}%（${Math.round(ctxTokens / 1000)}k / ${Math.round(ctxWindow / 1000)}k 窗口）${src}${ctxRaw ? `\n${ctxRaw}` : ''}`;
  };
  updateCtxRing();

  // 工具自己更新用量后异步刷新（读不到准确值时才继续用事件估算）
  let usageTimer = null;
  const refreshUsage = () => {
    clearTimeout(usageTimer);
    usageTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/usage`);
        const c = r.ctx;
        if (!c || !c.used) return;
        ctxTokens = c.used;
        ctxWindow = c.window || ctxWindow;
        ctxSource = c.source || ctxSource;
        ctxModel = c.model || null;
        ctxRaw = c.raw || '';
        updateCtxRing();
      } catch { /* 服务暂时不可达，保留原值 */ }
    }, 1200);
  };

  const handle = (evt) => {
    if (!evt) return;
    // 有工具原生用量时不再估算，只等 refreshUsage 覆盖
    if (!ctxSource) {
      if (evt.kind === 'user' || evt.kind === 'assistant') ctxTokens += estTokens(evt.text);
      else if (evt.kind === 'tool_call') ctxTokens += estTokens(evt.args);
      else if (evt.kind === 'tool_result') ctxTokens += estTokens(evt.outcome);
    }
    updateCtxRing();
    if (evt.kind === 'assistant' || evt.kind === 'tool_result') refreshUsage();
    if (evt.type === 'gone') {
      statusEl.textContent = '会话文件已不存在';
      gone = true;
    }
    cot.handle(evt);
    touch(evt.ts);
  };

  const es = new EventSource(`/api/stream?tool=${encodeURIComponent(node.tool)}&file=${encodeURIComponent(node.file)}&tail=300`);
  es.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    cot.setConnected(true);
    statusEl.textContent = '';
    handle(evt);
    if (firstBatch && evt.kind) {
      // 历史回放是突发的一串：250ms 无新事件后一次性渲染，避免逐条重绘
      clearTimeout(handle._t);
      handle._t = setTimeout(() => {
        firstBatch = false;
        if (cot.isEmpty()) cot.showEmpty('会话还没有可展示的工作轨迹；在下方输入框发第一条消息吧。');
        else cot.finishBatch();
        if (showingStream) toBottom();
        scheduleStreamUi();
      }, 250);
    }
  };
  // 无历史会话时不让「正在载入…」一直停留
  es.onopen = () => {
    cot.setConnected(true);
    setTimeout(() => {
      if (!firstBatch || !cot.isEmpty()) return;
      cot.showEmpty('会话还没有可展示的工作轨迹；在下方输入框发第一条消息吧。');
      scheduleStreamUi();
    }, 1200);
  };
  es.onerror = () => {
    statusEl.textContent = '流已断开';
    cot.setConnected(false);
  };

  // 状态条
  const statusTimer = setInterval(() => {
    if (gone) return;
    const running = isTerminalRunning();
    if (stopBtn) stopBtn.hidden = !running; // 有活终端才显示「⏹ 停止」
    if (headlessRunning) {
      const sec = Math.max(0, Math.round(headlessElapsed() / 1000));
      statusEl.textContent = `● 正在执行 · ${sec}s`;
      return;
    }
    if (!lastTs.v) { statusEl.textContent = running ? '● 运行中' : '待活动'; return; }
    const sec = Math.max(0, Math.round((Date.now() - new Date(lastTs.v).getTime()) / 1000));
    statusEl.textContent = `${running ? '● 运行中 · ' : ''}最后活动 ${sec < 60 ? `${sec}s` : `${Math.round(sec / 60)}m`} 前`;
  }, 2000);
  cotTimer = setInterval(() => cot.tick(), 500);

  // 输入
  if (active) {
    const ta = host.querySelector('textarea');
    const btn = host.querySelector('.sess-input button');
    /* 斜杠命令菜单 + 历史命令（PgUp/PgDn）：让工作轨迹输入框的手感对齐终端。
       命令表是静态精选（CLI 的完整清单未暴露 API；菜单只做辅助，手输任意命令照常发送）。 */
    const SLASH_COMMANDS = {
      claude: [
        ['model', '<provider/model> — 选择模型（打开选择器 UI）'],
        ['settings', '打开设置菜单'],
        ['tree', '会话树导航（切换分支）'],
        ['thinking', '<level> — 设置思考等级'],
        ['scoped-models', '启用/禁用 Ctrl+P 模型轮换'],
        ['compact', '压缩对话上下文（上下文满时用）'],
        ['clear', '清空当前对话'],
        ['resume', '恢复历史会话'],
        ['review', '代码审查'],
        ['init', '初始化项目 CLAUDE.md'],
        ['agents', '管理子代理'],
        ['mcp', '管理 MCP 服务器'],
        ['permissions', '权限管理'],
        ['memory', '编辑记忆文件'],
        ['config', '打开配置'],
        ['cost', '用量统计'],
        ['doctor', '安装/环境诊断'],
        ['status', '账号与版本状态'],
        ['export', '导出当前对话'],
        ['login', '登录账号'],
        ['logout', '退出登录'],
        ['help', '帮助'],
      ],
      pi: [
        ['model', '选择/切换模型'],
        ['help', '帮助'],
        ['clear', '清屏'],
        ['login', '登录/配置账号'],
      ],
      codex: [
        ['model', '选择模型'],
        ['approvals', '审批模式设置'],
        ['init', '初始化项目 AGENTS.md'],
        ['status', '状态'],
        ['compact', '压缩对话上下文'],
        ['review', '代码审查'],
        ['diff', '查看改动'],
      ],
    };
    const slashList = SLASH_COMMANDS[node.tool] || [];
    const sessInput = host.querySelector('.sess-input');
    const menu = document.createElement('div');
    menu.className = 'slash-menu';
    menu.hidden = true;
    sessInput.insertBefore(menu, ta);
    let menuItems = [];
    let menuIdx = 0;
    let historyIdx = -1;
    const HISTORY_KEY = 'sbridge-input-history';
    const loadHistory = () => { try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '{}'); } catch { return {}; } };
    const pushHistory = (text) => {
      const all = loadHistory();
      const arr = all[node.tool] || [];
      if (arr[arr.length - 1] !== text) arr.push(text);
      all[node.tool] = arr.slice(-100);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(all)); } catch { /* ignore */ }
      historyIdx = -1;
    };
    const renderMenu = (filter) => {
      const q = (filter || '').replace(/^\//, '').toLowerCase();
      menuItems = slashList.filter(([cmd]) => !q || cmd.toLowerCase().startsWith(q) || cmd.toLowerCase().includes(q));
      menuIdx = 0;
      if (!menuItems.length || !filter.startsWith('/')) { menu.hidden = true; menu.innerHTML = ''; return; }
      menu.innerHTML = menuItems.map(([cmd, desc], i) => `
        <button type="button" class="slash-item ${i === menuIdx ? 'selected' : ''}" data-cmd="${cmd}">
          <span class="slash-cmd">${cmd}</span><span class="slash-desc">${desc}</span>
        </button>`).join('') + `<div class="slash-more">↑↓ 选择 · Tab/Enter 补全或发送 · Esc 关闭 (${menuItems.length})</div>`;
      menu.hidden = false;
    };
    menu.addEventListener('mousedown', (e) => {
      const item = e.target.closest('[data-cmd]');
      if (!item) return;
      e.preventDefault(); // mousedown 抢在 textarea 失焦前处理
      ta.value = '/' + item.dataset.cmd + ' ';
      menu.hidden = true;
      ta.focus();
    });
    ta.addEventListener('input', () => renderMenu(ta.value));
    ta.addEventListener('keydown', (e) => {
      if (!menu.hidden && menuItems.length) {
        if (e.key === 'ArrowDown') { e.preventDefault(); menuIdx = (menuIdx + 1) % menuItems.length; renderMenu(ta.value); const sel = menu.querySelector('.selected'); sel?.scrollIntoView({ block: 'nearest' }); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); menuIdx = (menuIdx - 1 + menuItems.length) % menuItems.length; renderMenu(ta.value); const sel = menu.querySelector('.selected'); sel?.scrollIntoView({ block: 'nearest' }); return; }
        if (e.key === 'Tab') { e.preventDefault(); ta.value = '/' + menuItems[menuIdx][0] + ' '; menu.hidden = true; return; }
        if (e.key === 'Enter' && !e.shiftKey) {
          const cmd = menuItems[menuIdx][0];
          const typed = ta.value.replace(/^\//, '').trim();
          // 输入与选中项完全一致（带参数的命令由用户自行补全）才直接发送，否则先补全
          if (typed === cmd) {
            e.preventDefault();
            e.stopImmediatePropagation(); // 阻断后面的 onkeydown，防止双发
            menu.hidden = true;
            doSend();
            return;
          }
          e.preventDefault();
          ta.value = '/' + cmd + ' ';
          menu.hidden = true;
          return;
        }
        if (e.key === 'Escape') { e.preventDefault(); menu.hidden = true; return; }
      }
      // PgUp/PgDn 历史命令（与终端一致的回溯手感）
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        const arr = loadHistory()[node.tool] || [];
        if (!arr.length) return;
        e.preventDefault();
        if (historyIdx === -1) { historyIdx = arr.length; historyDraft = ta.value; }
        historyIdx += e.key === 'PageUp' ? -1 : 1;
        if (historyIdx < 0) historyIdx = 0;
        if (historyIdx >= arr.length) { historyIdx = -1; ta.value = historyDraft || ''; return; }
        ta.value = arr[historyIdx];
        setTimeout(() => ta.setSelectionRange(ta.value.length, ta.value.length), 0);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && ta.value.trim()) pushHistory(ta.value.trim());
    });
    let historyDraft = '';
    const doSend = async () => {
      const text = ta.value.trim();
      if (!text) return;
      menu.hidden = true;
      btn.disabled = true;
      try {
        if (text.startsWith('/')) {
          // 斜杠命令 = TUI 指令：确保终端运行并发送，切到终端视图交互
          await sendToAgent(node, text);
          applyStreamView(false);
          await ensureTerminal();
          slashSwitched = true;
        } else if (boundRunningTerm(node)) {
          // 该会话的终端 TUI 正在运行：写 PTY
          await sendToAgent(node, text);
        } else {
          // 主路径：无头执行，不经终端。先本地显示用户消息（CLI 落盘前也有反馈），
          // 再启动状态轮询显示「正在执行」；回复由工作轨迹 SSE 实时呈现。
          headlessRunning = true;
          headlessStartedAt = Date.now();
          cot.addLocalUser(text);
          try {
            await api(`/api/tasks/${currentTask.id}/send-headless`, { method: 'POST', body: { nodeId: node.id, message: text } });
          } catch (err) {
            headlessRunning = false;
            cot.refresh();
            throw err;
          }
          startHeadlessStatusPoll();
        }
        ta.value = '';
      } catch (err) {
        toast(err.message);
      } finally { btn.disabled = false; ta.focus(); }
    };
    btn.onclick = doSend;
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    };
  }

  // 工具条
  host.querySelector('[data-pact="close"]')?.addEventListener('click', () => closeTab(node.id));
  host.querySelector('[data-pact="ctx"]')?.addEventListener('click', () => openCtxModal(node));
  host.querySelector('[data-pact="handoff"]')?.addEventListener('click', () => openHandoffModal(node));
  // ⏹ 停止：杀掉该会话挂着的 PTY（等效在终端输入退出命令）；确认一次防误触
  const stopBtn = host.querySelector('[data-pact="stopterm"]');
  stopBtn?.addEventListener('click', () => stopNodeTerm(node));
  // 📜 会话动态 ⇄ 终端 切换（不销毁终端）
  const streamBtn = host.querySelector('[data-pact="stream"]');
  let slashSwitched = false; // 斜杠命令切到终端交互后置位：对话框结束自动回工作轨迹
  const applyStreamView = (v) => {
    showingStream = v;
    termViewEl.hidden = v;
    scrollEl.hidden = !v;
    streamBtn.innerHTML = v ? (icon('terminal') + ' 终端') : (icon('timeline') + ' 工作轨迹');
    streamBtn.title = v ? '返回原始终端' : '查看 AI 工作轨迹（步骤、查询、结果与来源）';
    streamBtn.classList.toggle('active', v);
    streamBtn.setAttribute('aria-pressed', String(v));
    if (!v) {
      streamBottomBtn.hidden = true;
      rawTerm?.refit();
      ensureTerminal(); // 首次进入终端视图：按需挂载（容器此刻可见，一切正常）
    } else {
      // 首次显示前流容器是 display:none，历史回放的 scrollTop 不会生效；这里补一次定位
      requestAnimationFrame(() => {
        if (!streamRevealed) { streamRevealed = true; toBottom(); }
        scheduleStreamUi();
      });
      try { renderSubagents(); } catch { /* ignore */ }
    }
  };
  const setStreamView = (v) => { if (showingStream !== v) applyStreamView(v); };
  streamBtn?.addEventListener('click', () => applyStreamView(!showingStream));
  applyStreamView(true); // 默认显示工作轨迹（模板初始态是终端，这里纠正）
  /* TUI 交互提醒：终端出现确认框/选择框（信任、恢复选择、/model 之类的 picker）时，
     工作轨迹里脉冲提示「终端」按钮——用户点一下即进入终端视图（此刻才按需挂载，容器
     可见，挂载与显示都正常）。不做自动切换、不做内嵌弹层：隐藏挂载会丢内容，这是
     反复出问题的根源；工作轨迹为主界面 + 终端按需挂载 = 各自都稳定。 */
  const tuiHooks = {
    onTuiDialog: (active) => {
      const paneEl = host.querySelector('.session-pane');
      if (active && paneEl?.classList.contains('active')) {
        streamBtn.classList.add('attn');
        toast('终端有待处理的确认框：点「终端」查看处理');
      } else if (!active) {
        streamBtn.classList.remove('attn');
        if (slashSwitched) { slashSwitched = false; setStreamView(true); }
      }
    },
  };
  nodeTuiHandlers.set(node.id, tuiHooks.onTuiDialog);
  /* 终端按需挂载（工作轨迹为主界面）：隐藏容器里挂载/写入 xterm 会丢内容（fit=0 尺寸
     resize 清 buffer），所以终端只在终端视图可见时才挂载。聊天消息不依赖挂载
     （sendToAgent 自己会 spawn/写 PTY），工作轨迹完全自洽。 */
  let mounting = false;
  const ensureTerminal = async () => {
    if (rawTerm || mounting) { rawTerm?.refit(); return rawTerm; }
    mounting = true;
    try {
      await refreshTerms();
      if (nodeTermFor(node)) {
        rawTerm = await mountTerm(termMountEl, node, 0, tuiHooks);
      } else {
        rawTerm = await mountTerm(termMountEl, node, 0, tuiHooks); // mountTerm 内部会 spawn
      }
      termStartBtn.hidden = true;
      refreshTermIndicators();
      return rawTerm;
    } catch (err) {
      toast(err.message);
      termStartBtn.hidden = false;
      return null;
    } finally { mounting = false; }
  };
  const autoMount = async () => {
    // 默认工作轨迹视图：不自动挂载（隐藏挂载会丢内容）。终端在用户切到终端视图时按需挂载。
    await refreshTerms();
    termStartBtn.hidden = true; // 工作轨迹下无需启动按钮
    termBottomBtn.hidden = true;
  };
  autoMount();
  termStartBtn.addEventListener('click', async () => {
    termStartBtn.disabled = true;
    termStartBtn.innerHTML = icon('play') + ' 启动中…';
    try {
      rawTerm = await mountTerm(termMountEl, node, 0, tuiHooks);
      termStartBtn.hidden = true;
      refreshTermIndicators();
      // resume 的终端不会回放历史对话（Pi/Codex TUI 只画新交互），
      // 会话有历史时自动切到「工作轨迹」让用户先看到之前的对话；
      // 想直接对话再点「⌨ 终端」切回来即可。
      if (node.summary?.messageCount > 0) {
        const streamBtn = host.querySelector('[data-pact="stream"]');
        if (streamBtn && streamBtn.getAttribute('aria-pressed') !== 'true') streamBtn.click();
      }
    } catch (err) {
      toast(err.message);
      termStartBtn.hidden = false; // 自动启动失败时按钮要重新出现（手动路径本就可见）
      termStartBtn.disabled = false;
      termStartBtn.innerHTML = icon('play') + ' 启动此会话的终端';
    }
  });
  termBottomBtn.addEventListener('click', () => rawTerm?.scrollToBottom());
  // 终端无本地回滚时（resume 新进程），引导用户到工作轨迹查看历史
  termHistoryBtn.addEventListener('click', () => {
    const streamBtn = host.querySelector('[data-pact="stream"]');
    if (streamBtn && streamBtn.getAttribute('aria-pressed') !== 'true') streamBtn.click();
  });
  streamBottomBtn.addEventListener('click', () => { toBottom(); scheduleStreamUi(); });

  return {
    close() {
      es.close();
      clearInterval(statusTimer);
      clearInterval(cotTimer);
      clearTimeout(handle._t);
      clearTimeout(headlessPollTimer);
      clearTimeout(usageTimer);
      cot.destroy();
      if (streamUiFrame) cancelAnimationFrame(streamUiFrame);
      if (rawTerm) { try { rawTerm.dispose(); } catch { /* ignore */ } rawTerm = null; }
    },
    refit() { if (!showingStream) rawTerm?.refit(); },
    node,
  };
}

/* agent 输入通道：确保有活终端，把文字写进 PTY stdin */
const agentSockets = new Map(); // termId -> ws
const nodeTuiHandlers = new Map(); // nodeId → TUI 对话框回调（工作轨迹「终端」按钮脉冲）
// 每个会话节点专属的 PTY：分屏下多个会话常同目录同工具，若按 cwd 匹配共享 PTY，
// 发给 B 的消息会串进 A 的终端（B 的会话文件里没有，重开后内容凭空消失）。
// 节点级绑定：node.termId 有值优先用；没有就为该节点新起专属 PTY 并记录。
const nodeTermBindings = new Map(); // nodeId -> termId
async function sendToAgent(node, text) {
  let termId = nodeTermBindings.get(node.id) || node.termId || null;
  let term = termId ? (state.terms || []).find((x) => x.id === termId && x.running) : null;
  if (!term) {
    // 页面刷新后内存绑定会丢：先从服务端拿「归属本节点」（term.nodeId）的运行终端
    await refreshTerms();
    const owned = nodeTermFor(node);
    if (owned) { term = owned; termId = owned.id; }
  }
  if (!term) {
    const r = await api(`/api/tasks/${currentTask.id}/term`, {
      method: 'POST',
      body: { tool: node.tool, cwd: node.cwd || undefined, resumeCommand: node.resumeCommand || undefined, file: node.file || undefined, label: toolLabel(node.tool), nodeId: node.id },
    });
    await refreshTerms();
    termId = r.termId;
    term = { id: termId };
  }
  nodeTermBindings.set(node.id, term.id);
  refreshTermIndicators(); // 新 spawn 的 TUI 终端立刻点亮标签/会话链上的绿点
  const ws0 = agentSockets.get(term.id);
  const ws = (ws0 && ws0.readyState <= 1) ? ws0 : (() => {
    const w = new WebSocket(`ws://${location.host}/ws/term/${term.id}`);
    agentSockets.set(term.id, w);
    return w;
  })();
  // TUI 对话框检测（聊天优先模式）：必须在 open 之前挂监听——attach 回放里就带着
  // 闸门特征（恢复选择框等），open 之后再挂会漏检。匹配即触发「终端」按钮脉冲。
  if (!ws._dlgHooked) {
    ws._dlgHooked = true;
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string' || !/Enter to confirm|Esc to cancel/i.test(e.data)) return;
      const h = nodeTuiHandlers.get(node.id);
      if (!h) return;
      h(true);
      clearTimeout(h._t);
      h._t = setTimeout(() => h(false), 15000);
    });
  }
  if (ws.readyState === 0) await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('终端连接失败')); });
  if (ws.readyState !== 1) throw new Error('终端连接失败');
  ws.send(text + '\r');
}

/* 清空所有会话面板（切换任务时） */
function closeAllPanes() {
  for (const [, h] of paneHandles) { try { h.close(); } catch { /* ignore */ } }
  paneHandles.clear();
  // 同步移除已销毁的 DOM 宿主；否则再次打开同一任务会复用空壳，终端不会重新挂载
  $('pane-area').querySelectorAll('.pane-host').forEach((host) => host.remove());
  openTabs = [];
  activeTabId = null;
  boardMode = false;
  layout = { mode: 'single', slots: [null, null], focused: 0 };
  $('sess-tabs').innerHTML = '';
  updateSplitControls();
}

/* ---------------- 侧栏 ---------------- */
function renderTree() {
  const tree = $('tree');
  const tasksByProject = new Map();
  const loose = [];
  for (const t of state.tasks) {
    if (t.projectId) {
      if (!tasksByProject.has(t.projectId)) tasksByProject.set(t.projectId, []);
      tasksByProject.get(t.projectId).push(t);
    } else loose.push(t);
  }

  const taskHtml = (t) => `
    <div class="task-item ${t.id === currentTaskId ? 'active' : ''}" data-task="${t.id}">
      <span class="dot"></span>
      <span class="t-title" title="${escapeHtml(t.title)}">${escapeHtml(t.title)}</span>
      <span class="count" style="font-size:11px;color:#9a9aa4">${t.nodeCount}</span>
    </div>`;

  let html = '<div class="group-label"><span>项目文件夹</span><button class="add" id="btn-new-project" title="新建项目文件夹">＋</button></div>';
  if (!state.projects.length) {
    html += '<div class="empty-tree">还没有项目文件夹，先在底部新建一个。</div>';
  }
  for (const p of state.projects) {
    const list = tasksByProject.get(p.id) || [];
    html += `<div class="project">
      <div class="project-name">
        <span class="project-dot"></span>
        <span>${escapeHtml(p.name)}</span>
        <span class="count">${list.length}</span>
        <button class="add" data-new-task-in="${p.id}" title="在此项目下新建任务">＋</button>
      </div>
      ${list.map(taskHtml).join('')}
    </div>`;
  }

  html += '<div class="group-label"><span>独立任务</span></div>';
  html += loose.length ? loose.map(taskHtml).join('') : '<div class="empty-tree">没有独立任务</div>';

  tree.innerHTML = html;
  tree.querySelectorAll('[data-task]').forEach((el) => {
    el.addEventListener('click', () => openTask(el.dataset.task));
  });
  tree.querySelectorAll('[data-new-task-in]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      createTaskFlow(el.dataset.newTaskIn);
    });
  });
}

/* ---------------- 白板 ---------------- */
const CARD_W = 262;
const COL_GAP = 318;
const ROW_GAP = 176;
const MIN_GAP = 20;

/**
 * 树形紧凑布局：
 * - 接力链（单子节点链）保持同一 y，呈水平一条直线
 * - 分支（一个卡片多个子卡片）纵向展开，父卡片对齐第一个子卡片
 * - 独立新会话作为新根，排在下方
 */
function computeLayout(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const childrenMap = new Map();
  const roots = [];
  for (const n of nodes) {
    if (n.parentNodeId && byId.has(n.parentNodeId)) {
      if (!childrenMap.has(n.parentNodeId)) childrenMap.set(n.parentNodeId, []);
      childrenMap.get(n.parentNodeId).push(n);
    } else {
      roots.push(n);
    }
  }
  const byTime = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
  for (const list of childrenMap.values()) list.sort(byTime);
  // 根节点（独立会话/独立链）按「链内最新代码活动」降序排：最新进度的会话/链在白板最上面。
  // 用 lastCodeActivity（编辑/命令/commit），纯聊天的 mtime 不参与排序。
  const recency = (n) => String(n.lastCodeActivity || n.lastActivity || n.createdAt || '');
  const chainRecency = (n) => {
    let m = recency(n);
    for (const c of childrenMap.get(n.id) || []) {
      const cr = chainRecency(c);
      if (cr > m) m = cr;
    }
    return m;
  };
  roots.sort((a, b) => chainRecency(b).localeCompare(chainRecency(a)));

  const positions = new Map();
  const depthOf = new Map();

  const layoutSubtree = (node, depth, yStart) => {
    positions.set(node.id, { x: 36 + depth * COL_GAP, y: yStart });
    depthOf.set(node.id, depth);
    const children = childrenMap.get(node.id) || [];
    if (!children.length) return yStart + ROW_GAP;
    let y = yStart;
    let firstChildY = null;
    for (const c of children) {
      y = layoutSubtree(c, depth + 1, y);
      if (firstChildY === null) firstChildY = positions.get(c.id).y;
    }
    // 父卡片与第一个子卡片对齐，保证单链水平
    positions.get(node.id).y = firstChildY;
    return y;
  };

  let y = 40;
  let maxDepth = 0;
  for (const root of roots) {
    y = layoutSubtree(root, 0, y) + MIN_GAP;
  }
  for (const d of depthOf.values()) maxDepth = Math.max(maxDepth, d);

  return {
    positions,
    width: 36 + maxDepth * COL_GAP + CARD_W + 36,
    height: y + 60,
  };
}

/** 渲染后同列冲突消除：按实测卡片高度依次下移，保证不重叠 */
function resolveCollisions(positions, cardsEl) {
  const cols = new Map();
  for (const [id, pos] of positions) {
    if (!cols.has(pos.x)) cols.set(pos.x, []);
    cols.get(pos.x).push(id);
  }
  for (const ids of cols.values()) {
    ids.sort((a, b) => positions.get(a).y - positions.get(b).y);
    let prevBottom = -Infinity;
    for (const id of ids) {
      const el = cardsEl.querySelector(`[data-node="${id}"]`);
      const h = el ? el.offsetHeight : 160;
      const p = positions.get(id);
      if (p.y < prevBottom + MIN_GAP) p.y = prevBottom + MIN_GAP;
      prevBottom = p.y + h;
    }
  }
}

function renderBoard() {
  const cardsEl = $('cards');
  const svg = $('edges');
  const nodes = currentTask?.nodes || [];

  $('empty').style.display = nodes.length ? 'none' : 'flex';
  $('task-actions').hidden = !currentTask;
  $('btn-status').innerHTML = currentTask?.status === 'done' ? (icon('play') + ' 恢复进行中') : (icon('check') + ' 标记完成');

  if (!currentTask || !nodes.length) {
    cardsEl.innerHTML = '';
    svg.innerHTML = '';
    $('board').style.width = '100%';
    $('board').style.height = '100%';
    renderTabs(); // 空任务也要刷新顶部标签/侧栏，清掉上一个任务的残留链
    return;
  }

  const { positions, width, height } = computeLayout(nodes);
  const visible = visiblePaneIds();
  $('board').style.width = `${width}px`;
  $('board').style.height = `${height}px`;
  svg.setAttribute('width', width);
  svg.setAttribute('height', height);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  cardsEl.innerHTML = nodes.map((n) => {
    const pos = positions.get(n.id);
    const meta = n.summary || {};
    const branch = n.parentNodeId ? '<span class="chip branch">复制</span>' : '';
    const running = nodeTermFor(n) ? '<span class="run-dot" title="终端运行中"></span>' : '';
    return `<div class="card ${visible.includes(n.id) && !boardMode ? 'selected' : ''} ${n.id === activeTabId && !boardMode ? 'focused' : ''} ${boardMode && boardSel.has(n.id) ? 'sel' : ''}" data-node="${n.id}"
      style="left:${pos.x}px;top:${pos.y}px">
      <div class="card-head">
        <span class="chip ${n.tool}">${toolLabel(n.tool)}</span>
        ${branch}
        ${running}
        <span class="time">${fmtTime(n.createdAt)}</span>
      </div>
      <div class="card-title">${escapeHtml(n.title || '(无提问)')}</div>
      <div class="card-meta">
        <span>${meta.messageCount || 0} 条消息</span>
        <span>·</span>
        <span>${fmtTokens(meta.tokens || 0)} tokens</span>
        ${n.trimmedCount ? `<span>·</span><span>省略 ${n.trimmedCount} 条</span>` : ''}
      </div>
      <div class="card-foot">${escapeHtml(n.sessionId || '')}</div>
    </div>`;
  }).join('');

  // 实测高度消除同列重叠，再应用最终位置
  resolveCollisions(positions, cardsEl);
  for (const [id, pos] of positions) {
    const el = cardsEl.querySelector(`[data-node="${id}"]`);
    if (el) el.style.top = `${pos.y}px`;
  }

  // 连线（用最终位置与实测高度）
  const paths = [];
  for (const n of nodes) {
    if (!n.parentNodeId || !positions.has(n.parentNodeId)) continue;
    const parentEl = cardsEl.querySelector(`[data-node="${n.parentNodeId}"]`);
    const childEl = cardsEl.querySelector(`[data-node="${n.id}"]`);
    if (!parentEl || !childEl) continue;
    const p = positions.get(n.parentNodeId);
    const c = positions.get(n.id);
    const ph = parentEl.offsetHeight;
    const ch = childEl.offsetHeight;
    const x1 = p.x + CARD_W;
    const y1 = p.y + ph / 2;
    const x2 = c.x;
    const y2 = c.y + ch / 2;
    const dx = Math.max(48, (x2 - x1) / 2);
    paths.push(`<path d="M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}"
      fill="none" stroke="#b6b6c6" stroke-width="2" />
      <circle cx="${x1}" cy="${y1}" r="3" fill="#b6b6c6" />
      <circle cx="${x2}" cy="${y2}" r="3" fill="#fff" stroke="#b6b6c6" stroke-width="2" />`);
  }
  svg.innerHTML = paths.join('');

  // 交互统一在 setupBoardInteractions 里用事件委托（重绘后监听不会丢）
  // 顶部标签页与侧栏会话链同步刷新（renderTabs 内部会刷新 mini-chain）
  renderTabs();
}

/* ---------------- 白板交互：左键框选 / 右键拖动 / 右键卡片操作 ---------------- */
let boardMenuEl = null;

function applyBoardSelection() {
  const cardsEl = $('cards');
  if (!cardsEl) return;
  cardsEl.querySelectorAll('.card[data-node]').forEach((el) => {
    el.classList.toggle('sel', boardSel.has(el.dataset.node));
  });
}
function setBoardSelection(ids, additive = false) {
  if (!additive) boardSel.clear();
  for (const id of ids) boardSel.add(id);
  applyBoardSelection();
}
function clearBoardSelection() { boardSel.clear(); applyBoardSelection(); }

function closeBoardMenu() {
  if (boardMenuEl) { boardMenuEl.remove(); boardMenuEl = null; }
}

/** 会话的终端停止（面板上的「停止」与白板右键菜单共用） */
async function stopNodeTerm(node) {
  const term = boundRunningTerm(node);
  if (!term) { toast('该会话当前没有运行中的终端'); return; }
  if (!confirm(`停止 ${toolLabel(node.tool)} 的终端进程？（未保存的对话进度保留在会话文件里，可重新启动终端恢复）`)) return;
  try {
    await api('/api/terms/kill', { method: 'POST', body: { id: term.id } });
    toast('终端已停止');
    refreshTermIndicators();
  } catch (err) { toast(err.message); }
}

/** 白板卡片右键操作菜单：接力在最上面，其余是这个会话的全部操作 */
function openBoardMenu(nodeId, x, y) {
  closeBoardMenu();
  const node = findNode(nodeId);
  if (!node) return;
  const running = !!boundRunningTerm(node);
  const opened = openTabs.includes(node.id);
  const items = [
    { icon: 'handoff', label: '接力（生成检查点，换工具继续）', run: () => openHandoffModal(node) },
    { icon: 'timeline', label: '打开工作轨迹', run: () => openSessionTab(node.id) },
    { icon: 'split', label: '分屏打开', run: () => openInOtherSlot(node.id) },
    { icon: 'context', label: '会话上下文', run: () => openCtxModal(node) },
    running ? { icon: 'stop', label: '停止终端', danger: true, run: () => stopNodeTerm(node) } : null,
    opened ? { icon: 'x', label: '关闭标签', run: () => closeTab(node.id) } : null,
  ].filter(Boolean);
  const el = document.createElement('div');
  el.className = 'board-menu';
  el.innerHTML = `<div class="board-menu-head">已选 ${boardSel.size || 1} 个 · ${escapeHtml(truncate(node.title || '(会话)', 22))}</div>` +
    items.map((it, i) => `<button type="button" class="board-menu-item${it.danger ? ' danger' : ''}" data-mi="${i}"${i === 0 ? ' data-primary="1"' : ''}>${icon(it.icon, 14)}<span>${escapeHtml(it.label)}</span></button>`).join('');
  el.querySelectorAll('[data-mi]').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeBoardMenu();
      try { items[Number(b.dataset.mi)].run(); } catch (err) { toast(err.message); }
    });
  });
  document.body.appendChild(el);
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  el.style.left = `${Math.max(8, Math.min(x, window.innerWidth - w - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(y, window.innerHeight - h - 8))}px`;
  boardMenuEl = el;
}

/** 左键空白处拉框选卡片；右键任意位置拖动白板，右键单击卡片弹操作菜单 */
function setupBoardInteractions() {
  const wrap = $('board-wrap');
  if (!wrap) return;

  // 白板里不弹浏览器原生右键菜单（右键用于拖动/操作）
  wrap.addEventListener('contextmenu', (e) => e.preventDefault());

  const marquee = (down) => {
    down.preventDefault();
    const base = down.shiftKey ? [...boardSel] : [];
    if (!down.shiftKey) setBoardSelection([]);
    const rect0 = wrap.getBoundingClientRect();
    const sx = down.clientX - rect0.left + wrap.scrollLeft; // 起点（内容坐标）
    const sy = down.clientY - rect0.top + wrap.scrollTop;
    const ox = down.clientX;
    const oy = down.clientY;
    const box = document.createElement('div');
    box.className = 'board-marquee';
    wrap.appendChild(box);
    let moved = false;
    const onMove = (ev) => {
      if (Math.abs(ev.clientX - ox) > 3 || Math.abs(ev.clientY - oy) > 3) moved = true;
      const cx = ev.clientX - rect0.left + wrap.scrollLeft;
      const cy = ev.clientY - rect0.top + wrap.scrollTop;
      box.style.left = `${Math.min(sx, cx)}px`;
      box.style.top = `${Math.min(sy, cy)}px`;
      box.style.width = `${Math.abs(cx - sx)}px`;
      box.style.height = `${Math.abs(cy - sy)}px`;
      // 用视口坐标求与卡片的交集（只选可见范围内的卡片）
      const r = {
        left: Math.min(ox, ev.clientX), right: Math.max(ox, ev.clientX),
        top: Math.min(oy, ev.clientY), bottom: Math.max(oy, ev.clientY),
      };
      const hits = [];
      wrap.querySelectorAll('.card[data-node]').forEach((el) => {
        const c = el.getBoundingClientRect();
        if (c.left < r.right && c.right > r.left && c.top < r.bottom && c.bottom > r.top) hits.push(el.dataset.node);
      });
      setBoardSelection([...base, ...hits], true);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      box.remove();
      if (!moved && !down.shiftKey) clearBoardSelection(); // 空白处单击 = 取消选择
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const pan = (down, cardEl) => {
    down.preventDefault();
    const ox = down.clientX;
    const oy = down.clientY;
    const sl = wrap.scrollLeft;
    const st = wrap.scrollTop;
    let moved = false;
    wrap.classList.add('panning');
    const onMove = (ev) => {
      const dx = ev.clientX - ox;
      const dy = ev.clientY - oy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      wrap.scrollLeft = sl - dx;
      wrap.scrollTop = st - dy;
    };
    const onUp = (ev) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      wrap.classList.remove('panning');
      if (moved) return; // 拖动了就是平移，不弹菜单
      if (cardEl) {
        const id = cardEl.dataset.node;
        if (!boardSel.has(id)) setBoardSelection([id]);
        openBoardMenu(id, ev.clientX, ev.clientY);
      } else {
        closeBoardMenu();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  wrap.addEventListener('mousedown', (e) => {
    if (!boardMode) return;
    const cardEl = e.target.closest('.card[data-node]');
    if (e.button === 0) {
      if (cardEl) {
        // 左键点卡片 = 选中（Shift 加选/减选）；双击才打开会话
        const id = cardEl.dataset.node;
        if (e.shiftKey) {
          if (boardSel.has(id)) boardSel.delete(id); else boardSel.add(id);
          applyBoardSelection();
        } else {
          setBoardSelection([id]);
        }
        return;
      }
      marquee(e);
    } else if (e.button === 2) {
      pan(e, cardEl);
    }
  });

  wrap.addEventListener('dblclick', (e) => {
    const cardEl = e.target.closest('.card[data-node]');
    if (cardEl && boardMode) openSessionTab(cardEl.dataset.node);
  });

  document.addEventListener('mousedown', (e) => {
    if (boardMenuEl && !e.target.closest('.board-menu')) closeBoardMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeBoardMenu(); });
}

/* ---------------- 任务 ---------------- */
async function loadState() {
  state = await api('/api/state');
  if (!state.tools?.length) {
    try { state.tools = (await api('/api/tools')).tools; } catch { state.tools = DEFAULT_TOOLS; }
  }
  renderTree();
  refreshTerms();
}
// 卡片上的「终端运行中」小绿点：每 5 秒兜底刷新（启动/停止等动作已即时刷新）
setInterval(() => { if (currentTaskId) { refreshTerms().then(renderBoard); } }, 5000);

async function openTask(taskId) {
  currentTaskId = taskId;
  closeAllPanes();
  renderPanes();
  try {
    currentTask = await api(`/api/tasks/${taskId}`);
  } catch (err) {
    toast(err.message);
    return;
  }
  renderTree();
  boardSel.clear();
  closeBoardMenu();
  renderBoard();
  $('task-actions').hidden = false;
  // 自动打开该任务最近的一个会话（没有就停在白板/空态）
  const last = currentTask.nodes[currentTask.nodes.length - 1];
  if (last) openSessionTab(last.id);
}

async function refreshTask() {
  if (!currentTask) return;
  currentTask = await api(`/api/tasks/${currentTask.id}`);
  await loadState();
  renderBoard();
}

/* ---------------- 弹窗 ---------------- */
function openModal({ title, bodyHtml, submitLabel = '确定', onSubmit }) {
  $('modal-title').textContent = title;
  $('modal-body').innerHTML = bodyHtml;
  // submitLabel 为空 = 只展示内容，不放提交按钮
  $('modal-foot').innerHTML = `<button class="btn-ghost" id="modal-cancel">取消</button>
    ${submitLabel ? `<button class="btn-primary" id="modal-submit">${submitLabel}</button>` : ''}`;
  $('modal').hidden = false;

  const close = () => { $('modal').hidden = true; $('modal-body').innerHTML = ''; };
  $('btn-close-modal').onclick = close;
  $('modal-cancel').onclick = close;
  const submitBtn = $('modal-submit');
  if (submitBtn) submitBtn.onclick = async () => {
    try {
      await onSubmit();
      close();
    } catch (err) {
      toast(err.message);
    }
  };
  $('modal').onclick = (e) => { if (e.target === $('modal')) close(); };
  return close;
}

function createProjectFlow() {
  openModal({
    title: '新建项目文件夹',
    bodyHtml: `<div class="field"><label>名称</label><input id="f-name" placeholder="例如：游戏原型 / API 代理" autocomplete="off" /></div>`,
    submitLabel: '创建',
    onSubmit: async () => {
      const name = $('f-name').value.trim();
      if (!name) throw new Error('请输入名称');
      await api('/api/projects', { method: 'POST', body: { name } });
      await loadState();
      toast('项目已创建');
    },
  });
  setTimeout(() => $('f-name')?.focus(), 30);
}

function createTaskFlow(projectId = null) {
  const options = state.projects
    .map((p) => `<option value="${p.id}" ${p.id === projectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`)
    .join('');
  openModal({
    title: '新建任务',
    bodyHtml: `
      <div class="field"><label>任务标题</label><input id="f-title" placeholder="例如：修复 3D 卡片消失问题" autocomplete="off" /></div>
      <div class="field"><label>归属</label>
        <select id="f-project" style="width:100%;padding:9px 11px;border:1px solid var(--line-strong);border-radius:9px;font:inherit;font-size:13px">
          <option value="">独立任务（不放进项目文件夹）</option>
          ${options}
        </select>
      </div>`,
    submitLabel: '创建',
    onSubmit: async () => {
      const title = $('f-title').value.trim();
      if (!title) throw new Error('请输入任务标题');
      const task = await api('/api/tasks', {
        method: 'POST',
        body: { title, projectId: $('f-project').value || null },
      });
      await loadState();
      await openTask(task.id);
      toast('任务已创建，先接入一条已有会话');
    },
  });
  setTimeout(() => $('f-title')?.focus(), 30);
}

function launchFlow() {
  let tool = 'codex';
  const taskId = currentTask.id;
  const cwd = currentTask?.nodes?.find((n) => n.cwd)?.cwd || '';

  openModal({
    title: '新开会话',
    bodyHtml: `
      <div class="segmented" id="launch-switch">
        ${toolButtonsHtml('codex')}
      </div>
      <div class="field"><label>工作目录</label><input id="f-launch-cwd" value="${escapeHtml(cwd)}" placeholder="例如 D:\\projects\\demo" autocomplete="off" /></div>
      <div class="hint" id="launch-hint" style="color:#9a9aa4"></div>`,
    submitLabel: '启动',
    onSubmit: async () => {
      const dir = $('f-launch-cwd').value.trim();
      if (!dir) throw new Error('请填写工作目录');
      const r = await api(`/api/tasks/${taskId}/launch`, { method: 'POST', body: { tool, cwd: dir, embed: true } });
      await refreshTerms();
      const runCwd = r.cwd || dir;
      if (r.worktree?.path) {
        toast(`${toolLabel(tool)} 已在独立 worktree 启动：${r.worktree.path}（分支 ${r.worktree.branch}）`);
      } else {
        toast(`${toolLabel(tool)} 已在内嵌终端启动${r.worktree?.reason ? `（${r.worktree.reason}）` : ''}，首轮对话后自动接入…`);
      }
      pollNewSession(taskId, r.since, tool, runCwd);
    },
  });

  const hintEl = () => $('launch-hint');
  const updateHint = () => {
    if (hintEl()) hintEl().textContent = `会在 sbridge 内嵌终端里启动 ${toolLabel(tool)}（agent 挂在服务上，关页面不中断）；git 仓库且工作区干净时会自动建独立 worktree，多个 agent 并行互不覆盖；发出第一条消息后自动接入看板。`;
  };
  updateHint();
  $('launch-switch').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      tool = btn.dataset.tool;
      $('launch-switch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      updateHint();
    });
  });
  setTimeout(() => $('f-launch-cwd')?.focus(), 30);
}

async function pollNewSession(taskId, since, tool, cwd) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const data = await api(`/api/tasks/${taskId}/scan-new?tool=${tool}&since=${encodeURIComponent(since)}&cwd=${encodeURIComponent(cwd)}`);
      if (data.node) {
        if (currentTaskId === taskId) {
          openSessionTab(data.node.id); // 就地打开会话标签，自动接上实时流
        } else {
          await loadState();
        }
        toast(`已自动接入 ${toolLabel(tool)} 会话`);
        return;
      }
    } catch {
      // 网络抖动或任务被删，下一轮重试
    }
  }
  toast('3 分钟内未检测到新会话；开始对话后可用「接入已有会话」手动接入');
}

function attachFlow() {
  let tool = 'codex';
  let selected = null;
  let showAll = false;
  const cwd = currentTask?.nodes?.find((n) => n.cwd)?.cwd || '';

  const close = openModal({
    title: '接入已有会话',
    bodyHtml: `
      <div class="segmented" id="tool-switch">
        ${toolButtonsHtml('codex')}
      </div>
      <div class="hint" id="avail-hint" style="color:#9a9aa4;margin-bottom:10px">正在读取本机会话…</div>
      <div class="pick-list" id="pick-list"></div>`,
    submitLabel: '接入',
    onSubmit: async () => {
      if (!selected) throw new Error('请选择一条会话');
      await api(`/api/tasks/${currentTask.id}/nodes`, {
        method: 'POST',
        body: { tool, file: selected.file },
      });
      await refreshTask();
      toast('已接入会话');
    },
  });

  const loadList = async () => {
    $('pick-list').innerHTML = '<div class="empty-tree">读取中…</div>';
    try {
      const params = new URLSearchParams({ tool });
      if (cwd && !showAll) params.set('cwd', cwd);
      if (showAll) params.set('all', '1');
      const data = await api(`/api/available?${params}`);
      const toolName = toolLabel(tool);
      let hint;
      if (data.filtered) {
        hint = `${toolName} 本机共 ${data.totalAll} 条，按当前任务目录过滤后 ${data.totalFiltered} 条`;
      } else {
        hint = `${toolName} 本机共 ${data.totalAll} 条，全部显示`;
      }
      if (data.items.length < data.totalFiltered) hint += `（仅显示最近 ${data.items.length} 条）`;
      $('avail-hint').innerHTML = `${escapeHtml(hint)}${data.filtered ? ` · <a href="#" id="show-all-link" style="color:var(--accent)">显示全部</a>` : ''}`;
      $('show-all-link')?.addEventListener('click', (e) => {
        e.preventDefault();
        showAll = true;
        loadList();
      });
      // 按目录分组：目录名取路径末段（即项目文件夹名）
      const dirLabel = (cwdPath) => {
        if (!cwdPath) return '(未知目录)';
        const norm = cwdPath.replace(/[\\/]+$/, '');
        return norm.split(/[\\/]/).pop() || norm;
      };
      const groups = new Map();
      data.items.forEach((it, i) => {
        const key = it.cwd || '';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ it, i });
      });
      const groupHtml = [...groups.entries()].map(([dir, list]) => `
        <div class="pick-group">
          <div class="pick-group-head" title="${escapeHtml(dir)}">
            <span class="pick-group-name">${escapeHtml(dirLabel(dir))}</span>
            <span class="pick-group-path">${escapeHtml(dir)}</span>
          </div>
          ${list.map(({ it, i }) => `
          <div class="pick" data-idx="${i}">
            <span class="pick-radio"></span>
            <div class="pick-main">
              <div class="pick-title">${escapeHtml(it.title)}</div>
              <div class="pick-sub">${fmtTime(it.updatedAt)} · ${it.messageCount} 条 · ${escapeHtml((it.id || '').slice(0, 8))}</div>
            </div>
          </div>`).join('')}
        </div>`).join('');
      $('pick-list').innerHTML = data.items.length ? groupHtml : `<div class="empty-tree">没有可接入的会话（${toolName} 本机共 ${data.totalAll} 条）</div>`;
      $('pick-list').querySelectorAll('[data-idx]').forEach((el) => {
        el.addEventListener('click', () => {
          $('pick-list').querySelectorAll('.pick').forEach((x) => x.classList.remove('selected'));
          el.classList.add('selected');
          selected = data.items[Number(el.dataset.idx)];
        });
      });
    } catch (err) {
      $('pick-list').innerHTML = `<div class="empty-tree">读取失败：${escapeHtml(err.message)}</div>`;
    }
  };

  $('tool-switch').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      tool = btn.dataset.tool;
      selected = null;
      showAll = false;
      $('tool-switch').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
      loadList();
    });
  });
  loadList();
  return close;
}

/* ---------------- 面板工具弹窗：任务上下文 / 智能接力 ---------------- */

function openCtxModal(node) {
  openModal({
    title: `任务上下文 · ${toolLabel(node.tool)} 面板`,
    bodyHtml: '<div id="modal-usage"></div><div class="ctx-panel" id="modal-ctx"><div class="empty-tree">加载中…</div></div>',
    submitLabel: '',
  });
  renderCtxInto($('modal-ctx'), node);
  showNodeUsage(node);
}

/* 上下文用量：直接展示工具自己记录的数字与来源（pi 还会带上状态栏原文） */
async function showNodeUsage(node) {
  const el = $('modal-usage');
  if (!el) return;
  const labels = {
    'codex-token-count': 'Codex token_count',
    'claude-usage': 'Claude 会话 usage',
    'pi-status': 'Pi 状态栏',
    'pi-usage': 'Pi 会话 usage',
  };
  try {
    const r = await api(`/api/tasks/${currentTask.id}/nodes/${node.id}/usage`);
    const c = r.ctx;
    if (!c) {
      el.innerHTML = '<div class="ctx-label">上下文用量</div><div class="empty-tree">这个工具没有留下可读的用量记录（工作轨迹里的环为估算值）。</div>';
      return;
    }
    const pct = c.pct ?? (c.used / c.window) * 100;
    el.innerHTML = `<div class="ctx-label">上下文用量</div>
      <div class="ctx-row">
        <span class="ctx-item">已用 ${Math.round(pct)}%（${fmtTokens(c.used)} / ${Math.round(c.window / 1000)}k 窗口）</span>
        ${c.model ? `<span class="ctx-item" title="模型">${escapeHtml(c.model)}</span>` : ''}
        <span class="ctx-item">来源：${escapeHtml(labels[c.source] || c.source || '未知')}</span>
      </div>
      ${c.raw ? `<div class="ctx-raw" title="工具状态栏原文">${escapeHtml(c.raw)}</div>` : ''}`;
  } catch { el.innerHTML = ''; }
}

function openHandoffModal(node) {
  const others = (state.tools?.length ? state.tools : DEFAULT_TOOLS).filter((t) => t.id !== node.tool);
  let sel = others[0]?.id || null;
  openModal({
    title: `智能接力：${toolLabel(node.tool)} → ?`,
    bodyHtml: `
      <div class="hint" style="color:#9a9aa4;margin-bottom:10px">生成检查点（含增量捕获与 LLM 加工，约 10-60 秒），写入目标工具原生新会话并在 sbridge 内直接打开。</div>
      <div class="pick-list">${others.map((t, i) => `
        <div class="pick ${i === 0 ? 'selected' : ''}" data-to="${t.id}">
          <span class="pick-radio"></span>
          <div class="pick-main"><div class="pick-title">${escapeHtml(t.label)}</div>
          <div class="pick-sub">检查点注入其原生会话，接力链 +1</div></div>
        </div>`).join('')}</div>`,
    submitLabel: '开始接力',
    onSubmit: async () => {
      if (!sel) throw new Error('请选择目标工具');
      await smartHandoff(node, sel);
    },
  });
  $('modal-body').querySelectorAll('[data-to]').forEach((el) => {
    el.addEventListener('click', () => {
      sel = el.dataset.to;
      $('modal-body').querySelectorAll('.pick').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
}

async function handoff(node, toTool, btn = null) {
  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在复制…';
  }
  try {
    const data = await api(`/api/tasks/${currentTask.id}/handoff`, {
      method: 'POST',
      body: { nodeId: node.id, toTool },
    });
    await refreshTask();
    await refreshTerms();
    openSessionTab(data.node.id);
    toast(`已生成 ${toolLabel(toTool)} 会话：${data.resumeCommand}`);
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

/* ---------------- 智能接力与上下文面板 ---------------- */

async function smartHandoff(node, toTool, btn = null) {
  const origText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在生成检查点…（含增量捕获与 LLM 加工，约 10-60 秒）';
  }
  try {
    const data = await api(`/api/tasks/${currentTask.id}/handoff-smart`, {
      method: 'POST',
      body: { nodeId: node.id, toTool, cwd: node.cwd || undefined, embed: true },
    });
    await refreshTask();
    await refreshTerms();
    const how = data.llmUsed ? 'LLM 加工' : '规则生成';
    const loss = data.lossReport;
    const lossTxt = loss
      ? `；纳入 ${loss.knowledgeIncluded}/${loss.knowledgeTotal} 认知 · 证据 ${loss.evidenceIncluded}/${loss.evidenceTotal}${loss.dedupMerged ? ` · 去重合并 ${loss.dedupMerged} 条` : ''}`
      : '';
    const wtTxt = data.worktree?.path ? ` · 独立 worktree: ${data.worktree.path}` : '';
    const truthTxt = data.truthScan ? ' · 含项目现状扫描' : '';
    toast(`检查点 v${data.checkpointVersion} 已注入 ${toolLabel(toTool)} 新会话（${data.injectedTokens} tokens，${how}${lossTxt}${truthTxt}${wtTxt}），已在新标签打开，直接继续开发`);
    // 新会话作为新标签就地打开（旧会话标签保留，随时切回回看）
    openSessionTab(data.node.id);
  } catch (err) {
    toast(err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }
}

const CTX_BADGE = { verified: '已验证', open: '待验证', refuted: '已排除', stale: '已过期', error: '错误', test: '测试', command: '命令', diff: '修改' };

async function renderCtxInto(el, node) {
  if (!el) return;
  try {
    const data = await api(`/api/tasks/${currentTask.id}/context`);
    if (data.unbound || !data.summary) {
      el.innerHTML = '<div class="empty-tree">任务尚未绑定动态上下文；点「智能接力」时会自动绑定并捕获。</div>';
      return;
    }
    const s = data.summary;
    const c = s.counts || {};
    const costs = data.costs || null;
    const latest = s.latestCheckpoint || null;
    const section = (label, items) => {
      if (!items.length) return '';
      return `<div class="ctx-label">${label}</div>${items.map((h) => h).join('')}`;
    };
    const changed = s.codeRefs.filter((r) => (r.note || '').includes('已变化'));
    el.innerHTML = `
      <div class="ctx-row" style="margin-bottom:10px">
        <span class="ctx-item" style="margin:0">知识 ${c.knowledge}${c.knowledgeStale ? `（过期 ${c.knowledgeStale}）` : ''}</span>
        <span class="ctx-item" style="margin:0">证据 ${c.evidence}</span>
        <span class="ctx-item" style="margin:0">假设 ${c.hypothesesOpen} 开放 / ${c.hypothesesRefuted} 已排除</span>
        <span class="ctx-item" style="margin:0">文件追踪 ${c.codeRefs}</span>
        ${latest ? `<span class="ctx-item" style="margin:0">检查点 v${latest.version} · ${latest.injectedTokens} tokens${latest.llmUsed ? ' · LLM' : ''}${latest.loss ? ` · 纳入 ${latest.loss.knowledgeIncluded}/${latest.loss.knowledgeTotal} 认知` : ''}</span>` : ''}
      </div>
      ${section('项目认知（跨任务沉淀）', s.projectKnowledge.slice(0, 6).map((k) => `<div class="ctx-item"><span class="badge ${k.status}">${CTX_BADGE[k.status] || k.status}</span>${escapeHtml(k.content.length > 150 ? k.content.slice(0, 150) + '…' : k.content)}</div>`))}
      ${section('任务认知', s.knowledge.slice(0, 6).map((k) => `<div class="ctx-item"><span class="badge ${k.status}">${CTX_BADGE[k.status] || k.status}</span>${escapeHtml(k.content.length > 150 ? k.content.slice(0, 150) + '…' : k.content)}</div>`))}
      ${section('判断与假设', s.hypotheses.slice(0, 6).map((h) => `<div class="ctx-item"><span class="badge ${h.status}">${CTX_BADGE[h.status] || h.status}</span>${escapeHtml(h.content.length > 150 ? h.content.slice(0, 150) + '…' : h.content)}</div>`))}
      ${section('关键证据', s.evidence.slice(0, 6).map((e) => `<div class="ctx-item"><span class="badge ${e.kind}">${CTX_BADGE[e.kind] || e.kind}</span>${e.count > 1 ? `<b>×${e.count}</b> ` : ''}${escapeHtml(e.summary.length > 130 ? e.summary.slice(0, 130) + '…' : e.summary)}</div>`))}
      ${changed.length ? section('已变化文件（相关认知需重读）', changed.slice(0, 5).map((r) => `<div class="ctx-item"><span class="badge stale">已变化</span><span class="mono" style="font-size:11px">${escapeHtml(r.path)}</span></div>`)) : ''}
      ${costs ? section('切换成本', [
        `<div class="ctx-item">接力 ${costs.handoffCount} 次（平均 ${(costs.avgHandoffMs / 1000).toFixed(1)}s） · 累计注入 ${fmtTokens(costs.injectedTokens)} tokens · LLM 加工 ${costs.llmUsedCount || 0} 次共 ${fmtTokens(costs.llmTokens)} tokens</div>`,
        `<div class="ctx-item">规则去重已合并重复证据 ${costs.duplicatedEvidenceMerged} 条（零 Token）</div>`,
      ]) : ''}
      ${costs && costs.handoffCount ? '<button class="btn-ghost small" id="ctx-history">检查点历史 / 回退</button>' : ''}
    `;
  } catch (err) {
    el.innerHTML = `<div class="empty-tree">上下文读取失败：${escapeHtml(err.message)}</div>`;
    return;
  }
  $('ctx-history')?.addEventListener('click', () => showCheckpointHistory(node));
}

async function showCheckpointHistory(node) {
  const data = await api(`/api/tasks/${currentTask.id}/checkpoints`);
  const others = (state.tools?.length ? state.tools : DEFAULT_TOOLS).filter((t) => t.id !== node.tool);
  let toTool = others[0]?.id || node.tool;
  const lossText = (c) => c.loss
    ? ` · 纳入 ${c.loss.knowledgeIncluded}/${c.loss.knowledgeTotal} 认知 · 证据 ${c.loss.evidenceIncluded}/${c.loss.evidenceTotal}`
    : '';
  openModal({
    title: '检查点历史与回退',
    bodyHtml: `${others.length > 1 ? `<div class="segmented" id="rb-tool-switch">${toolButtonsHtml(toTool, node.tool)}</div>` : ''}
      <div class="pick-list">${data.checkpoints.map((c) => `
      <div class="pick" data-version="${c.version}">
        <span class="pick-radio"></span>
        <div class="pick-main">
          <div class="pick-title">v${c.version} · ${c.injectedTokens} tokens${c.llmUsed ? ' · LLM 加工' : ' · 规则生成'}${lossText(c)}</div>
          <div class="pick-sub">${fmtTime(c.createdAt)}</div>
        </div>
      </div>`).join('') || '<div class="empty-tree">暂无历史检查点</div>'}</div>
      <div class="hint" style="color:#9a9aa4;margin-top:10px">回退会用所选版本的检查点生成一条新的 ${toolLabel(toTool)} 会话（不覆盖历史，新生成一条）。</div>`,
    submitLabel: '用此版本接力',
    onSubmit: async () => {
      const sel = document.querySelector('#modal-body .pick.selected');
      if (!sel) throw new Error('请选择一个检查点版本');
      const r = await api(`/api/tasks/${currentTask.id}/checkpoint?rollback=1`, {
        method: 'POST',
        body: { toTool, version: Number(sel.dataset.version), cwd: node.cwd || undefined, launch: false },
      });
      await refreshTask();
      openSessionTab(r.node.id);
      toast(`已用 v${r.checkpointVersion} 生成 ${toolLabel(toTool)} 会话：${r.resumeCommand}`);
    },
  });
  $('modal-body').querySelectorAll('[data-version]').forEach((el) => {
    el.addEventListener('click', () => {
      $('modal-body').querySelectorAll('.pick').forEach((x) => x.classList.remove('selected'));
      el.classList.add('selected');
    });
  });
  $('modal-body').querySelectorAll('#rb-tool-switch button').forEach((btn) => {
    btn.addEventListener('click', () => {
      toTool = btn.dataset.tool;
      $('modal-body').querySelectorAll('#rb-tool-switch button').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });
}

/* ---------------- 顶部操作 ---------------- */
$('btn-new-task').onclick = () => createTaskFlow(null);
// btn-new-project 在 renderTree 的 group-label 里（每次重渲染重建），用委托绑定
$('tree').addEventListener('click', (e) => {
  if (e.target.closest('#btn-new-project')) createProjectFlow();
});
// 自动获取项目：手动触发扫描三个工具的会话目录，按 cwd 分组导入（不自动运行）
$('btn-settings').onclick = () => openSettingsModal();
$('btn-discover').onclick = async () => {
  const btn = $('btn-discover');
  if (!confirm('扫描 Codex / Pi / Claude Code 的全部会话，按项目目录归组导入看板？\n\n每个目录 = 一个项目文件夹，其下建一个「自动获取」任务收纳该目录所有工具的会话；已导入过的会话自动跳过。')) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = '扫描中…（可能要十几秒）';
  try {
    const r = await api('/api/discover', { method: 'POST', body: {} });
    if (r.nodesAdded === 0 && r.projectsCreated === 0) {
      toast('扫描完成：没有发现可导入的新会话（都已在看板里或没有实际对话）');
    } else {
      toast(`已导入 ${r.nodesAdded} 个会话：新建 ${r.projectsCreated} 个项目文件夹、${r.tasksCreated} 个任务${r.readFail ? `（${r.readFail} 个会话读取失败已跳过）` : ''}`);
    }
    await loadState(); // renderTree 在内：侧栏立即出现新项目/任务
    if (currentTaskId) {
      try { currentTask = await api(`/api/tasks/${currentTaskId}`); renderTabs(); } catch { /* 任务可能已变化 */ }
    }
  } catch (err) {
    toast(`自动获取失败: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
};
$('btn-launch').onclick = () => { if (currentTask) launchFlow(); };
$('btn-attach').onclick = () => attachFlow();
// 会话标签：激活 / 关闭
$('sess-tabs').addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close]');
  if (closeBtn) { e.stopPropagation(); closeTab(closeBtn.dataset.close); return; }
  const tab = e.target.closest('[data-tab]');
  if (!tab) return;
  if (e.shiftKey) openInOtherSlot(tab.dataset.tab);
  else openSessionTab(tab.dataset.tab);
});
$('btn-split').onclick = () => toggleSplit();
/* 顶栏「更多」折叠菜单：白板 / 分屏常驻，新开会话、接入、标记完成、删除任务收进菜单 */
(function bindMoreMenu() {
  const wrap = $('more-wrap');
  const menu = $('more-menu');
  const btn = $('btn-more');
  if (!wrap || !menu || !btn) return;
  const setOpen = (open) => {
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('active', open);
  };
  btn.setAttribute('aria-haspopup', 'menu');
  btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.hidden); });
  // 选择菜单项后立即收起（各按钮自己的 onclick 照常执行）
  menu.addEventListener('click', (e) => { if (e.target.closest('.more-item')) setOpen(false); });
  document.addEventListener('click', (e) => { if (!e.target.closest('#more-wrap')) setOpen(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
})();
$('split-right').onchange = (e) => {
  if (!e.target.value) return;
  layout.mode = 'split';
  openSessionTab(e.target.value, { slot: 1, split: true });
};
// 白板视图切换（顶栏按钮 + 侧栏链接）
$('btn-board-view2').onclick = () => toggleBoardView();
$('btn-board-view').onclick = () => toggleBoardView();
$('btn-status').onclick = async () => {
  if (!currentTask) return;
  const status = currentTask.status === 'done' ? 'active' : 'done';
  await api(`/api/tasks/${currentTask.id}`, { method: 'PATCH', body: { status } });
  await refreshTask();
};
$('btn-delete-task').onclick = async () => {
  if (!currentTask) return;
  if (!confirm(`删除任务「${currentTask.title}」？本地会话文件不会被删除。`)) return;
  await api(`/api/tasks/${currentTask.id}`, { method: 'DELETE' });
  currentTask = null;
  currentTaskId = null;
  closeAllPanes();
  renderPanes();
  await loadState();
  renderBoard();
};

/* ---------------- 启动 ---------------- */
// 主题：恢复上次选择 + 绑定右上角切换按钮
theme.apply();
$('btn-theme')?.addEventListener('click', () => theme.toggle());
/* 静态按钮图标注入（index.html 里的按钮，文本保留、字符图标换 SVG） */
(function decorateStaticIcons() {
  const decorate = (id, name, label) => {
    const b = $(id);
    if (b) b.innerHTML = icon(name) + (label ? ' ' + label : '');
  };
  decorate('btn-discover', 'radar', '自动获取项目');
  decorate('btn-settings', 'settings', '设置');
  decorate('btn-new-task', 'plus', '新建任务');
  // btn-new-project 已改为「项目文件夹」标题右侧的 ＋（renderTree 动态创建，纯文本）
  decorate('btn-board-view2', 'board', '白板');
  decorate('btn-split', 'split', '分屏');
  decorate('btn-launch', 'chat', '新开会话');
  decorate('btn-attach', 'link', '接入已有会话');
  decorate('btn-theme', document.body.classList.contains('theme-dark') ? 'sun' : 'moon', '');
  const bb = $('btn-board-view');
  if (bb) bb.innerHTML = icon('board', 12) + ' 白板视图';
})();

/* 赞助入口：配置了链接才显示（不配置就不打扰用户） */
(function initSupportEntry() {
  const btn = $('btn-support');
  if (!btn) return;
  const configured = Object.values(SUPPORT_LINKS).some((v) => String(v || '').trim());
  btn.hidden = !configured;
  if (configured) btn.addEventListener('click', openSupportModal);
})();

setupBoardInteractions();
updateSplitControls();
loadState().then(() => {
  const latest = [...state.tasks].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (latest) openTask(latest.id);
  else { $('task-actions').hidden = true; }
}).catch((err) => toast(err.message));
