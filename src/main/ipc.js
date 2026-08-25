'use strict';
// Wires renderer IPC to the OSC engine and config store.
const fs = require('node:fs');
const { Updater } = require('./updater.js');
const { buildDjButtons } = require('./dj-sync.js');

function registerIpc({ ipcMain, engine, store, configPath, seedPath, getWindow, app, dialog, shell, ctx = {} }) {
  let config = store.load(configPath);

  // OTA updates. ctx comes from the shell bootstrap; without it (dev run,
  // browser mock) there is no payload directory and the updater stays idle.
  const updater = ctx.payloadsDir
    ? new Updater({
      repo: config.updates?.repo,
      payloadsDir: ctx.payloadsDir,
      currentVersion: ctx.payloadVersion,
      shellVersion: ctx.shellVersion ?? app?.getVersion?.(),
      })
    : null;

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

  ipcMain.handle('app:version', () => app?.getVersion?.() ?? null);

  // --- OTA updates -------------------------------------------------------
  // Everything here reports rather than throws: the Updates panel wants a
  // status line, and a failed update must never take the controller down.
  const updateEnvelope = extra => ({
    supported: Boolean(updater),
    source: ctx.source ?? 'dev',
    safeMode: Boolean(ctx.safeMode),
    payloadVersion: ctx.payloadVersion ?? app?.getVersion?.() ?? null,
    shellVersion: ctx.shellVersion ?? app?.getVersion?.() ?? null,
    quarantined: ctx.quarantined ?? [],
    autoCheck: config.updates?.autoCheck !== false,
    ...(updater ? updater.info() : {}),
    ...extra,
  });

  ipcMain.handle('update:info', () => updateEnvelope());

  ipcMain.handle('update:check', async () => {
    if (!updater) return updateEnvelope({ result: { status: 'unsupported' } });
    // Pick up a repo edited in the config since launch.
    updater.repo = config.updates?.repo ?? updater.repo;
    return updateEnvelope({ result: await updater.check() });
  });

  ipcMain.handle('update:download', async () => {
    if (!updater) return updateEnvelope({ download: { ok: false, message: 'Updates are not available in this build.' } });
    const win = getWindow();
    const result = await updater.download(p => win?.webContents.send('update:progress', p));
    return updateEnvelope({ download: result });
  });

  ipcMain.handle('update:set-auto', (_e, enabled) => {
    config = { ...config, updates: { ...config.updates, autoCheck: Boolean(enabled) } };
    store.save(configPath, config);
    return updateEnvelope();
  });

  ipcMain.handle('update:reset', () => {
    updater?.resetToBundled();
    return updateEnvelope();
  });

  ipcMain.handle('update:open-releases', (_e, url) => {
    const target = typeof url === 'string' && /^https:\/\/github\.com\//.test(url)
      ? url
      : `https://github.com/${config.updates?.repo ?? ''}/releases`;
    shell?.openExternal(target);
    return target;
  });

  // Config backup/restore via native OS dialogs (desktop only — the browser
  // mock bridge has its own test-only stand-ins, see bridge.js).
  ipcMain.handle('config:export', async () => {
    if (!dialog) return { ok: false };
    const win = getWindow();
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const defaultPath = `rogger-config-${stamp}.json`;
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, { defaultPath })
      : await dialog.showSaveDialog({ defaultPath });
    if (canceled || !filePath) return { ok: false };
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
    return { ok: true, path: filePath };
  });

  ipcMain.handle('config:import', async () => {
    if (!dialog) return null;
    const win = getWindow();
    const opts = { properties: ['openFile'], filters: [{ name: 'ROGGER config', extensions: ['json'] }] };
    const { canceled, filePaths } = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (canceled || !filePaths?.length) return null;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
    } catch {
      return null; // unreadable / not JSON — leave the running config untouched
    }
    // Tolerant merge: a partial or foreign file can only add valid fields on
    // top of fresh defaults, never crash or leave the app half-configured.
    config = store.merge(parsed);
    store.save(configPath, config);
    engine.configure(config.network);
    if (config.network.autoConnect) await engine.open();
    return config;
  });

  // One-shot BPM seed for auto beat mode (changes then arrive as OSC feedback).
  ipcMain.handle('beat:seed', async () => {
    const base = `http://${config.network.targetIp}:9292/api/v1`;
    const res = await fetch(`${base}/composition`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Resolume webserver answered ${res.status}`);
    const comp = await res.json();
    return comp.tempocontroller?.tempo?.value ?? null;
  });

  // Rebuild the DJ intro page from the live composition (read-only REST GET).
  // Returns a report alongside the config so the surface can say what changed
  // and, more importantly, which columns the group's layers disagree about.
  ipcMain.handle('dj:sync', async () => {
    const base = `http://${config.network.targetIp}:9292/api/v1`;
    const res = await fetch(`${base}/composition`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Resolume webserver answered ${res.status}`);
    const comp = await res.json();
    const { buttons, report } = buildDjButtons(comp, config.fxButtons3);
    config = { ...config, fxButtons3: buttons };
    store.save(configPath, config);
    return { config, report };
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
