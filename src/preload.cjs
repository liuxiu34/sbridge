const { contextBridge, ipcRenderer } = require('electron');

/* 桌面版暴露给页面的最小能力：引用本地文件时能拿到真实绝对路径。
   浏览器里没有这个能力，前端会退回到「上传到数据目录再引用路径」。 */
contextBridge.exposeInMainWorld('sbridgeFiles', {
  pick: () => ipcRenderer.invoke('sbridge:pick-files'),
});
