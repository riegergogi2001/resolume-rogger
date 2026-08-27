'use strict';
// App payload entry point. The shell (src/bootstrap.js) picks which copy of the
// payload to load and calls start() with the resolved paths, so everything here
// addresses files through ctx.root rather than app.getAppPath() — that is what
// lets an OTA payload replace the main process, preload and renderer together.
const { app, BrowserWindow, ipcMain, powerSaveBlocker, session, dialog, shell, screen } = require('electron');
const { relaunchOptions } = require('./relaunch.js');
const fs = require('node:fs');
const path = require('node:path');
const { OscEngine } = require('./osc-engine.js');
const store = require('./config-store.js');
const { registerIpc } = require('./ipc.js');
const { DEV_WIDTH, DEV_HEIGHT, fitZoom, fitFloor } = require('../window-size.js');

function start(ctx = {}) {
  const root = ctx.root ?? path.join(__dirname, '..', '..');
  const engine = new OscEngine();
  let win = null;

  const configPath = app.isPackaged
    ? path.join(app.getPath('userData'), 'config.json')
    : path.join(__dirname, '..', '..', 'config.dev.json');
  // Seeded from the payload, not the exe: an OTA update can ship a corrected
  // default show config along with the code that reads it.
  const seedPath = path.join(root, 'configs', 'show.json');

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

  // Kiosk-style on the Ally X; windowed during development.
  const kiosk = app.isPackaged && process.platform === 'win32';

  // The surface is drawn in CSS pixels and never adapts, but Electron sizes
  // windows in DIPs, and on the Ally X (150% Windows scaling by default) the
  // whole 1920x1080 panel is only 1280x720 DIP — less than the floor, so the
  // right and bottom of the surface used to fall off the screen. Zoom the page
  // out until the floor fits the display it is on; on the Ally that is within a
  // few percent of one CSS pixel per panel pixel, which is what it was drawn for.
  // Layout audits force a content size in CSS px and measure it, so they run
  // unzoomed — otherwise the size they report would not be the size they saw.
  function displayZoom() {
    if (process.env.ROGGER_LAYOUT_AUDIT) return 1;
    const display = screen.getPrimaryDisplay();
    const area = kiosk ? display.size : display.workAreaSize;
    return fitZoom(area?.width, area?.height);
  }

  function createWindow() {
    let zoom = displayZoom();
    const floor = fitFloor(zoom);
    win = new BrowserWindow({
      width: DEV_WIDTH,
      height: DEV_HEIGHT,
      // Hard floor, not a suggestion: below this the chrome would have to
      // shrink or truncate itself, which this surface never does. Expressed
      // in DIPs at the zoom that makes it fit the display.
      minWidth: floor.minWidth,
      minHeight: floor.minHeight,
      backgroundColor: '#0a0b0d',
      // Size the CONTENT, not the frame. Without this the title bar eats into
      // the surface: a 1000px window gave the layout 968px and the FX labels
      // on Page 2 were clipped by 4px, below the floor this app declares.
      useContentSize: true,
      fullscreen: kiosk,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(root, 'src', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        zoomFactor: zoom,
      },
    });
    win.loadFile(path.join(root, 'src', 'renderer', 'index.html'));
    // Chromium remembers a zoom per origin, so state it on every load rather
    // than trusting the default above to survive.
    win.webContents.on('did-finish-load', () => { win?.webContents.setZoomFactor(zoom); });
    // Panel mode changed under a running app (Armoury Crate 1080p <-> 720p,
    // a scaling change): re-fit instead of leaving part of the surface offscreen.
    const refit = () => {
      if (!win) return;
      const next = displayZoom();
      if (next === zoom) return;
      zoom = next;
      const f = fitFloor(zoom);
      win.setMinimumSize(f.minWidth, f.minHeight);
      win.webContents.setZoomFactor(zoom);
    };
    screen.on('display-metrics-changed', refit);
    screen.on('display-added', refit);
    screen.on('display-removed', refit);
    win.webContents.once('did-finish-load', () => {
      // The window painted, so this payload is healthy: clear the crash counter
      // before anything else can go wrong.
      ctx.onHealthy?.();
      if (process.env.ROGGER_SMOKE) {
        console.log(`SMOKE_OK payload=${ctx.payloadVersion ?? 'dev'} source=${ctx.source ?? 'dev'}`);
        app.quit();
      }
      // Layout audit in the real app: real fonts, real window size, the
      // operator's own config. A browser check cannot see any of those, and
      // font fallback alone changes every text measurement.
      if (process.env.ROGGER_LAYOUT_AUDIT) {
        const forced = /^(\d+)x(\d+)$/.exec(process.env.ROGGER_LAYOUT_AUDIT);
        if (forced) win.setContentSize(Number(forced[1]), Number(forced[2]));
        runLayoutAudit(win).then(() => app.quit()).catch(err => {
          console.error('LAYOUT_AUDIT_ERROR', err?.message ?? err);
          app.quit();
        });
      }
    });
    win.on('closed', () => {
      win = null;
      screen.removeListener('display-metrics-changed', refit);
      screen.removeListener('display-added', refit);
      screen.removeListener('display-removed', refit);
    });
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

  function closeEngine(why) {
    try { engine.close(); } catch (err) { console.error(`engine.close on ${why}:`, err); }
  }

  ipcMain.on('app:quit', () => {
    closeEngine('quit');
    app.quit();
    // The operator asked for it: a quit that does not complete (a window
    // refusing to close, a stuck renderer) must still take the app down.
    setTimeout(() => app.exit(0), 2000);
  });

  // Restart into whichever payload the shell resolves next — how an OTA update
  // is applied without the operator hunting for the exe. On the portable exe
  // the relaunch has to target the real exe, not the unpacked temp copy.
  ipcMain.on('app:relaunch', () => {
    closeEngine('relaunch');
    app.relaunch(relaunchOptions(process.env));
    app.exit(0);
  });

  app.on('window-all-closed', () => {
    closeEngine('window-all-closed');
    app.quit();
  });
}


// Walks every page and overlay in the live window and reports any text that
// does not fit its box. Driven by tools/audit-layout.js.
async function runLayoutAudit(win) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const scan = label => win.webContents.executeJavaScript(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      // A form field's content is its value, not its textContent — setting
      // .value from JS leaves textContent empty, so reading the wrong one
      // skips every input and textarea in the app.
      const isField = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
      const text = isField ? (el.value || '').trim() : (el.textContent || '').trim();
      if (!text) continue;
      if (!isField && [...el.children].some(c => (c.textContent || '').trim() === text)) continue;
      const dx = el.scrollWidth - el.clientWidth;
      const dy = el.scrollHeight - el.clientHeight;
      const cutX = dx > 1 && cs.overflowX !== 'visible';
      const cutY = dy > 1 && cs.overflowY !== 'visible' && !/auto|scroll/.test(cs.overflowY);
      const cls = typeof el.className === 'string' && el.className
        ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
      // Text the same colour as what it sits on is as good as missing, and it
      // happens silently whenever an element misses the colour-inheritance
      // rule. Walk up for the first painted background to compare against.
      const lum = c => {
        const m = /rgba?\\(([^)]+)\\)/.exec(c);
        if (!m) return null;
        const [rr, gg, bb] = m[1].split(',').map(Number);
        const f = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(rr) + 0.7152 * f(gg) + 0.0722 * f(bb);
      };
      let bgEl = el, bg = null;
      while (bgEl && !bg) {
        const c = getComputedStyle(bgEl).backgroundColor;
        if (c && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) bg = c;
        bgEl = bgEl.parentElement;
      }
      const lf = lum(cs.color);
      const lb = bg == null ? null : lum(bg);
      if (lf != null && lb != null) {
        const ratio = (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
        if (ratio < 1.6) {
          out.push({
            text: text.slice(0, 40),
            sel: el.tagName.toLowerCase() + cls,
            dx: 0, dy: 0,
            box: 'contrast ' + ratio.toFixed(2) + ':1  ' + cs.color + ' on ' + bg,
            font: cs.fontFamily.split(',')[0] + ' ' + cs.fontSize,
          });
          continue;
        }
      }
      if (!cutX && !cutY) continue;
      out.push({
        text: text.slice(0, 40),
        sel: el.tagName.toLowerCase() + cls,
        dx, dy,
        box: Math.round(r.width) + 'x' + Math.round(r.height),
        font: cs.fontFamily.split(',')[0] + ' ' + cs.fontSize,
      });
    }
    const body = document.body;
    return { out, wide: body.scrollWidth - window.innerWidth, tall: body.scrollHeight - window.innerHeight };
  })()`).then(res => {
    for (const f of res.out) {
      console.log(`LAYOUT_CUT [${label}] "${f.text}" ${f.sel} box=${f.box} cutX=${f.dx} cutY=${f.dy} font=${f.font}`);
    }
    if (res.wide > 1) console.log(`LAYOUT_CUT [${label}] page scrolls horizontally by ${res.wide}px`);
    if (res.tall > 1) console.log(`LAYOUT_CUT [${label}] page scrolls vertically by ${res.tall}px`);
    return res.out.length + (res.wide > 1 ? 1 : 0) + (res.tall > 1 ? 1 : 0);
  });

  const [w, h] = win.getContentSize();
  const resolved = await win.webContents.executeJavaScript(
    "getComputedStyle(document.body).fontFamily + ' -> ' + (document.fonts.check('12px Inter') ? 'Inter available' : 'Inter MISSING, falling back')");
  console.log(`LAYOUT_AUDIT window=${w}x${h} font=${resolved}`);

  let total = 0;
  const tabs = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('#fx-grid .page-tab')].map(t => t.textContent.trim())");
  for (let i = 0; i < tabs.length; i += 1) {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('#fx-grid .page-tab')[${i}].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await wait(300);
    total += await scan(tabs[i]);
  }
  await win.webContents.executeJavaScript(
    "document.querySelectorAll('#fx-grid .page-tab')[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
  await wait(200);

  // Editors live behind edit mode, and they hold the densest chrome in the
  // app — the macro rows, the multi-line address fields. Walk those too.
  const tap = sel => win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return false;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return true; })()`);
  const closeOverlay = () => win.webContents.executeJavaScript(
    "document.querySelector('.overlay')?.remove(), true");

  await tap('#edit-toggle');
  await wait(300);
  total += await scan('edit mode');
  for (const [sel, label] of [
    ['#fx-grid .fx-btn', 'FX button editor'],
    ['#fader-rack .fader-track', 'fader editor'],   // the track owns the edit tap
    ['#color-row .color-btn', 'colour preset editor'],
    ['#color-row .target-pick', 'colour target editor'],
  ]) {
    if (!await tap(sel)) continue;
    await wait(450);
    total += await scan(label);
    await closeOverlay();
    await wait(150);
  }
  await tap('#edit-toggle');
  await wait(250);

  await win.webContents.executeJavaScript(
    "document.getElementById('settings-open').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
  await wait(400);
  const stabs = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('#settings-overlay .settings-tab')].map(t => t.textContent.trim())");
  for (let i = 0; i < stabs.length; i += 1) {
    await win.webContents.executeJavaScript(
      `document.querySelectorAll('#settings-overlay .settings-tab')[${i}].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await wait(400);
    total += await scan('settings ' + stabs[i]);
  }
  console.log(`LAYOUT_AUDIT_DONE ${total} problem(s)`);
}

module.exports = { start };

// Running `electron src/main/main.js` directly (no shell) still works for
// quick manual checks.
if (require.main === module) start();
