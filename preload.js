const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('api', {
  savePng: (dataUrl, name) => ipcRenderer.invoke('png:save', { dataUrl, name }),
  saveProject: (json, name) => ipcRenderer.invoke('project:save', { json, name }),
  openProject: () => ipcRenderer.invoke('project:open')
})
