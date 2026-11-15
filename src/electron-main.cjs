const { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** sbridge 桌面版
 *  Electron 壳：启动/守护 sbridge.exe（Node SEA 服务），承载 Web UI，
 *  托盘常驻（关窗最小化，agent 不中断），开机启动走注册表 Run 键。
 */

let win = null;
let tray = null;
let svc = null;           // sbridge.exe 子进程
let svcPort = 4310;
let quitting = false;     // 区分「关窗最小化」与「真退出」
let bootT0 = Date.now();

const isPackaged = app.isPackaged;
const IS_WIN = process.platform === 'win32';

/* 内嵌浏览器 + 编程工具接管（借鉴 Playwright MCP / chrome-devtools-mcp / browser-use 的
   「单实例 + CDP attach」做法）：桌面版开一个本地 CDP 端口，面板里的浏览器就是唯一实例；
   pi/claude/codex 通过 --cdp-endpoint=http://127.0.0.1:9222 直接接管，不再各自启动浏览器。
   端口默认 9222（与主流工具的默认约定一致），可用环境变量覆盖。
   必须在 app ready 之前设置，之后无法再开。 */
const CDP_PORT = Number(process.env?.SBRIDGE_CDP_PORT || 9222) || 9222;
app.commandLine.appendSwitch('remote-debugging-port', String(CDP_PORT));
// 仅监听本机；Chrome 111+ 对 ws 连接校验 Origin，放行本机 CDP 客户端
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-allow-origins', '*');
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

/* 面板浏览器用 WebContentsView，而不是 <webview>：
   实测差别是决定性的——WebContentsView 在 CDP /json/list 里是 type=page，
   Playwright / Playwright MCP / chrome-devtools-mcp / browser-use 才枚举得到、才能接管；
   <webview> 是 type=webview，这些工具一律看不见（功能等于没做）。
   页面只是宿主：渲染进程报上可见矩形，主进程按矩形摆放这个原生视图。 */
const BROWSER_PARTITION = 'persist:sbridge-browser';
// 服务程序：Windows 是 .exe，Linux/macOS 是 ELF/Mach-O 可执行文件
const svcName = IS_WIN ? 'sbridge.exe' : 'sbridge';
const svcExe = isPackaged
  ? path.join(process.resourcesPath, 'sbridge', svcName)
  : path.join(__dirname, '..', 'dist', svcName);
// 窗口/托盘图标：Windows 用 .ico，Linux 用 png
const appIcon = path.join(__dirname, IS_WIN ? 'icon.ico' : 'icon.png');

/* 启动闪屏：先出窗口再等后端，避免双击后 1-2 秒没有任何反应 */
const SPLASH_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:#f7f5f1;color:#191a1d;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{display:flex;flex-direction:column;align-items:center;gap:12px}
.logo{width:52px;height:52px;border-radius:14px;background:#5b5bd6;color:#fff;
  display:grid;place-items:center;font-weight:700;font-size:18px;letter-spacing:.5px}
.name{font-size:15px;font-weight:600}
.tip{font-size:12px;color:#71727b}
.bar{width:180px;height:3px;border-radius:2px;background:#e7e7ec;overflow:hidden}
.bar i{display:block;height:100%;width:40%;background:#8b87f0;border-radius:2px;
  animation:slide 1.1s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}
</style></head><body><div class="wrap">
<div class="logo"><svg viewBox="0 0 28 28" width="26" height="26" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><circle cx="7.8" cy="9.2" r="2.6"/><circle cx="20.2" cy="18.8" r="2.6" opacity=".58"/><path d="M10 10.5c3.6 0 3.1 5.3 7.6 6.6" opacity=".92"/></svg></div><div class="name">sbridge</div>
<div class="tip">正在启动工作台…</div><div class="bar"><i></i></div>
</div></body></html>`);

/** 版本比较：1.0.1 > 1.0.0 */
function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((x) => Number(x) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

/** 检查更新：启动时静默检查（有新版才提示），托盘菜单可手动检查 */
async function checkUpdate(silent = true) {
  try {
    const res = await fetch('https://api.github.com/repos/liuxiu34/sbridge/releases/latest', {
      headers: { 'User-Agent': 'sbridge-updater', Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rel = await res.json();
    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const current = app.getVersion();
    if (compareVersions(latest, current) > 0) {
      const r = await dialog.showMessageBox({
        type: 'info',
        title: '发现新版本',
        message: `发现新版本 v${latest}（当前 v${current}）`,
        detail: '是否打开下载页面？',
        buttons: ['打开下载页', '稍后'],
        defaultId: 0,
        cancelId: 1,
      });
      if (r.response === 0) shell.openExternal(rel.html_url || 'https://github.com/liuxiu34/sbridge/releases');
    } else if (!silent) {
      dialog.showMessageBox({ type: 'info', title: '检查更新', message: `已是最新版本 v${current}` });
    }
  } catch (err) {
    logLine(`检查更新失败: ${err.message}`);
    if (!silent) dialog.showMessageBox({ type: 'warning', title: '检查更新失败', message: '无法获取最新版本', detail: String(err.message || err) });
  }
}

function logLine(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'shell.log'), line + '\n'); } catch { /* ignore */ }
}

function startService() {
  if (quitting) return;
  if (!fs.existsSync(svcExe)) {
    dialog.showErrorBox('sbridge', `找不到服务程序：\n${svcExe}`);
    app.quit();
    return;
  }
  svc = spawn(svcExe, [`--port=${svcPort}`], {
    cwd: path.dirname(svcExe),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // 数据放用户目录：卸载升级不丢数据，且不受 Program Files 写权限限制；
    // 桌面版窗口由本壳承载，服务端不要再弹浏览器
    env: {
      ...process.env,
      SBRIDGE_DATA: path.join(app.getPath('appData'), 'sbridge', 'data'),
      SBRIDGE_NO_BROWSER: '1',
      // 面板浏览器的接管地址：随服务进程继承给 pi/claude/codex，
      // 工具侧用 Playwright MCP / browser-use 直接 attach，不必自带浏览器
      SBRIDGE_CDP_URL: CDP_URL,
      SBRIDGE_CDP_PORT: String(CDP_PORT),
      // 桌面版不复用别的 sbridge 实例：端口被占时自己换端口起新服务，
      // 避免连到一个使用其它数据目录（比如 dev）的旧实例。
      SBRIDGE_NO_REUSE: '1',
    },
  });
  let reusingService = false;
  svc.stdout.on('data', (d) => {
    const text = String(d).trim();
    logLine(`[svc] ${text}`);
    // 服务会打印 SBRIDGE_PORT=<实际端口>；端口冲突自动换端口后靠这里同步
    const m = text.match(/SBRIDGE_(REUSE_)?PORT=(\d+)/);
    if (m) {
      const p = Number(m[2]);
      if (p > 0 && p !== svcPort) {
        svcPort = p;
        logLine(`服务实际端口: ${svcPort}`);
      }
      if (m[1]) reusingService = true;
    }
  });
  svc.stderr.on('data', (d) => logLine(`[svc:err] ${String(d).trim()}`));
  svc.on('exit', (code) => {
    logLine(`服务退出 code=${code}`);
    svc = null;
    if (!quitting && win) {
      // 复用了已有 sbridge 实例时服务进程会正常退出，不要反复重启
      if (reusingService) { logLine('已复用现有 sbridge 服务'); return; }
      // 服务意外退出：提示并允许重启
      dialog.showErrorBox('sbridge', `后端服务意外退出（code=${code}），应用将重启服务。`);
      setTimeout(startService, 1000);
    }
  });
}

function waitForService(tries = 100) {
  return new Promise((resolve) => {
    const tick = async (n) => {
      try {
        const res = await fetch(`http://127.0.0.1:${svcPort}/api/terms`);
        if (res.ok) return resolve(true);
      } catch { /* not ready */ }
      if (n <= 0) return resolve(false);
      setTimeout(() => tick(n - 1), 80);
    };
    tick(tries);
  });
}

