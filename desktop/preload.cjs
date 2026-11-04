const { contextBridge, ipcRenderer } = require('electron');

// Expose domain operations only; the renderer never receives ipcRenderer, Node,
// filesystem access, arbitrary channels, or a path for native file writes.
contextBridge.exposeInMainWorld('desktop', {
  request: (path, data) => ipcRenderer.invoke('obu:request', path, data),
  subscribe: callback => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('obu:event', listener);
    ipcRenderer.invoke('obu:subscribe').catch(error => callback({ event: 'offline', data: error.message }));
    return () => ipcRenderer.removeListener('obu:event', listener);
  },
  exportSession: id => ipcRenderer.invoke('obu:export', id),
  openExtensionDirectory: () => ipcRenderer.invoke('obu:extension-directory'),
});
