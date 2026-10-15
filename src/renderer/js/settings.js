// Settings overlay: tabbed — Network, Controller (gamepad triggers/sticks/
// haptics), Pages (show/hide), Updates (over-the-air payload updates),
// Backup (export/import/reload default), About (version + inbound remote-API
// cheat sheet).
import { rogger } from './bridge.js';
import * as state from './state.js';
import { showToast } from './toast.js';
import { confirmDialog } from './dialog.js';
import { PAGE_DEFS } from './fx-grid.js';
import { h, field, textInput, numInput, checkRow, row2, btnRow } from './dom.js';
import { renderUpdates } from './updates.js';
import { openEditor } from './editor.js';
import { BUTTON_NAMES } from './gamepad.js';
import { bindingLabel } from './gamepad-resolve.js';
import * as safety from './safety.js';

const TABS = ['Network', 'Controller', 'Safety', 'DMX', 'Pages', 'Updates', 'Backup', 'About'];

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

  function close() {
    for (const c of pendingArms) c();
    offStatus?.();
    offSafety?.();
    clearInterval(monitorTimer);
    overlay.remove();
  }

  // Per-tab drafts: edited freely, only committed to state on that tab's
  // own Save (Pages/Backup act immediately — there's nothing to stage).
  const netDraft = { ...state.get().network };
  const triggersDraft = structuredClone(state.get().triggers ?? {});
  const sticksDraft = structuredClone(state.get().sticks ?? {});
  const hapticsDraft = structuredClone(state.get().haptics ?? { enabled: true, press: true, strobe: true });

  let currentTab = 'Network';
  const pendingArms = new Set(); // HOLD TO ARM timers in progress die with the tab that started them
  // Kept current so the Updates tab can refuse to restart mid-cue.
  let lastOscStatus = 'offline';
  rogger.getStatus?.().then(v => { lastOscStatus = v ?? 'offline'; }).catch(() => {});
  const offStatus = rogger.onStatus?.(v => { lastOscStatus = v; });

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
    for (const c of pendingArms) c();
    pendingArms.clear();
    clearInterval(monitorTimer);
    monitorTimer = null;
    body.innerHTML = '';
    if (currentTab === 'Network') renderNetwork();
    else if (currentTab === 'Controller') renderController();
    else if (currentTab === 'Safety') renderSafety();
    else if (currentTab === 'DMX') renderDmx();
    else if (currentTab === 'Pages') renderPages();
    else if (currentTab === 'Updates') renderUpdates(body, { oscStatus: () => lastOscStatus });
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

    // The link has three independent legs and each fails on its own, so the
    // test reports them separately. Feedback is the one that dies quietly.
    const testResult = h('div', 'link-legs');
    testResult.id = 'set-test-result';
    const testBtn = h('button', 'big-btn u-caps', 'Test connection');
    testBtn.id = 'set-test';
    testBtn.addEventListener('click', async () => {
      if (testBtn.disabled) return;
      testBtn.disabled = true;
      testResult.innerHTML = '';
      testResult.append(h('div', 'test-result', 'Checking webserver, commands and feedback…'));
      try {
        const result = await rogger.diagnoseLink();
        testResult.innerHTML = '';
        testResult.append(h('div', 'test-result ' + (result.ok ? 'ok' : 'fail'), result.summary));
        for (const leg of result.legs ?? []) {
          const row = h('div', 'link-leg' + (leg.ok ? ' ok' : ' fail'));
          row.append(h('div', 'link-leg-head u-caps', `${leg.ok ? '✓' : '✕'}  ${leg.title}`));
          row.append(h('div', 'link-leg-detail', leg.detail));
          if (!leg.ok && leg.fix) row.append(h('div', 'link-leg-fix', leg.fix));
          testResult.append(row);
        }
      } catch (err) {
        testResult.innerHTML = '';
        testResult.append(h('div', 'test-result fail', `Test failed: ${err?.message ?? err}`));
      } finally {
        testBtn.disabled = false;
      }
    });
    body.append(btnRow(testBtn));
    body.append(testResult);

    const saveBtn = h('button', 'big-btn primary u-caps', 'Save network settings');
    saveBtn.id = 'set-net-save';
    saveBtn.addEventListener('click', async () => {
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
    saveBtn.addEventListener('click', () => {
      state.updateSection('triggers', triggersDraft);
      state.updateSection('sticks', sticksDraft);
      state.updateSection('haptics', hapticsDraft);
      showToast('Controller settings saved');
    });
    body.append(btnRow(saveBtn));
  }

  // ---------------- Pages ----------------
  // ---------------- Safety ----------------
  // Safety switches (arm channels of CO2 / spark machines) and PANIC. Entries
  // are edited in the normal button editor (label, DMX address, values, mode,
  // controller button); this tab lists, arms, adds and deletes them.
  function renderSafety() {
    const cfg = state.get();
    const list = cfg.safeties ?? [];
    const panicBtn = h('button', 'big-btn u-caps safety-panic', 'PANIC — all SAFE');
    panicBtn.id = 'safety-panic';
    panicBtn.addEventListener('click', () => {
      safety.panic(state.get(), rogger);
      showToast('PANIC — all safeties SAFE, every DMX button at default', { error: true });
    });
    const panicEdit = h('button', 'big-btn u-caps', `Panic controller button: ${bindingLabel(BUTTON_NAMES, cfg.panicButtons?.[0]?.gamepadButton ?? -1, cfg.panicButtons?.[0]?.gamepadModifier ?? -1) || 'none'}`);
    panicEdit.id = 'safety-panic-edit';
    panicEdit.addEventListener('click', () => { close(); openEditor('panicButtons', 0); });
    body.append(btnRow(panicBtn, panicEdit));

    if (!list.length) body.append(h('div', 'hint', 'No safety switches yet. A safety is the arm channel of a CO2 jet or spark machine: SAFE at launch, ARMED only when you arm it, and the DMX buttons linked to it cannot fire while it is SAFE.'));
    list.forEach((s, i) => {
      const row = h('div', 'safety-row');
      row.dataset.id = s.id;
      const info = h('div', 'safety-info');
      const pad = bindingLabel(BUTTON_NAMES, s.gamepadButton, s.gamepadModifier);
      const linked = ['fxButtons', 'fxButtons2', 'fxButtons3', 'utilButtons']
        .flatMap(k => cfg[k] ?? []).filter(b => b.output === 'sacn' && b.sacn?.safety === s.id).map(b => b.label);
      info.append(h('div', 'safety-label u-caps', s.label),
        h('div', 'safety-meta u-num', `${safety.safetyChannels(s).map(([u, c]) => `U${u}/${c}`).join(' ')} · ARMED ${s.armedValue} / SAFE ${s.safeValue} · ${s.mode.toUpperCase()}${s.twoHand ? ' · TWO-HAND' : ''}${pad ? ' · ' + pad : ''}`),
        h('div', 'safety-meta', linked.length ? `Locks: ${linked.join(', ')}` : 'No buttons linked yet (button editor → Safety)'));
      const arm = h('button', 'big-btn u-caps safety-arm');
      const paint = () => {
        const on = safety.isArmed(s.id);
        arm.textContent = on ? 'ARMED' : 'SAFE';
        arm.classList.toggle('armed', on);
      };
      paint();
      if (s.unsaved) {
        arm.textContent = 'NOT SAVED';
        arm.disabled = true;
      } else if (s.twoHand && !safety.isArmed(s.id)) {
        // two-hand safety from the touch screen: hold-to-arm for the same time
        arm.textContent = 'HOLD TO ARM';
        let t = null;
        pendingArms.add(() => { if (t) { clearTimeout(t); t = null; } });
        arm.addEventListener('pointerdown', () => {
          arm.classList.add('arming');
          t = setTimeout(() => { t = null; safety.setArmed(s.id, true, state.get(), rogger); }, Math.max(200, Number(s.armHoldMs) || 1000));
        });
        const cancel = () => { arm.classList.remove('arming'); if (t) { clearTimeout(t); t = null; } };
        arm.addEventListener('pointerup', cancel);
        arm.addEventListener('pointerleave', cancel);
        arm.addEventListener('pointercancel', cancel);
      } else {
        arm.addEventListener('click', () => { safety.toggle(s.id, state.get(), rogger); });
      }
      const edit = h('button', 'big-btn u-caps', 'Edit');
      edit.addEventListener('click', () => { close(); openEditor('safeties', i); });
      const del = h('button', 'big-btn u-caps', 'Delete');
      del.addEventListener('click', async () => {
        if (!(await confirmDialog(`Delete ${s.label}? Linked buttons are unlocked from it.`))) return;
        safety.retire(s.id, state.get(), rogger);
        const next = structuredClone(state.get());
        for (const k of ['fxButtons', 'fxButtons2', 'fxButtons3', 'utilButtons']) {
          for (const b of next[k] ?? []) if (b.sacn?.safety === s.id) b.sacn.safety = '';
          state.replaceList(k, next[k]);
        }
        state.replaceList('safeties', next.safeties.filter(x => x.id !== s.id));
        state.requestRerender();
        renderTab();
      });
      row.append(info, arm, edit, del);
      body.append(row);
    });
    const add = h('button', 'big-btn primary u-caps', 'Add safety');
    add.id = 'safety-add';
    add.addEventListener('click', () => {
      const next = [...(state.get().safeties ?? []), safety.newSafety(state.get().safeties ?? [])];
      state.replaceList('safeties', next); // nothing goes out until its address is saved
      state.requestRerender(); // gamepad handle offsets move
      close();
      openEditor('safeties', next.length - 1);
    });
    body.append(btnRow(add));
  }
  const offSafety = safety.onChange(() => { if (currentTab === 'Safety') renderTab(); });

  // ---------------- DMX ----------------
  // Preview switch + live monitor of everything ROGGER sends as DMX.
  let monitorTimer = null;
  function renderDmx() {
    body.append(checkRow('Preview mode — sACN goes out flagged as preview: visualisers show it, E1.31-compliant fixtures ignore it (check your nodes before trusting it with CO2)',
      safety.previewOn(), async v => { await safety.setPreview(v, rogger); }));
    body.append(h('div', 'hint', 'Preview is off at every launch. While it is on the topbar says PREVIEW in amber.'));
    const mon = h('div', 'dmx-monitor');
    mon.id = 'dmx-monitor';
    body.append(mon);
    const names = () => {
      const map = new Map();
      const cfg = state.get();
      for (const k of ['fxButtons', 'fxButtons2', 'fxButtons3', 'utilButtons']) {
        for (const b of cfg[k] ?? []) if (b.output === 'sacn') map.set(`${b.sacn.universe}/${b.sacn.channel}`, b.label);
      }
      for (const s of cfg.safeties ?? []) for (const [u, c] of safety.safetyChannels(s)) map.set(`${u}/${c}`, `${s.label} (safety)`);
      return map;
    };
    async function paint() {
      const snap = await rogger.dmxSnapshot?.();
      if (!snap) { mon.replaceChildren(h('div', 'hint', 'DMX monitor needs the desktop app.')); return; }
      const label = names();
      const parts = [];
      if (!snap.streams.length) parts.push(h('div', 'hint', 'Nothing sent yet. sACN buttons and safeties appear here once ROGGER drives them.'));
      for (const st of snap.streams) {
        const head = h('div', 'dmx-stream-head u-caps u-num',
          `${st.proto === 'sacn' ? 'sACN' : 'Art-Net'} U${st.universe} → ${st.host}${st.iface ? ' via ' + st.iface : ''}${st.priority != null ? ' · prio ' + st.priority : ''}${snap.preview && st.proto === 'sacn' ? ' · PREVIEW' : ''}`);
        const grid = h('div', 'dmx-chans');
        for (const ch of st.channels) {
          const cell = h('div', 'dmx-chan' + (ch.value !== ch.default ? ' live' : ''));
          cell.append(h('div', 'dmx-ch u-num', `ch ${ch.channel}`), h('div', 'dmx-val u-num', String(ch.value)),
            h('div', 'dmx-name', label.get(`${st.universe}/${ch.channel}`) ?? `default ${ch.default}`));
          grid.append(cell);
        }
        parts.push(head, grid);
      }
      mon.replaceChildren(...parts);
    }
    paint();
    monitorTimer = setInterval(paint, 250);
  }

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
    exportBtn.addEventListener('click', async () => {
      const res = await rogger.exportConfig();
      if (res?.ok) showToast(`Config exported${res.path ? ' to ' + res.path : ''}`);
      else showToast('Export canceled', { error: true });
    });
    body.append(btnRow(exportBtn));

    const importBtn = h('button', 'big-btn u-caps', 'Import config…');
    importBtn.id = 'set-import';
    importBtn.addEventListener('click', async () => {
      const cfg = await rogger.importConfig();
      if (cfg) {
        safety.panic(state.get(), rogger); // new config: nothing armed, nothing left firing
        state.setAll(cfg);
        safety.panic(cfg, rogger);
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
    resetBtn.addEventListener('click', async () => {
      // One tap next to Import used to wipe every edit on the surface.
      if (!(await confirmDialog('Reload the default mapping? Every edit made on this surface will be lost.', { ok: 'Reload', danger: true }))) return;
      const cfg = await rogger.resetConfig();
      safety.panic(state.get(), rogger);
      state.setAll(cfg);
      safety.panic(cfg, rogger);
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
  closeBtn.addEventListener('click', close);
  const exitBtn = h('button', 'big-btn danger u-caps', 'Exit app');
  exitBtn.id = 'set-exit';
  exitBtn.addEventListener('click', async () => {
    // Sits right next to Close. A mis-tap must not take the show down, so
    // ask first (in-page: a native confirm() is unreliable in the fullscreen
    // kiosk window). An edit made in the last 300 ms is still waiting in
    // persist()'s debounce — write it before the window goes, but never let
    // a save that hangs or fails hold the exit hostage.
    if (!(await confirmDialog('Exit ROGGER?', { ok: 'Exit', danger: true }))) return;
    try {
      await Promise.race([rogger.saveConfig(state.get()), new Promise(r => setTimeout(r, 1500))]);
    } catch { /* quitting anyway */ }
    rogger.quit();
  });
  foot.append(closeBtn, exitBtn);

  renderTabBar();
  renderTab();
}
