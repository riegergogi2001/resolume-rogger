// Settings overlay: tabbed — Network, Controller (gamepad triggers/sticks/
// haptics), Pages (show/hide), Backup (export/import/reload default),
// About (version + inbound remote-API cheat sheet).
import { rogger } from './bridge.js';
import * as state from './state.js';
import { showToast } from './toast.js';
import { PAGE_DEFS } from './fx-grid.js';

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function field(label, input) {
  const f = h('div', 'field');
  f.append(h('label', null, label), input);
  return f;
}
function textInput(value, oninput, placeholder) {
  const i = h('input');
  i.type = 'text';
  i.value = value ?? '';
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener('input', () => oninput(i.value));
  return i;
}
function numInput(value, oninput, step = 'any') {
  const i = h('input');
  i.type = 'number';
  i.step = step;
  i.value = value ?? 0;
  i.addEventListener('input', () => oninput(Number(i.value)));
  return i;
}
function checkRow(label, on, onchange) {
  const r = h('div', 'check-row');
  const t = h('button', 'toggle');
  t.classList.toggle('on', on);
  t.addEventListener('pointerdown', () => {
    const v = !t.classList.contains('on');
    t.classList.toggle('on', v);
    onchange(v);
  });
  r.append(h('span', null, label), t);
  return r;
}
function row2(a, b) {
  const r = h('div', 'row');
  r.append(a, b);
  return r;
}
function btnRow(...btns) {
  const r = h('div', 'row');
  r.append(...btns);
  return r;
}

const TABS = ['Network', 'Controller', 'Pages', 'Backup', 'About'];

