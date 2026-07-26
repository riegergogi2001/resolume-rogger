'use strict';
// Wires renderer IPC to the OSC engine and config store.
const fs = require('node:fs');

function registerIpc({ ipcMain, engine, store, configPath, seedPath, getWindow }) {
  let config = store.load(configPath);

  ipcMain.handle('config:reset', async () => {
    config = (seedPath && fs.existsSync(seedPath)) ? store.load(seedPath) : store.defaults();
    store.save(configPath, config);
    engine.configure(config.network);
    if (config.network.autoConnect) await engine.open();
    return config;
  });

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

  // One-shot BPM seed for auto beat mode (changes then arrive as OSC feedback).
  ipcMain.handle('beat:seed', async () => {
    const base = `http://${config.network.targetIp}:9292/api/v1`;
    const res = await fetch(`${base}/composition`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Resolume webserver answered ${res.status}`);
    const comp = await res.json();
    return comp.tempocontroller?.tempo?.value ?? null;
  });

  // Full composition snapshot for the Visual Director's semantic model
  // (read-only REST GET — never writes to Resolume).
  ipcMain.handle('composition:inspect', async () => {
    const base = `http://${config.network.targetIp}:9292/api/v1`;
    const res = await fetch(`${base}/composition`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Resolume webserver answered ${res.status}`);
    return res.json();
  });

  // Rebuild the DJ intro page from the live composition (read-only REST GET):
  // clip names come from the name-source layer, triggers hit its group column.
  ipcMain.handle('dj:sync', async () => {
    const base = `http://${config.network.targetIp}:9292/api/v1`;
    const res = await fetch(`${base}/composition`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Resolume webserver answered ${res.status}`);
    const comp = await res.json();
    const layers = comp.layers ?? [];
    const li = layers.findIndex(L => ((L.name?.value) ?? '').toUpperCase().includes('NAME'));
    if (li === -1) throw new Error('No layer with NAME in its title');
    const layer = layers[li];
    const gi = (comp.layergroups ?? []).findIndex(g =>
      (g.layers ?? []).some(l => (l?.id ?? l) === layer.id));
    const clips = layer.clips ?? [];
    const SW = ['#00e0ff', '#ffd93d', '#2ee66b', '#b46bff', '#ff7a1a', '#3aa0ff', '#ff3df0', '#eaeef5'];
    config.fxButtons3 = config.fxButtons3.map((b, i) => {
      const cn = clips[i]?.name?.value ?? null;
      // unnamed clip slot: never clobber a customized button (e.g. LOGO OFF)
      const isPlaceholder = b.label.startsWith('#') || b.label.startsWith('3·FX');
      if (!cn && !isPlaceholder) return b;
      return {
        ...b,
        label: cn ?? `#${i + 1}`,
        icon: cn ? (cn === 'OFF' ? '✕' : '♪') : '·',
        color: cn ? (cn === 'OFF' ? '#ff4757' : SW[i % SW.length]) : '#3a3f47',
        mode: 'hold', type: 'int', value: 1, releaseValue: 0, releaseAddress: '',
        address: gi >= 0
          ? `/composition/groups/${gi + 1}/columns/${i + 1}/connect`
          : `/composition/layers/${li + 1}/clips/${i + 1}/connect`,
      };
    });
    store.save(configPath, config);
    return config;
  });
  ipcMain.on('learn:arm', () => engine.armLearn());
  ipcMain.on('learn:disarm', () => engine.disarmLearn());

  engine.on('status', s => getWindow()?.webContents.send('osc:status', s));
  engine.on('message', m => getWindow()?.webContents.send('osc:message', m));
  engine.on('learn', m => getWindow()?.webContents.send('osc:learn', m));
  engine.on('error', err => getWindow()?.webContents.send('osc:error', String(err?.message ?? err)));

  return { getConfig: () => config };
}

module.exports = { registerIpc };