/* ---------------- 面板浏览器（WebContentsView，CDP 里是 type=page） ----------------
   渲染进程通过 IPC 报告面板里那块占位区域的矩形，主进程把原生视图摆上去。
   视图常驻不销毁：面板切走只是隐藏（setVisible(false)），页面与登录态都保留。
   多个浏览器标签 = 多个视图，按 tabId 各自独立（同一 persist 分区，共享登录态）。 */
const browserViews = new Map(); // tabId -> { view, shown }

function ensureBrowserView(tabId) {
  const key = String(tabId || 'default');
  const hit = browserViews.get(key);
  if (hit) return hit;
  const { WebContentsView } = require('electron');
  const view = new WebContentsView({
    webPreferences: {
      partition: BROWSER_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // 浏览器面板里的页面是外部站点，禁止任何桥接能力
      sandbox: true,
      webSecurity: true,
    },
  });
  const wc = view.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 页面标题/地址变化回传渲染进程（地址栏同步）；带 tabId，多标签各认各的
  const notify = (channel, payload) => { try { win?.webContents.send(channel, { tabId: key, ...payload }); } catch { /* ignore */ } };
  wc.on('did-navigate', (_e, url) => notify('sbridge:browser-navigate', { url }));
  wc.on('did-navigate-in-page', (_e, url) => notify('sbridge:browser-navigate', { url }));
  wc.on('page-title-updated', (_e, title) => notify('sbridge:browser-title', { title }));
  // 初始页给一个真实 URL：Playwright 的 connectOverCDP 会跳过 url 为空的 page target，
  // 空白视图会让工具"看不见"这个浏览器。
  wc.loadURL('about:blank').catch(() => {});
  const entry = { view, shown: false };
  browserViews.set(key, entry);
  return entry;
}

