// Sandboxed preload (must be CommonJS). The page gets two calls and nothing else: no Node, no token.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('photosort', {
  info: () => ipcRenderer.invoke('photosort:info'),
  setProtection: (/** @type {boolean} */ on) => ipcRenderer.invoke('photosort:set-protection', on === true),
});
