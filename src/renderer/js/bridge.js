// Bridge to the Electron main process, with a browser mock fallback so the
// renderer can be developed and Playwright-tested without Electron.

function mockBridge() {
  window.__oscLog = [];
  let mockStatus = 'ready';
  let config = null;
  let learnCb = null;
  const messageCbs = new Set();
  const statusCbs = new Set();
  const listenCbs = new Set();
  let mockListen = { port: 7001, configured: 7001, fallback: false };

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
  window.__emitStatus = s => { mockStatus = s; for (const cb of statusCbs) cb(s); };
  window.__emitListen = info => { mockListen = info; for (const cb of listenCbs) cb(info); };

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
    saveConfig: async cfg => {
      if (window.__saveHang) return new Promise(() => {}); // test: a save that never returns
      config = cfg; window.__savedConfig = cfg;
    },
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
    relaunch: () => { window.__relaunchCalled = true; },
    // Update mocks: tests drive them through window.__updateInfo /
    // window.__updateResult so the Updates tab can be exercised without a
    // network or a payload directory.
    updateInfo: async () => window.__updateInfo ?? { supported: false, source: 'dev', payloadVersion: 'mock', autoCheck: true },
    updateCheck: async () => {
      window.__updateChecked = (window.__updateChecked ?? 0) + 1;
      const info = window.__updateInfo ?? { supported: false, source: 'dev', payloadVersion: 'mock', autoCheck: true };
      return { ...info, result: window.__updateResult ?? { status: 'up-to-date' } };
    },
    updateDownload: async () => {
      window.__updateDownloaded = true;
      const info = window.__updateInfo ?? {};
      const version = window.__updateResult?.version ?? '0.0.0';
      const download = window.__updateDownloadResult ?? { ok: true, version };
      if (download.ok) window.__updateInfo = { ...info, staged: version, installed: [version] };
      return { ...(window.__updateInfo ?? info), download };
    },
    updateSetAuto: async enabled => {
      window.__updateInfo = { ...(window.__updateInfo ?? {}), autoCheck: enabled };
      return window.__updateInfo;
    },
    updateReset: async () => {
      window.__updateReset = true;
      window.__updateInfo = { ...(window.__updateInfo ?? {}), staged: null, installed: [] };
      return window.__updateInfo;
    },
    openReleases: url => { window.__releasesOpened = url ?? true; },
    onUpdateProgress: cb => { window.__emitUpdateProgress = cb; return () => { window.__emitUpdateProgress = null; }; },
    syncDjPage: async () => {
      window.__djSynced = true;
      const cfg = config ?? await loadConfig();
      return { config: cfg, report: window.__djReport ?? { layer: 'MOCK NAME', group: 'MOCK', synced: 0, cleared: 0, slots: 24, named: 0, mismatches: [] } };
    },
    seedBpm: async () => 128,
    send: (address, values = []) => window.__oscLog.push({ address, values }),
    sendTyped: (address, args = []) => window.__oscLog.push({ address, args }),
    // DMX monitor in the browser: rebuilt from the sACN sends in the log.
    dmxRetain: addresses => {
      const keep = new Set((addresses ?? []).map(a => a.split('?')[0]));
      window.__oscLog = window.__oscLog.filter(m => !String(m.address ?? '').startsWith('sacn://') || keep.has(m.address.split('?')[0]));
    },
    dmxSetPreview: async on => { window.__dmxPreview = !!on; return window.__dmxPreview; },
    dmxSnapshot: async () => {
      const streams = new Map();
      for (const m of window.__oscLog) {
        const r = /^sacn:\/\/(\d+)\/(\d+)(?:\?(.*))?$/.exec(m.address ?? '');
        if (!r) continue;
        const q = new URLSearchParams(r[3] ?? '');
        const u = Number(r[1]);
        if (!streams.has(u)) streams.set(u, { proto: 'sacn', host: q.get('host') || `239.255.${u >> 8}.${u & 255}`, universe: u, iface: null, priority: 0, channels: new Map() });
        const st = streams.get(u);
        st.priority = Math.max(st.priority, Number(q.get('prio') ?? 100));
        st.channels.set(Number(r[2]), { channel: Number(r[2]), value: Number(m.args?.[0]?.value ?? 0), default: Number(q.get('default') ?? 0) });
      }
      return { preview: !!window.__dmxPreview, streams: [...streams.values()].map(s => ({ ...s, channels: [...s.channels.values()].sort((a, b) => a.channel - b.channel) })) };
    },
    applyNetwork: async network => { window.__oscLog.push({ applyNetwork: network }); },
    testConnection: async () => ({ ok: true, detail: 'Mock bridge — no network.' }),
    diagnoseLink: async () => window.__linkDiagnosis ?? {
      ok: false,
      summary: '1 of 3 legs failing: Resolume → ROGGER (feedback).',
      legs: [
        { id: 'rest', ok: true, title: 'Resolume webserver', detail: 'Mock bridge.' },
        { id: 'send', ok: true, title: 'ROGGER → Resolume', detail: 'Mock bridge.' },
        { id: 'feedback', ok: false, title: 'Resolume → ROGGER (feedback)',
          detail: 'Nothing arrived on port 7001.',
          fix: 'Resolume → Preferences → OSC → Output: set the target to 192.168.1.2:7001.' },
      ],
    },
    armLearn: () => { window.__learnArmed = true; },
    disarmLearn: () => { window.__learnArmed = false; },
    getStatus: async () => mockStatus,
    getListen: async () => mockListen,
    onListen: cb => { listenCbs.add(cb); return () => listenCbs.delete(cb); },
    onStatus: cb => {
      statusCbs.add(cb);
      setTimeout(() => cb(mockStatus), 0);
      return () => statusCbs.delete(cb);
    },
    onLearn: cb => { learnCb = cb; return () => { learnCb = null; }; },
    onMessage: cb => { messageCbs.add(cb); return () => messageCbs.delete(cb); },
    onOscError: () => () => {},
  };
}

// Guarded so pure modules that transitively import this file (e.g.
// remote-api.js, imported by test/remote-api.test.js under plain Node for
// its parseRemote() unit tests) don't crash just for lacking a `window`.
export const rogger = (typeof window !== 'undefined') ? (window.rogger ?? mockBridge()) : undefined;