function layoutBrowserView(tabId, bounds) {
  if (!win || !tabId) return;
  const key = String(tabId);
  const entry = ensureBrowserView(key);
  // 同一时刻只显示当前标签的视图：其余的隐藏（多开浏览器标签时避免叠在一起）
  for (const [otherKey, other] of browserViews) {
    if (otherKey !== key && other.shown) { try { other.view.setVisible(false); } catch { /* ignore */ } }
  }
  if (!bounds || bounds.width < 2 || bounds.height < 2) { hideBrowserView(key); return; }
  if (!entry.shown) { win.contentView.addChildView(entry.view); entry.shown = true; }
  // 渲染进程给的是 CSS 像素的视口坐标；WebContentsView 也用 DIP，可直接用
  entry.view.setBounds({
    x: Math.round(bounds.x), y: Math.round(bounds.y),
    width: Math.round(bounds.width), height: Math.round(bounds.height),
  });
  entry.view.setVisible(true);
}

function hideBrowserView(tabId) {
  if (!tabId) {
    // 不带 tabId = 全部隐藏（面板整体收起/离开浏览器 surface）
    for (const [key] of browserViews) hideBrowserView(key);
    return;
  }
  const entry = browserViews.get(String(tabId));
  if (!entry || !entry.shown) return;
  try { entry.view.setVisible(false); } catch { /* ignore */ }
}

/** 关闭某个浏览器标签时销毁它的视图（页面状态不再需要） */
function disposeBrowserView(tabId) {
  const key = String(tabId);
  const entry = browserViews.get(key);
  if (!entry) return;
  browserViews.delete(key);
  try { win?.contentView.removeChildView(entry.view); } catch { /* ignore */ }
  try { entry.view.webContents.close(); } catch { /* ignore */ }
}

function createWindow() {  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#f7f5f1',
    title: 'sbridge · 会话接力工作台',
    icon: appIcon,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  // 先显示闪屏：窗口立刻出现，后端就绪后再加载真实页面
  win.loadURL(SPLASH_URL);
  // 阻止页面自己开新窗口：转系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // 关窗 = 最小化到托盘（agent 常驻），只有托盘菜单「退出」才真退出
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  tray = new Tray(appIcon);
  const menu = Menu.buildFromTemplate([
    { label: '显示工作台', click: () => { win ? win.show() : createWindow(); } },
    { label: '服务状态：运行中', enabled: false },
    { type: 'separator' },
    { label: '检查更新', click: () => checkUpdate(false) },
    { label: '开机自动启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      enabled: IS_WIN || process.platform === 'darwin',
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath }); } },
    { type: 'separator' },
    { label: '退出 sbridge', click: () => app.quit() },
  ]);
  tray.setToolTip('sbridge · 会话接力工作台');
  tray.setContextMenu(menu);
  tray.on('double-click', () => { win ? win.show() : createWindow(); });
}

