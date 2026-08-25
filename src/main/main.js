'use strict';
// App payload entry point. The shell (src/bootstrap.js) picks which copy of the
// payload to load and calls start() with the resolved paths, so everything here
// addresses files through ctx.root rather than app.getAppPath() — that is what
// lets an OTA payload replace the main process, preload and renderer together.
const { app, BrowserWindow, ipcMain, powerSaveBlocker, session, dialog, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { OscEngine } = require('./osc-engine.js');
const store = require('./config-store.js');
const { registerIpc } = require('./ipc.js');
const { MIN_WIDTH, MIN_HEIGHT, DEV_WIDTH, DEV_HEIGHT } = require('../window-size.js');

function start(ctx = {}) {
  const root = ctx.root ?? path.join(__dirname, '..', '..');
  const engine = new OscEngine();
  let win = null;

  const configPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'config.json')
    : path.join(__dirname, '..', '..', 'config.dev.json');
  // Seeded from the payload, not the exe: an OTA update can ship a corrected
  // default show config along with the code that reads it.
  const seedPath = path.join(root, 'configs', 'campus-forum-stage.json');

  // one instance only — a second copy would fight over the OSC listen port
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  function createWindow() {
    win = new BrowserWindow({
      width: DEV_WIDTH,
      height: DEV_HEIGHT,
      // Hard floor, not a suggestion: below this the chrome would have to
      // shrink or truncate itself, which this surface never does.
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      backgroundColor: '#0a0b0d',
      // Kiosk-style on the Ally X; windowed during development.
      fullscreen: app.isPackaged && process.platform === 'win32',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(root, 'src', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.loadFile(path.join(root, 'src', 'renderer', 'index.html'));
    win.webContents.once('did-finish-load', () => {
      // The window painted, so this payload is healthy: clear the crash counter
      // before anything else can go wrong.
      ctx.onHealthy?.();
      if (process.env.ROGGER_SMOKE) {
        console.log(`SMOKE_OK payload=${ctx.payloadVersion ?? 'dev'} source=${ctx.source ?? 'dev'}`);
        app.quit();
      }
    });
    win.on('closed', () => { win = null; });
  }

  app.whenReady().then(() => {
    // a show controller must never let the screen sleep mid-set
    powerSaveBlocker.start('prevent-display-sleep');
    // the BPM page needs mic/line-in access (Web Audio getUserMedia); this is
    // a single-purpose kiosk app so grant 'media' outright instead of prompting
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
      cb(permission === 'media');
    });
    session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');
    // First launch: seed the user config from the bundled show config, so the
    // packaged exe carries its addresses without any manual file copying.
    if (app.isPackaged && !fs.existsSync(configPath) && fs.existsSync(seedPath)) {
      store.save(configPath, store.load(seedPath));
    }
    const api = registerIpc({
      ipcMain, engine, store, configPath, seedPath, getWindow: () => win, app, dialog, shell, ctx,
    });
    const cfg = api.getConfig();
    engine.configure(cfg.network);
    if (cfg.network.autoConnect) engine.open();
    createWindow();
  });

  ipcMain.on('app:quit', () => {
    engine.close();
    app.quit();
  });

  // Restart into whichever payload the shell resolves next — how an OTA update
  // is applied without the operator hunting for the exe.
  ipcMain.on('app:relaunch', () => {
    engine.close();
    app.relaunch();
    app.exit(0);
  });

  app.on('window-all-closed', () => {
    engine.close();
    app.quit();
  });
}

module.exports = { start };

// Running `electron src/main/main.js` directly (no shell) still works for
// quick manual checks.
if (require.main === module) start();
