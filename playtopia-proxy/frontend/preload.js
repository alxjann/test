'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('proxyAPI', {
  /** Subscribe to backend + app events. Returns an unsubscribe function. */
  onEvent(callback) {
    const listener = (_e, ev) => callback(ev);
    ipcRenderer.on('proxy-event', listener);
    return () => ipcRenderer.removeListener('proxy-event', listener);
  },
  /** Send a bridge command (set_rule, delete_rule, clear_rules, set_paused). */
  sendCommand(cmd) {
    ipcRenderer.send('proxy-command', cmd);
  },
  getBackendStatus: () => ipcRenderer.invoke('get-backend-status'),
  restartBackend: () => ipcRenderer.invoke('restart-backend'),

  // extras used by the UI
  getRulesSchema: () => ipcRenderer.invoke('get-rules-schema'),
  getDiagnostics: () => ipcRenderer.invoke('get-diagnostics'),
  installCertificate: () => ipcRenderer.invoke('install-certificate'),
  setSystemProxy: (enabled) => ipcRenderer.invoke('set-system-proxy', enabled),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  openCertFolder: () => ipcRenderer.invoke('open-cert-folder'),
});