app.whenReady().then(async () => {
  // 单实例：二次启动直接聚焦已有窗口
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) { app.quit(); return; }
  app.on('second-instance', () => { if (win) { win.show(); win.focus(); } else createWindow(); });

  bootT0 = Date.now();
  // 引用本地文件：页面通过 preload 调这里弹系统文件框，返回绝对路径
  ipcMain.handle('sbridge:pick-files', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '选择要引用的文件',
        properties: ['openFile', 'multiSelections'],
      });
      return r.canceled ? [] : r.filePaths;
    } catch { return []; }
  });
  // 选择目录（新开会话的工作目录）：返回单个绝对路径，取消返回 null
  ipcMain.handle('sbridge:pick-directory', async () => {
    try {
      const r = await dialog.showOpenDialog(win, {
        title: '选择工作目录',
        properties: ['openDirectory', 'createDirectory'],
      });
      return r.canceled ? null : (r.filePaths[0] || null);
    } catch { return null; }
  });
  /* 面板浏览器（WebContentsView）：渲染进程报告可见矩形 → 主进程摆放原生视图。
     bounds 为空/过小 = 面板不可见，隐藏但保活（页面与登录态保留）。 */
  ipcMain.handle('sbridge:browser-layout', (_e, { tabId, bounds } = {}) => {
    layoutBrowserView(tabId, bounds);
    return { ok: true };
  });
  ipcMain.handle('sbridge:browser-dispose', (_e, { tabId } = {}) => {
    disposeBrowserView(tabId);
    return { ok: true };
  });
  ipcMain.handle('sbridge:browser-command', async (_e, { tabId, action, url } = {}) => {
    const view = ensureBrowserView(tabId).view;
    const wc = view.webContents;
    try {
      if (action === 'navigate' && url) {
        let target = String(url).trim();
        if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) target = `https://${target}`;
        await wc.loadURL(target);
        return { ok: true, url: wc.getURL() };
      }
      if (action === 'back') { wc.navigationHistory.canGoBack() && wc.navigationHistory.goBack(); return { ok: true }; }
      if (action === 'forward') { wc.navigationHistory.canGoForward() && wc.navigationHistory.goForward(); return { ok: true }; }
      if (action === 'reload') { wc.reload(); return { ok: true }; }
      if (action === 'open-external') { if (/^https?:/i.test(wc.getURL())) shell.openExternal(wc.getURL()); return { ok: true }; }
      if (action === 'state') {
        return {
          ok: true,
          url: wc.getURL(),
          title: wc.getTitle(),
          canGoBack: wc.navigationHistory.canGoBack(),
          canGoForward: wc.navigationHistory.canGoForward(),
        };
      }
      return { ok: false, error: `未知动作 ${action}` };
    } catch (err) { return { ok: false, error: String(err.message || err) }; }
  });
  createWindow();          // 立刻出闪屏，不用等后端
  startService();
  const ready = await waitForService();
  logLine(`服务就绪 ${Date.now() - bootT0}ms`);
  if (!ready) {
    dialog.showErrorBox('sbridge', '后端服务启动超时。');
  } else {
    win.loadURL(`http://127.0.0.1:${svcPort}/`);
    logLine(`已切换到工作台页面 ${Date.now() - bootT0}ms`);
  }
  createTray();
  // 静默检查更新：有新版才弹窗；失败只写日志，不打扰启动
  setTimeout(() => { checkUpdate(true); }, 5000);
});

app.on('window-all-closed', () => { /* 托盘常驻：不退出 */ });

app.on('before-quit', (event) => {
  if (quitting) { event.preventDefault(); return; }
  quitting = true;
  if (!svc) return;
  event.preventDefault();
  const service = svc;
  // 正常退出先停止后台回合并保存队列；只杀服务壳会遗留 CLI 子进程。
  fetch(`http://127.0.0.1:${svcPort}/api/shutdown`, { method: 'POST', signal: AbortSignal.timeout(12_000) })
    .catch((error) => logLine(`停止后台任务：${error.message}`))
    .finally(() => {
      if (IS_WIN && service.pid) {
        execFile('taskkill', ['/PID', String(service.pid), '/T', '/F'], { windowsHide: true }, () => app.exit(0));
      } else {
        try { service.kill(); } catch { /* 已退出 */ }
        app.exit(0);
      }
    });
});
