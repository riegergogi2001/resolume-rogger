// Bridge to the Electron main process, with a browser mock fallback so the
// renderer can be developed and Playwright-tested without Electron.

function mockBridge() {
  window.__oscLog = [];
  let config = null;
  let learnCb = null;

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

  // Lets Playwright simulate an incoming OSC message for learn-mode tests.
  window.__emitLearn = msg => { if (learnCb) learnCb(msg); };

  return {
    platform: 'mock',
    getConfig: loadConfig,
    saveConfig: async cfg => { config = cfg; window.__savedConfig = cfg; },
    send: (address, values = []) => window.__oscLog.push({ address, values }),
    sendTyped: (address, args = []) => window.__oscLog.push({ address, args }),
    applyNetwork: async network => { window.__oscLog.push({ applyNetwork: network }); },
    testConnection: async () => ({ ok: true, detail: 'Mock bridge — no network.' }),
    armLearn: () => { window.__learnArmed = true; },
    disarmLearn: () => { window.__learnArmed = false; },
    getStatus: async () => 'ready',
    onStatus: cb => { setTimeout(() => cb('ready'), 0); return () => {}; },
    onLearn: cb => { learnCb = cb; return () => { learnCb = null; }; },
    onOscError: () => () => {},
  };
}

export const rogger = window.rogger ?? mockBridge();
