// The tab strip's only bridge to the main process. Web pages never load this.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabStrip', {
  ready: () => ipcRenderer.send('strip:ready'),
  activate: id => ipcRenderer.send('strip:activate', id),
  close: id => ipcRenderer.send('strip:close', id),
  newTab: () => ipcRenderer.send('strip:new'),
  toggleShield: () => ipcRenderer.send('strip:shield'),
  onState: fn => ipcRenderer.on('strip:state', (_e, state) => fn(state)),
});
