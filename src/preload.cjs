const { contextBridge, ipcRenderer } = require('electron');

/* 桌面版暴露给页面的最小能力：引用本地文件时能拿到真实绝对路径；
   pickDir 弹系统目录选择框（新开会话的工作目录用）。
   浏览器里没有这个能力，前端会退回到手动输入路径。 */
contextBridge.exposeInMainWorld('sbridgeFiles', {
  pick: () => ipcRenderer.invoke('sbridge:pick-files'),
  pickDir: () => ipcRenderer.invoke('sbridge:pick-directory'),
});
