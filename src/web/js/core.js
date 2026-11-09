/* sbridge · 核心：API / 用户设置 / 主题 / 图标 / 全局状态 / 工具函数 */

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
const DEFAULT_SETTINGS = { autoStartTerm: true, syncModel: true }; // 打开会话自动启动终端；工作轨迹与终端同步模型
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
  const close = openModal({
    title: '设置',
    bodyHtml: `
      <label class="set-row">
        <span class="set-text"><span class="pick-title">打开会话时自动启动终端</span>
        <span class="pick-sub">焦点面板的会话直接拉起终端进程，不用再点「启动此会话的终端」；关闭后回到手动模式</span></span>
        <span class="switch"><input type="checkbox" id="set-autoterm" ${userSettings.autoStartTerm ? 'checked' : ''}/><i></i></span>
      </label>
      <div class="set-row">
        <span class="set-text"><span class="pick-title">工作轨迹与终端同步模型</span>
        <span class="pick-sub">在工作轨迹切换模型时同步写入终端；终端里用 /model 改过也会自动回填。关闭后两边各改各的，互不影响</span></span>
        <span class="switch"><input type="checkbox" id="set-syncmodel" ${userSettings.syncModel !== false ? 'checked' : ''}/><i></i></span>
      </div>
      <div class="set-row">
        <span class="set-text"><span class="pick-title">环境诊断</span>
        <span class="pick-sub">检查 Codex / Pi / Claude Code 是否安装、会话目录与登录/密钥配置；只读检测，不改任何配置</span></span>
        <button type="button" class="btn-ghost" id="set-envcheck">${icon('radar')} 检查</button>
      </div>`,
    submitLabel: '保存',
    onSubmit: () => {
      saveUserSettings({
        autoStartTerm: $('set-autoterm').checked,
        syncModel: $('set-syncmodel').checked,
      });
      toast('设置已保存');
    },
  });
  $('set-envcheck').onclick = () => { close(); openEnvCheckModal(); };
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
    // 图表（mermaid）颜色是渲染时烘进去的，切主题后需要重画
    document.dispatchEvent(new CustomEvent('sbridge:theme', { detail: this.current }));
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

/* ---------- 引用本地文件：桌面版弹系统文件框拿绝对路径，浏览器里上传到数据目录 ---------- */
const fileToBase64 = (file) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(String(fr.result || '').split(',')[1] || '');
  fr.onerror = () => reject(new Error('读取文件失败'));
  fr.readAsDataURL(file);
});

/** 让用户选本地文件，返回绝对路径数组（取消时返回空数组） */
function pickLocalFiles() {
  const bridge = window.sbridgeFiles;
  if (bridge && typeof bridge.pick === 'function') {
    try { return Promise.resolve(bridge.pick()).then((list) => (Array.isArray(list) ? list : [])); }
    catch { return Promise.resolve([]); }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(input);
    let settled = false;
    const finish = (list) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(list);
    };
    input.addEventListener('change', async () => {
      const files = [...(input.files || [])];
      if (!files.length) return finish([]);
      const paths = [];
      for (const f of files) {
        try {
          const data = await fileToBase64(f);
          const r = await api('/api/upload', { method: 'POST', body: { name: f.name, data } });
          if (r.path) paths.push(r.path);
        } catch { toast(`文件引用失败: ${f.name}`); }
      }
      finish(paths);
    });
    // 取消选择不会触发 change：窗口重新聚焦后兜底收尾
    window.addEventListener('focus', () => setTimeout(() => { if (!settled) finish([]); }, 800), { once: true });
    input.click();
  });
}

/** 把文件路径插进输入框末尾（agent 拿到路径就能自己读） */
function appendFileRefs(ta, paths) {
  if (!ta || !paths || !paths.length) return;
  const block = paths.map((p) => `文件：${p}`).join('\n');
  const value = String(ta.value || '');
  ta.value = `${value}${value && !/\n$/.test(value) ? '\n' : ''}${block}\n`;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
  try { const end = ta.value.length; ta.setSelectionRange(end, end); } catch { /* ignore */ }
}

