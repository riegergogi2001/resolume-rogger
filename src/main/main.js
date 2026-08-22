'use strict';
const { app, BrowserWindow, ipcMain, powerSaveBlocker, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { OscEngine } = require('./osc-engine.js');
const store = require('./config-store.js');
const { registerIpc } = require('./ipc.js');

const configPath = app.isPackaged
  ? path.join(app.getPath('userData'), 'config.json')
  : path.join(__dirname, '..', '..', 'config.dev.json');

const engine = new OscEngine();
let win = null;

// one instance only — a second copy would fight over the OSC listen port
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    backgroundColor: '#0a0b0d',
    // Kiosk-style on the Ally X; windowed during development.
    fullscreen: app.isPackaged && process.platform === 'win32',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.webContents.once('did-finish-load', () => {
    if (process.env.ROGGER_SMOKE) {
      console.log('SMOKE_OK');
      app.quit();
    }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  // a show controller must never let the screen sleep mid-set
  powerSaveBlocker.start('prevent-display-sleep');
  // First launch: seed the user config from the bundled show config, so the
  // packaged exe carries its addresses without any manual file copying.
  const seedPath = path.join(app.getAppPath(), 'configs', 'campus-forum-stage.json');
  if (app.isPackaged && !fs.existsSync(configPath) && fs.existsSync(seedPath)) {
    store.save(configPath, store.load(seedPath));
  }
  const api = registerIpc({ ipcMain, engine, store, configPath, seedPath, getWindow: () => win, app, dialog });
  const cfg = api.getConfig();
  engine.configure(cfg.network);
  if (cfg.network.autoConnect) engine.open();
  createWindow();
});

ipcMain.on('app:quit', () => {
  engine.close();
  app.quit();
});

app.on('window-all-closed', () => {
  engine.close();
  app.quit();
});
