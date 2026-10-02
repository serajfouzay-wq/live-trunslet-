// Safe bridge between the control page and the desktop shell (no Node access in the page itself).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('desktop:info'),
  displays: () => ipcRenderer.invoke('desktop:displays'),
  openDisplay: (pick) => ipcRenderer.invoke('desktop:openDisplay', pick),
  closeDisplay: () => ipcRenderer.invoke('desktop:closeDisplay'),
  openDataFolder: () => ipcRenderer.invoke('desktop:openDataFolder'),
});
