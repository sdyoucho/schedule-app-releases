const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  // 위젯 모드(바탕화면 고정) 전환/조회
  getMode: () => ipcRenderer.invoke('widget:get-mode'),
  toggleWidget: () => ipcRenderer.invoke('widget:toggle'),
  quit: () => ipcRenderer.invoke('app:quit'),

  // 자동 업데이트
  onUpdateReady: (cb) => ipcRenderer.on('update:ready', (_e, version) => cb(version)),
  getPendingUpdate: () => ipcRenderer.invoke('update:get-pending'),
  installUpdate: () => ipcRenderer.invoke('update:install')
});
