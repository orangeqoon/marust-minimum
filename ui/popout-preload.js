'use strict';

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('marustPopout', Object.freeze({
  toggle: (action) => {
    if (action !== 'pin' && action !== 'ghost' && action !== 'state') return Promise.resolve({ ok: false });
    return ipcRenderer.invoke('marust:popout-toggle', action);
  }
}));
