/**
 * preload.js — Bedroc Electron preload script
 *
 * Runs in the renderer process before the page loads, with access to both
 * the DOM and a limited set of Node.js APIs via contextBridge.
 *
 * Bedroc's frontend is a pure web app — it needs no Node.js APIs.
 * This preload is intentionally minimal (no contextBridge exposures).
 *
 * contextIsolation: true (set in main.js) ensures the renderer cannot
 * access Node.js or Electron APIs directly — it behaves like a normal
 * browser page.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bedrocElectron', {
    print: () => ipcRenderer.invoke('print')
});

