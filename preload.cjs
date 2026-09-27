const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopBridge', {
  togglePin: () => ipcRenderer.invoke('desktop:toggle-pin'),
});
