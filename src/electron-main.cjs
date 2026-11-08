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

const isPackaged = app.isPackaged;
// 服务 exe：打包后在 resources/sbridge/，开发时在项目 dist/
const svcExe = isPackaged
  ? path.join(process.resourcesPath, 'sbridge', 'sbridge.exe')
  : path.join(__dirname, '..', 'dist', 'sbridge.exe');

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

function waitForService(tries = 40) {
  return new Promise((resolve) => {
    const tick = async (n) => {
      try {
        const res = await fetch(`http://127.0.0.1:${svcPort}/api/terms`);
        if (res.ok) return resolve(true);
      } catch { /* not ready */ }
      if (n <= 0) return resolve(false);
      setTimeout(() => tick(n - 1), 250);
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.loadURL(`http://127.0.0.1:${svcPort}/`);
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

  startService();
  const ready = await waitForService();
  if (!ready) dialog.showErrorBox('sbridge', '后端服务启动超时。');
  createWindow();
  createTray();
});

app.on('window-all-closed', () => { /* 托盘常驻：不退出 */ });

app.on('before-quit', () => {
  quitting = true;
  if (svc) { try { svc.kill(); } catch { /* ignore */ } }
});
