const { contextBridge, ipcRenderer } = require('electron');

/* 桌面版暴露给页面的最小能力：引用本地文件时能拿到真实绝对路径；
   pickDir 弹系统目录选择框（新开会话的工作目录用）。
   浏览器里没有这个能力，前端会退回到手动输入路径。 */
contextBridge.exposeInMainWorld('sbridgeFiles', {
  pick: () => ipcRenderer.invoke('sbridge:pick-files'),
  pickDir: () => ipcRenderer.invoke('sbridge:pick-directory'),
});

/* 面板浏览器：面板里那块区域是原生 WebContentsView（CDP 里是 type=page，
   编程工具才接管得到）。渲染进程只负责报矩形和下发命令，不直接碰页面内容。 */
contextBridge.exposeInMainWorld('sbridgeBrowser', {
  layout: (tabId, bounds) => ipcRenderer.invoke('sbridge:browser-layout', { tabId, bounds }),
  command: (tabId, action, url) => ipcRenderer.invoke('sbridge:browser-command', { tabId, action, url }),
  dispose: (tabId) => ipcRenderer.invoke('sbridge:browser-dispose', { tabId }),
  onNavigate: (cb) => { ipcRenderer.on('sbridge:browser-navigate', (_e, p) => cb(p)); },
  onTitle: (cb) => { ipcRenderer.on('sbridge:browser-title', (_e, p) => cb(p)); },
});
