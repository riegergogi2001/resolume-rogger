'use strict';
// Wires renderer IPC to the OSC engine and config store.

function registerIpc({ ipcMain, engine, store, configPath, getWindow }) {
  let config = store.load(configPath);

  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:save', (_e, next) => {
    config = next;
    store.save(configPath, config);
  });
  ipcMain.on('osc:send', (_e, address, values) => engine.send(address, values));
  ipcMain.on('osc:send-typed', (_e, address, args) => engine.sendTyped(address, args));
  ipcMain.handle('osc:status:get', () => engine.status);
  ipcMain.handle('network:apply', async (_e, network) => {
    config = { ...config, network: { ...config.network, ...network } };
    store.save(configPath, config);
    engine.configure(config.network);
    await engine.open();
  });
  ipcMain.handle('osc:test', () => engine.testConnection());
  ipcMain.on('learn:arm', () => engine.armLearn());
  ipcMain.on('learn:disarm', () => engine.disarmLearn());

  engine.on('status', s => getWindow()?.webContents.send('osc:status', s));
  engine.on('message', m => getWindow()?.webContents.send('osc:message', m));
  engine.on('learn', m => getWindow()?.webContents.send('osc:learn', m));
  engine.on('error', err => getWindow()?.webContents.send('osc:error', String(err?.message ?? err)));

  return { getConfig: () => config };
}

module.exports = { registerIpc };