/* ---------- 各 CLI 支持的斜杠命令（静态精选；CLI 没有暴露完整清单） ---------- */
const TOOL_COMMANDS = {
  claude: [
    ['model', '<provider/model> — 选择模型'],
    ['settings', '打开设置菜单'],
    ['tree', '会话树导航（切换分支）'],
    ['thinking', '<level> — 设置思考等级'],
    ['scoped-models', '启用/禁用 Ctrl+P 模型轮换'],
    ['compact', '压缩对话上下文'],
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
const toolCommands = (tool) => TOOL_COMMANDS[tool] || [];

/* ---------- 输入框「＋」菜单：上传文件 / 当前工具支持的斜杠命令 ---------- */
function openPlusMenu({ anchor, tool, stacked = false, onFiles, onCommand }) {
  if (!anchor) return;
  const existing = document.querySelector('.attach-pop');
  if (existing) existing.remove();
  const host = anchor.closest('.composer, .sp-chat-compose') || anchor.parentElement;
  if (!host) return;
  const pop = document.createElement('div');
  pop.className = `attach-pop${stacked ? ' is-stacked' : ''}`;
  pop.innerHTML = `
    <button type="button" class="attach-item" data-act="files"><span class="attach-icon">${icon('plus', 14)}</span><span class="grow">上传文件</span></button>
    <button type="button" class="attach-item" data-act="cmd"><span class="attach-icon">${icon('terminal', 14)}</span><span class="grow">命令</span><span class="attach-arrow">›</span></button>
    <div class="attach-sub" hidden></div>`;
  host.appendChild(pop);
  const sub = pop.querySelector('.attach-sub');
  const cmdBtn = pop.querySelector('[data-act="cmd"]');
  const close = () => {
    pop.remove();
    document.removeEventListener('click', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  setTimeout(() => {
    document.addEventListener('click', outside, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  const paintSub = () => {
    const list = toolCommands(tool);
    if (!list.length) {
      sub.innerHTML = '<div class="attach-empty">这个工具没有已知的斜杠命令</div>';
      return;
    }
    sub.innerHTML = list.map(([cmd, desc]) => `
      <button type="button" class="slash-item" data-cmd="${escapeHtml(cmd)}">
        <span class="slash-cmd">${escapeHtml(cmd)}</span><span class="slash-desc">${escapeHtml(desc)}</span>
      </button>`).join('');
    sub.querySelectorAll('[data-cmd]').forEach((b) => {
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        const cmd = b.dataset.cmd;
        close();
        onCommand?.(cmd);
      });
    });
  };

  pop.querySelector('[data-act="files"]').addEventListener('click', (e) => {
    e.stopPropagation();
    close();
    onFiles?.();
  });
  cmdBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!sub.hidden) { sub.hidden = true; cmdBtn.classList.remove('active'); return; }
    if (!sub.childElementCount) paintSub();
    sub.hidden = false;
    cmdBtn.classList.add('active');
  });
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
  board: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M8.8 4.5v15M15.2 4.5v15" opacity=".45"/><path d="M5.2 7.4h2.1M5.2 10.2h2.1M10.4 7.4h2.1M10.4 10.2h2.1M10.4 13h2.1M16.8 7.4h2.1" opacity=".85"/>', // 白板：三栏 + 卡片
  split: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M12 4.5v15" opacity=".55"/><circle cx="12" cy="10" r=".8" fill="currentColor" stroke="none" opacity=".7"/><circle cx="12" cy="12" r=".8" fill="currentColor" stroke="none" opacity=".7"/><circle cx="12" cy="14" r=".8" fill="currentColor" stroke="none" opacity=".7"/>', // 分屏：双栏 + 分隔点
  plus: '<path d="M12 5v14M5 12h14"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  play: '<path d="M7 5.5v13l11-6.5z"/>',                                            // 启动
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.4"/><path d="M3.5 3.5v4.9h4.9"/><path d="M12 7.5V12l3 2.5"/>', // 历史
  down: '<path d="M12 5v13M6.5 12.5 12 18l5.5-5.5"/>',                              // 回到底部
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.6v1.9M12 19.5v1.9M2.6 12h1.9M19.5 12h1.9M5.3 5.3l1.35 1.35M17.35 17.35l1.35 1.35M5.3 18.7l1.35-1.35M17.35 6.65l1.35-1.35"/>',
  moon: '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.8 6.8 0 0 0 9.7 9.7z"/>',
  check: '<path d="M4.5 12.5l5 5L20 7"/>',                                          // 标记完成
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13.5h9l1-13.5"/>',                 // 删除
  link: '<path d="M10.5 13.5a4.5 4.5 0 0 0 6.4 0l2.8-2.8a4.5 4.5 0 0 0-6.4-6.4L11.9 5.7"/><path d="M13.5 10.5a4.5 4.5 0 0 0-6.4 0l-2.8 2.8a4.5 4.5 0 0 0 6.4 6.4l1.4-1.4"/>', // 接入
  chat: '<path d="M21 12a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1L3 21l1.6-4.4A8.5 8.5 0 1 1 21 12z"/>', // 新开会话
  radar: '<path d="M19.07 4.93a10 10 0 1 0 .43 10.24"/><path d="M16.24 7.76a6 6 0 1 0 .36 6.14"/><circle cx="12" cy="12" r="1.6"/>', // 自动获取扫描
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>', // 设置
  heart: '<path d="M19.5 12.6 12 20l-7.5-7.4a5 5 0 0 1 7.5-6.6 5 5 0 0 1 7.5 6.6z"/>', // 支持/赞助
  git: '<circle cx="6" cy="18" r="2.5"/><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><path d="M6 8.5v7"/><path d="M18 8.5v2a4 4 0 0 1-4 4H6"/>', // 项目/仓库
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', // 复制
  search: '<circle cx="10.6" cy="10.6" r="6.3"/><path d="M15.2 15.2 20.4 20.4"/><path d="M7.4 10.6a3.2 3.2 0 0 1 3.2-3.2" opacity=".5"/>', // 全局搜索
  more: '<circle cx="12" cy="5.4" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="18.6" r="1.2" fill="currentColor" stroke="none"/>', // 更多
  download: '<path d="M12 3v12"/><path d="M7 10.5 12 15.5l5-5"/><path d="M4 20h16"/>', // 导出
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="M20 4v5h-5"/>',              // 刷新/重新检查
  panel: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M14.6 4.5v15" opacity=".55"/><path d="M17.4 8.6h1.6M17.4 11.4h1.6" opacity=".8"/>', // 右侧面板
  diff: '<path d="M8 4v12"/><circle cx="8" cy="18.5" r="2"/><circle cx="16" cy="5.5" r="2"/><path d="M16 7.5v6a4 4 0 0 1-4 4h-2"/>', // 改动对比
  arrowUp: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',                          // 发送
  chevronDown: '<path d="M6 9.5l6 6 6-6"/>',                                          // 下拉
  file: '<path d="M6 3.5h7l5 5v12a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 20.5V5A1.5 1.5 0 0 1 6.5 3.5z"/><path d="M13 3.5V9h5" opacity=".6"/>', // 文件
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
};
/** 生成内联 SVG 图标（currentColor 随按钮着色） */
function icon(name, size = 14) {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

