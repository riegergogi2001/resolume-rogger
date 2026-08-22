'use strict';
const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('rogger', {
  platform: 'electron',
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: cfg => ipcRenderer.invoke('config:save', cfg),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  quit: () => ipcRenderer.send('app:quit'),
  syncDjPage: () => ipcRenderer.invoke('dj:sync'),
  seedBpm: () => ipcRenderer.invoke('beat:seed'),
  send: (address, values) => ipcRenderer.send('osc:send', address, values),
  sendTyped: (address, args) => ipcRenderer.send('osc:send-typed', address, args),
  getStatus: () => ipcRenderer.invoke('osc:status:get'),
  applyNetwork: network => ipcRenderer.invoke('network:apply', network),
  testConnection: () => ipcRenderer.invoke('osc:test'),
  armLearn: () => ipcRenderer.send('learn:arm'),
  disarmLearn: () => ipcRenderer.send('learn:disarm'),
  onStatus: cb => subscribe('osc:status', cb),
  onLearn: cb => subscribe('osc:learn', cb),
  onMessage: cb => subscribe('osc:message', cb),
  onOscError: cb => subscribe('osc:error', cb),
});