export function openSettings() {
  const root = document.getElementById('overlay-root');
  if (root.querySelector('.overlay')) return;

  const overlay = h('div', 'overlay');
  overlay.id = 'settings-overlay';
  const panel = h('div', 'panel');
  const head = h('div', 'panel-head u-caps', 'Settings');
  const tabBar = h('div', 'settings-tabs');
  const body = h('div', 'panel-body');
  const foot = h('div', 'panel-foot');
  panel.append(head, tabBar, body, foot);
  overlay.appendChild(panel);
  root.appendChild(overlay);

  function close() { overlay.remove(); }

  // Per-tab drafts: edited freely, only committed to state on that tab's
  // own Save (Pages/Backup act immediately — there's nothing to stage).
  const netDraft = { ...state.get().network };
  const triggersDraft = structuredClone(state.get().triggers ?? {});
  const sticksDraft = structuredClone(state.get().sticks ?? {});
  const hapticsDraft = structuredClone(state.get().haptics ?? { enabled: true, press: true, strobe: true });

  let currentTab = 'Network';

  function renderTabBar() {
    tabBar.innerHTML = '';
    TABS.forEach(t => {
      const b = h('button', 'settings-tab u-caps', t);
      b.classList.toggle('on', t === currentTab);
      b.addEventListener('pointerdown', () => { currentTab = t; renderTabBar(); renderTab(); });
      tabBar.appendChild(b);
    });
  }

  function renderTab() {
    body.innerHTML = '';
    if (currentTab === 'Network') renderNetwork();
    else if (currentTab === 'Controller') renderController();
    else if (currentTab === 'Pages') renderPages();
    else if (currentTab === 'Backup') renderBackup();
    else renderAbout();
  }

  // ---------------- Network ----------------
  function renderNetwork() {
    body.append(field('OSC target IP', textInput(netDraft.targetIp, v => { netDraft.targetIp = v.trim(); })));
    body.append(row2(
      field('Target port', numInput(netDraft.targetPort, v => { netDraft.targetPort = v || 7000; }, '1')),
      field('Listen port (learn / feedback)', numInput(netDraft.listenPort, v => { netDraft.listenPort = v || 7001; }, '1'))));
    body.append(checkRow('Auto connect on launch', netDraft.autoConnect, v => { netDraft.autoConnect = v; }));
    body.append(checkRow('Auto reconnect', netDraft.autoReconnect, v => { netDraft.autoReconnect = v; }));
    body.append(checkRow('Dark theme', true, () => {}));

    const testResult = h('div', 'test-result');
    const testBtn = h('button', 'big-btn u-caps', 'Test connection');
    testBtn.id = 'set-test';
    testBtn.addEventListener('pointerdown', async () => {
      testResult.textContent = 'Testing…';
      testResult.className = 'test-result';
      const { ok, detail } = await rogger.testConnection();
      testResult.textContent = detail;
      testResult.className = 'test-result ' + (ok ? 'ok' : 'fail');
    });
    body.append(btnRow(testBtn));
    body.append(testResult);

    const saveBtn = h('button', 'big-btn primary u-caps', 'Save network settings');
    saveBtn.id = 'set-net-save';
    saveBtn.addEventListener('pointerdown', async () => {
      const patch = { ...netDraft };
      state.updateNetwork(patch);
      await rogger.applyNetwork(patch);
      showToast('Network settings saved');
    });
    body.append(btnRow(saveBtn));
  }

  // ---------------- Controller ----------------
  function triggerBlock(key, title) {
    const t = triggersDraft[key] ?? (triggersDraft[key] = {});
    body.append(h('div', 'lib-group-title u-caps', title));
    body.append(checkRow('Enabled', t.enabled ?? false, v => { t.enabled = v; }));
    body.append(field('Label', textInput(t.label ?? '', v => { t.label = v; })));
    body.append(field('Analog address', textInput(t.analogAddress ?? '', v => { t.analogAddress = v; })));
    body.append(row2(
      field('From', numInput(t.from ?? 0, v => { t.from = v; })),
      field('To', numInput(t.to ?? 1, v => { t.to = v; }))));
    body.append(field('Release value', numInput(t.releaseValue ?? 0, v => { t.releaseValue = v; })));
    body.append(field('Engage address (optional)', textInput(t.engageAddress ?? '', v => { t.engageAddress = v; })));
    body.append(row2(
      field('Engage value', numInput(t.engageValue ?? 1, v => { t.engageValue = v; })),
      field('Engage release value', numInput(t.engageReleaseValue ?? 0, v => { t.engageReleaseValue = v; }))));
  }
  function stickBlock(key, title) {
    const s = sticksDraft[key] ?? (sticksDraft[key] = { x: {}, y: {} });
    s.x = s.x ?? {};
    s.y = s.y ?? {};
    body.append(h('div', 'lib-group-title u-caps', title));
    body.append(checkRow('Enabled', s.enabled ?? false, v => { s.enabled = v; }));
    body.append(field('Label', textInput(s.label ?? '', v => { s.label = v; })));
    body.append(field('X address', textInput(s.x.address ?? '', v => { s.x.address = v; })));
    body.append(row2(
      field('X center', numInput(s.x.center ?? 0.5, v => { s.x.center = v; }, '0.01')),
      field('X scale', numInput(s.x.scale ?? 0.03, v => { s.x.scale = v; }, '0.01'))));
    body.append(field('Y address', textInput(s.y.address ?? '', v => { s.y.address = v; })));
    body.append(row2(
      field('Y center', numInput(s.y.center ?? 0.5, v => { s.y.center = v; }, '0.01')),
      field('Y scale', numInput(s.y.scale ?? -0.03, v => { s.y.scale = v; }, '0.01'))));
  }
  function renderController() {
    triggerBlock('lt', 'LT');
    triggerBlock('rt', 'RT');
    stickBlock('ls', 'LS');
    stickBlock('rs', 'RS');

    body.append(h('div', 'lib-group-title u-caps', 'Haptics'));
    body.append(checkRow('Enabled', hapticsDraft.enabled ?? true, v => { hapticsDraft.enabled = v; }));
    body.append(checkRow('Press ticks', hapticsDraft.press ?? true, v => { hapticsDraft.press = v; }));
    body.append(checkRow('Strobe rumble', hapticsDraft.strobe ?? true, v => { hapticsDraft.strobe = v; }));

    const saveBtn = h('button', 'big-btn primary u-caps', 'Save');
    saveBtn.id = 'set-ctrl-save';
    saveBtn.addEventListener('pointerdown', () => {
      state.updateSection('triggers', triggersDraft);
      state.updateSection('sticks', sticksDraft);
      state.updateSection('haptics', hapticsDraft);
      showToast('Controller settings saved');
    });
    body.append(btnRow(saveBtn));
  }

  // ---------------- Pages ----------------
  function renderPages() {
    body.append(h('div', 'hint', 'Page 1 always stays visible.'));
    PAGE_DEFS.slice(1).forEach(({ label }) => {
      const hidden = new Set(state.get().ui?.hiddenPages ?? []);
      body.append(checkRow(`Show ${label}`, !hidden.has(label), v => {
        const set = new Set(state.get().ui?.hiddenPages ?? []);
        if (v) set.delete(label); else set.add(label);
        state.updateSection('ui', { ...(state.get().ui ?? {}), hiddenPages: [...set] });
        state.requestRerender();
      }));
    });
  }

  // ---------------- Backup ----------------
  function renderBackup() {
    const exportBtn = h('button', 'big-btn u-caps', 'Export config…');
    exportBtn.id = 'set-export';
    exportBtn.addEventListener('pointerdown', async () => {
      const res = await rogger.exportConfig();
      if (res?.ok) showToast(`Config exported${res.path ? ' to ' + res.path : ''}`);
      else showToast('Export canceled', { error: true });
    });
    body.append(btnRow(exportBtn));

    const importBtn = h('button', 'big-btn u-caps', 'Import config…');
    importBtn.id = 'set-import';
    importBtn.addEventListener('pointerdown', async () => {
      const cfg = await rogger.importConfig();
      if (cfg) {
        state.setAll(cfg);
        state.requestRerender();
        showToast('Config imported');
      } else {
        showToast('Import canceled', { error: true });
      }
    });
    body.append(btnRow(importBtn));
    body.append(h('div', 'hint',
      'Import merges a JSON file onto the built-in defaults — missing or foreign fields are filled in safely, never crash the app.'));

    const resetBtn = h('button', 'big-btn danger u-caps', 'Reload default mapping');
    resetBtn.id = 'set-reset';
    resetBtn.addEventListener('pointerdown', async () => {
      const cfg = await rogger.resetConfig();
      state.setAll(cfg);
      state.requestRerender();
      showToast('Default mapping restored');
    });
    body.append(btnRow(resetBtn));
  }

  // ---------------- About ----------------
  function renderAbout() {
    const versionEl = h('div', 'hint', 'Loading…');
    body.append(field('App version', versionEl));
    (rogger.getVersion ? rogger.getVersion() : Promise.resolve(null))
      .then(v => { versionEl.textContent = v ?? 'unknown'; })
      .catch(() => { versionEl.textContent = 'unknown'; });

    const n = state.get().network;
    body.append(field('OSC target', h('div', 'hint', `${n.targetIp}:${n.targetPort}`)));
    body.append(field('Listen port (also the inbound remote-API port)', h('div', 'hint', String(n.listenPort))));

    body.append(h('div', 'lib-group-title u-caps', 'Inbound remote API'));
    body.append(h('div', 'hint',
      'Send OSC to ROGGER\'s listen port above to press its own buttons/faders from Companion, grandMA3 OSC out, or anything else that speaks OSC.'));
    const cheat = document.createElement('pre');
    cheat.className = 'api-cheatsheet u-num';
    cheat.textContent = [
      '/rogger/fx/{page}/{index} [1|0]   page 1-3, index 1-based; no arg = press+release',
      '/rogger/util/{index}      [1|0]   index 1-based',
      '/rogger/fader/{index}     f        index 1-based, 0..1',
      '/rogger/gfader/{index}    f        index 1-based, 0..1',
      '/rogger/color/{index}              index 1-based, fires the preset',
      '/rogger/page              i        1-based page number',
      '/rogger/tap                        tap tempo',
      '/rogger/resync                     resync beat',
    ].join('\n');
    body.append(cheat);
  }

  const closeBtn = h('button', 'big-btn u-caps', 'Close');
  closeBtn.id = 'set-close';
  closeBtn.addEventListener('pointerdown', close);
  const exitBtn = h('button', 'big-btn danger u-caps', 'Exit app');
  exitBtn.id = 'set-exit';
  exitBtn.addEventListener('pointerdown', () => rogger.quit());
  foot.append(closeBtn, exitBtn);

  renderTabBar();
  renderTab();
}
