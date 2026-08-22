// Bridge to the Electron main process, with a browser mock fallback so the
// renderer can be developed and Playwright-tested without Electron.

function mockBridge() {
  window.__oscLog = [];
  let config = null;
  let learnCb = null;
  const messageCbs = new Set();

  const fallbackConfig = { version: 1,
    network: { targetIp: '192.168.1.100', targetPort: 7000, listenPort: 7001, autoConnect: true, autoReconnect: true },
    ui: { theme: 'dark' },
    fxButtons: [], faders: [], colorButtons: [] };

  async function loadConfig() {
    if (config) return config;
    try {
      const res = await fetch('/__defaults');
      config = await res.json();
    } catch {
      config = fallbackConfig;
    }
    return config;
  }

  // Let Playwright simulate incoming OSC (learn + feedback tests).
  window.__emitLearn = msg => { if (learnCb) learnCb(msg); };
  window.__emitOscIn = msg => { for (const cb of messageCbs) cb(msg); };

  // Minimal deep-merge for the mock config:import — mirrors config-store's
  // shape-preserving merge closely enough for UI tests (array-of-objects
  // merged by index, plain objects merged key-wise, everything else wins).
  function mockMerge(base, patch) {
    if (Array.isArray(base)) {
      if (!Array.isArray(patch)) return base;
      return base.map((b, i) => (patch[i] && typeof patch[i] === 'object') ? mockMerge(b, patch[i]) : b);
    }
    if (base && typeof base === 'object' && patch && typeof patch === 'object' && !Array.isArray(patch)) {
      const out = { ...base };
      for (const k of Object.keys(patch)) out[k] = mockMerge(base[k], patch[k]);
      return out;
    }
    return patch === undefined ? base : patch;
  }

  return {
    platform: 'mock',
    getConfig: loadConfig,
    saveConfig: async cfg => { config = cfg; window.__savedConfig = cfg; },
    resetConfig: async () => { config = null; window.__savedConfig = null; return loadConfig(); },
    // Real bridge opens a native save dialog; the mock just records what
    // *would* have been written so Playwright can assert on it.
    exportConfig: async () => {
      const cfg = config ?? await loadConfig();
      window.__exportedConfig = JSON.stringify(cfg, null, 2);
      return { ok: true, path: 'mock://export.json' };
    },
    // Real bridge opens a native open dialog; the mock has no file picker,
    // so tests supply the JSON directly (as an argument, or via
    // window.__importJson set beforehand) — either way it's merged onto the
    // current config exactly like the desktop import path.
    importConfig: async json => {
      const raw = json ?? window.__importJson;
      if (!raw) return null; // no dialog available in browser mode
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return null; }
      const cfg = config ?? await loadConfig();
      config = mockMerge(cfg, parsed);
      window.__savedConfig = config;
      return config;
    },
    getVersion: async () => 'mock',
    quit: () => { window.__quitCalled = true; },
    syncDjPage: async () => { window.__djSynced = true; return config ?? loadConfig(); },
    seedBpm: async () => 128,
    send: (address, values = []) => window.__oscLog.push({ address, values }),
    sendTyped: (address, args = []) => window.__oscLog.push({ address, args }),
    applyNetwork: async network => { window.__oscLog.push({ applyNetwork: network }); },
    testConnection: async () => ({ ok: true, detail: 'Mock bridge — no network.' }),
    armLearn: () => { window.__learnArmed = true; },
    disarmLearn: () => { window.__learnArmed = false; },
    getStatus: async () => 'ready',
    onStatus: cb => { setTimeout(() => cb('ready'), 0); return () => {}; },
    onLearn: cb => { learnCb = cb; return () => { learnCb = null; }; },
    onMessage: cb => { messageCbs.add(cb); return () => messageCbs.delete(cb); },
    onOscError: () => () => {},
  };
}

// Guarded so pure modules that transitively import this file (e.g.
// remote-api.js, imported by test/remote-api.test.js under plain Node for
// its parseRemote() unit tests) don't crash just for lacking a `window`.
export const rogger = (typeof window !== 'undefined') ? (window.rogger ?? mockBridge()) : undefined;
