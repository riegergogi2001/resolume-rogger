'use strict';
// ROGGER shell entry point.
//
// The packaged exe is a thin shell around a swappable app payload. Everything
// interesting — main process, preload, renderer, show config — is loaded from
// whichever payload wins here, so an over-the-air update is a few hundred KB of
// JavaScript rather than an 85 MB reinstall in a load-in.
//
// This file, payload-resolve.js and payload-store.js are the only code that is
// NOT updatable. They stay small and boring on purpose: they are the floor the
// app falls back to when a payload misbehaves.
const path = require('node:path');
const { app } = require('electron');
const { resolvePayload, markHealthy } = require('./payload-resolve.js');
const store = require('./payload-store.js');

const SHELL_ROOT = app.getAppPath();
const SHELL_VERSION = app.getVersion();
const PAYLOADS_DIR = path.join(app.getPath('userData'), 'payloads');

// Safe mode: hold the shell to its bundled payload. Useful when a bad update
// has gone out and the operator needs the app up right now.
const SAFE_MODE = process.env.ROGGER_SAFE === '1' || process.argv.includes('--safe');

store.cleanScratch(PAYLOADS_DIR);

let state = store.readState(PAYLOADS_DIR);

function quarantine(version) {
  state = store.writeState(PAYLOADS_DIR, {
    ...state,
    active: null,
    attempts: 0,
    quarantine: [...state.quarantine, version],
  });
}

// Resolve and load. A payload that cannot even be required has run no code, so
// the next candidate is tried in the same boot. resolvePayload's crash-loop
// guard covers the slower failures — a payload that loads but never paints.
for (;;) {
  const choice = resolvePayload({
    bundledVersion: SHELL_VERSION,
    installed: store.listInstalled(PAYLOADS_DIR),
    state,
    safeMode: SAFE_MODE,
  });
  state = store.writeState(PAYLOADS_DIR, choice.state);

  const root = choice.source === 'ota' ? choice.dir : SHELL_ROOT;
  let entry;
  try {
    entry = require(path.join(root, 'src', 'main', 'main.js'));
    if (typeof entry?.start !== 'function') throw new Error('payload exports no start()');
  } catch (err) {
    console.error(`[bootstrap] payload ${choice.version} failed to load:`, err);
    if (choice.source === 'bundled') throw err; // nothing left to fall back to
    quarantine(choice.version);
    choice.quarantined.push(choice.version);
    continue;
  }

  try {
    entry.start({
      root,
      shellRoot: SHELL_ROOT,
      shellVersion: SHELL_VERSION,
      payloadVersion: choice.version,
      source: choice.source,
      safeMode: SAFE_MODE,
      payloadsDir: PAYLOADS_DIR,
      quarantined: choice.quarantined,
      // Called once the window has actually rendered: this boot was healthy,
      // so the crash counter goes back to zero.
      onHealthy: () => { state = store.writeState(PAYLOADS_DIR, markHealthy(state)); },
    });
  } catch (err) {
    // start() got part way in before throwing, so this process is no longer a
    // clean slate to retry in — an unhandled throw here would otherwise leave
    // Electron sitting on a modal error dialog with no window behind it, which
    // on a handheld mid-show is the worst possible outcome. Blacklist the
    // payload and restart into a fresh process instead.
    console.error(`[bootstrap] payload ${choice.version} crashed on start:`, err);
    if (choice.source === 'bundled') throw err;
    quarantine(choice.version);
    app.relaunch();
    app.exit(1);
  }
  break;
}
