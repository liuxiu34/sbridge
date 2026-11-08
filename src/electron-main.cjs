const { app, BrowserWindow, Tray, Menu, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
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
// 服务 exe：打包后在 resources/sbridge/，开发时在项目 dist/
const svcExe = isPackaged
  ? path.join(process.resourcesPath, 'sbridge', 'sbridge.exe')
  : path.join(__dirname, '..', 'dist', 'sbridge.exe');

/* 启动闪屏：先出窗口再等后端，避免双击后 1-2 秒没有任何反应 */
const SPLASH_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
html,body{height:100%;margin:0}
body{display:grid;place-items:center;background:#f4f7f5;color:#191a1d;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{display:flex;flex-direction:column;align-items:center;gap:12px}
.logo{width:52px;height:52px;border-radius:14px;background:#4b47e0;color:#fff;
  display:grid;place-items:center;font-weight:700;font-size:18px;letter-spacing:.5px}
.name{font-size:15px;font-weight:600}
.tip{font-size:12px;color:#71727b}
.bar{width:180px;height:3px;border-radius:2px;background:#e7e7ec;overflow:hidden}
.bar i{display:block;height:100%;width:40%;background:#4b47e0;border-radius:2px;
  animation:slide 1.1s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}
</style></head><body><div class="wrap">
<div class="logo">sb</div><div class="name">sbridge</div>
<div class="tip">正在启动工作台…</div><div class="bar"><i></i></div>
</div></body></html>`);

function logLine(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'shell.log'), line + '\n'); } catch { /* ignore */ }
}

function startService() {
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
    },
  });
  svc.stdout.on('data', (d) => logLine(`[svc] ${String(d).trim()}`));
  svc.stderr.on('data', (d) => logLine(`[svc:err] ${String(d).trim()}`));
  svc.on('exit', (code) => {
    logLine(`服务退出 code=${code}`);
    svc = null;
    if (!quitting && win) {
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

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#f4f7f5',
    title: 'sbridge · 会话接力工作台',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
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
  tray = new Tray(path.join(__dirname, 'icon.ico'));
  const menu = Menu.buildFromTemplate([
    { label: '显示工作台', click: () => { win ? win.show() : createWindow(); } },
    { label: '服务状态：运行中', enabled: false },
    { type: 'separator' },
    { label: '开机自动启动', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked, path: process.execPath }); } },
    { type: 'separator' },
    { label: '退出 sbridge', click: () => { quitting = true; app.quit(); } },
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
});

app.on('window-all-closed', () => { /* 托盘常驻：不退出 */ });

app.on('before-quit', () => {
  quitting = true;
  if (svc) { try { svc.kill(); } catch { /* ignore */ } }
});
