// FX trigger pages. Page 1: FLASH + BUMP banks with a 2x2 utility quad in
// the bump row; page 2: 8 ramps + big tempo + group faders; page 3: 24-slot
// clip grid. Tap / toggle / hold, flash animation, repeat (beat-syncable),
// ramp-while-held, macros (zeroed on release), gamepad bindings as badges.
import { rogger } from './bridge.js';
import * as state from './state.js';
import { showToast } from './toast.js';
import { BUTTON_NAMES } from './gamepad.js';
import { HANDLE_KINDS, bindingLabel } from './gamepad-resolve.js';
import * as beat from './beat-clock.js';
import { renderFaderSet } from './faders.js';
import { renderColorLab } from './color-lab.js';
import { renderBpmPage } from './bpm/bpm-page.js';

// ---- DJ sync reporting -------------------------------------------------
function summariseSync(report) {
  const bits = [`Synced ${report.synced} name${report.synced === 1 ? '' : 's'} from ${report.layer}`];
  if (report.cleared) bits.push(`· ${report.cleared} stale slot${report.cleared === 1 ? '' : 's'} cleared`);
  if (report.mismatches?.length) bits.push(`· ${report.mismatches.length} column${report.mismatches.length === 1 ? '' : 's'} disagree`);
  return bits.join(' ');
}

function reportSyncMismatches(mismatches) {
  // One toast per column, staggered so they stack readably rather than
  // collapsing into a single unreadable blob.
  mismatches.slice(0, 6).forEach((m, i) => {
    setTimeout(() => showToast(
      `Column ${m.column}: "${m.expected}" but ${m.layer} plays "${m.actual}"`,
      { error: true, ms: 9000 },
    ), 400 + i * 250);
  });
  if (mismatches.length > 6) {
    setTimeout(() => showToast(`…and ${mismatches.length - 6} more mismatched columns`, { error: true, ms: 9000 }), 400 + 6 * 250);
  }
}


function typedArgs(type, value) {
  if (type === 'command') return [];
  if (type === 'float') return [{ type: 'f', value: Number(value) }];
  return [{ type: 'i', value: Math.trunc(Number(value)) }];
}

function fire(btn, value, address = btn.address) {
  if (btn.macro && btn.macro.length) {
    for (const step of btn.macro) rogger.send(step.address, step.values ?? []);
    return;
  }
  const args = typedArgs(btn.type, value);
  rogger.sendTyped(address, args);
  if (address !== btn.address) return; // a releaseAddress is not mirrored
  if (btn.extraAddress) rogger.sendTyped(btn.extraAddress, args);
  for (const a of btn.extraAddresses ?? []) if (a) rogger.sendTyped(a, args);
}

export const PAGE_DEFS = [
  { kind: 'fxButtons', label: 'Page 1', layout: 'banks' },
  { kind: 'fxButtons2', label: 'Page 2', layout: 'mix', faderKind: 'groupFaders' },
  { kind: 'fxButtons3', label: 'DJ Intro', layout: 'grid' },
  { kind: null, label: 'Colors', layout: 'colors' },
  { kind: null, label: 'BPM', layout: 'bpm' },
];
// Handle order for the gamepad: all pages, then the utility quad.
// (Single definition lives in gamepad-resolve.js; re-exported here so
// existing importers of HANDLE_KINDS from fx-grid.js keep working.)
export { HANDLE_KINDS };
export const fxHandles = [];

// Module-level page control so other modules (Settings' Pages tab, the
// inbound /rogger/page remote-API handler) can drive/read the active page
// without holding a reference into whatever renderFxGrid() closure is live.
let activeSetPage = null;
let activeGetPage = () => 0;
export function setPage(p) { activeSetPage?.(p); }
export function getPage() { return activeGetPage(); }

// Both outlive a rebuild. renderFxGrid() runs again whenever something a
// per-control refresh cannot reflect changes (fader orientation, hidden pages,
// a colour target added or removed, an import), and a rebuild used to drop
// the operator back on Page 1 and show every latched toggle as off while the
// effect it switched on was still running — the next tap sent ON again.
const latched = new Set(); // `${kind}:${i}` keys of toggles currently on
let lastPageLabel = null;  // the page that was up before the rebuild

export function renderFxGrid(el, { isEditMode, onEdit }) {
  el.innerHTML = '';
  fxHandles.length = 0;

  const offsets = {};
  {
    let base = 0;
    for (const k of HANDLE_KINDS) {
      offsets[k] = base;
      base += (state.get()[k] ?? []).length;
    }
  }

  function makeButton(kind, i, container, small) {
    const b = document.createElement('button');
    b.className = 'fx-btn' + (small ? ' fx-btn--small' : '');
    b.dataset.index = i;
    b.dataset.kind = kind;
    b.innerHTML =
      '<span class="fx-icon"></span><span class="fx-mode u-caps"></span>' +
      '<span class="fx-label u-caps"></span><span class="fx-pad u-num"></span>';
    container.appendChild(b);

    let repeatTimer = null;
    let holdActive = false;
    let rampRaf = null;
    let rampValue = null; // last value the hold ramp sent, where a release fade starts from
    const key = `${kind}:${i}`;
    const cfg = () => state.get()[kind][i];

    function apply() {
      const c = cfg();
      b.style.setProperty('--fx-color', c.color);
      b.querySelector('.fx-icon').textContent = c.icon;
      b.querySelector('.fx-label').textContent = c.label;
      b.querySelector('.fx-mode').textContent = c.mode === 'tap' ? '' : c.mode;
      b.querySelector('.fx-pad').textContent = bindingLabel(BUTTON_NAMES, c.gamepadButton, c.gamepadModifier);
    }
    apply();
    state.subscribe(apply);
    // Restore a toggle that was on before the rebuild; forget it if the
    // control has since been edited into another mode.
    if (cfg().mode === 'toggle' && latched.has(key)) b.classList.add('latched');
    else latched.delete(key);

    function startRamp() {
      if (rampRaf !== null) cancelAnimationFrame(rampRaf); // a release fade still running
      const startedAt = performance.now();
      const step = () => {
        if (rampRaf === null) return;
        const c = cfg();
        const r = c.ramp;
        const t = Math.min(1, (performance.now() - startedAt) / Math.max(50, r.durationMs));
        const v = r.from + (r.to - r.from) * t;
        rampValue = v;
        rogger.sendTyped(c.address, [{ type: 'f', value: v }]);
        if (t < 1) rampRaf = requestAnimationFrame(step);
      };
      rampRaf = requestAnimationFrame(step);
    }

    // Release fade (ramp.releaseMs > 0): instead of snapping back, sweep from
    // wherever the hold ramp got to down to the release value. Runs after
    // holdActive has cleared, so a second pointerup/pointercancel cannot cut
    // it short; a new press replaces it.
    function startReleaseFade(c) {
      const from = rampValue ?? c.ramp.from;
      const to = c.releaseValue ?? c.ramp.from;
      const ms = Math.max(50, c.ramp.releaseMs);
      const startedAt = performance.now();
      const step = () => {
        if (rampRaf === null) return;
        const t = Math.min(1, (performance.now() - startedAt) / ms);
        const v = from + (to - from) * t;
        rogger.sendTyped(cfg().address, [{ type: 'f', value: v }]);
        if (t < 1) { rampRaf = requestAnimationFrame(step); return; }
        rampRaf = null;
        rampValue = null;
      };
      rampRaf = requestAnimationFrame(step);
    }

    function press() {
      const c = cfg();
      // tempotap buttons also drive the local beat clock (touch + gamepad)
      if (c.address === '/composition/tempocontroller/tempotap') beat.tap();
      if (c.mode === 'toggle') {
        if (latched.has(key)) {
          latched.delete(key);
          b.classList.remove('latched');
          fire(c, c.offValue);
        } else {
          latched.add(key);
          b.classList.add('latched');
          fire(c, c.value);
        }
        return;
      }
      b.classList.add('pressed');
      if (c.mode === 'hold') {
        b.classList.add('flashing');
        holdActive = true;
      }
      if (c.mode === 'hold' && c.ramp?.enabled) {
        startRamp(); // the sweep replaces the single press message
      } else {
        fire(c, c.value);
        if (c.repeat?.enabled) scheduleRepeat();
      }
    }

    // self-timing chain so beat-synced repeats follow tempo changes live
    function scheduleRepeat() {
      const r = cfg().repeat;
      const iv = r.sync ? (beat.beatMs() ?? r.intervalMs) : r.intervalMs;
      // One chain per button: a second press() while one is already running
      // (pad + touch, remote API + pad) replaces it. Without this the first
      // chain lost its handle and kept rescheduling itself after release.
      clearTimeout(repeatTimer);
      repeatTimer = setTimeout(() => {
        fire(cfg(), cfg().value);
        scheduleRepeat();
      }, Math.max(50, iv));
    }

    function release() {
      if (holdActive && rampRaf !== null) {
        cancelAnimationFrame(rampRaf); // the hold ramp; a release fade is left to finish
        rampRaf = null;
      }
      clearTimeout(repeatTimer);
      repeatTimer = null;
      b.classList.remove('pressed', 'flashing');
      if (holdActive) {
        holdActive = false;
        const c = cfg();
        if (c.macro?.length) {
          // release a macro by zeroing every step (clears etc. must let go)
          for (const step of c.macro) {
            rogger.send(step.address, (step.values ?? [1]).map(() => c.releaseValue ?? 0));
          }
        } else if (c.mode === 'hold' && c.ramp?.enabled && (c.ramp.releaseMs ?? 0) > 0 && !c.releaseAddress) {
          startReleaseFade(c);
        } else {
          fire(c, c.releaseValue, c.releaseAddress || c.address);
        }
      }
    }

    b.addEventListener('pointerdown', e => {
      if (isEditMode()) { onEdit(kind, i); return; }
      b.setPointerCapture(e.pointerId);
      press();
    });
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);

    // Bidirectional feedback: reflect state reported by the target app.
    // `.../connect` is a write-only trigger — Resolume reports state on
    // `.../connected` (clips: 0 empty, 1 idle, 2 preview, 3+ live), so
    // watch that address too. Inverted controls (bypassed-style, on-value
    // 0) latch when the reported value matches their on-value.
    rogger.onMessage(msg => {
      const c = cfg();
      const a = msg.args?.[0];
      if (!a || typeof a.value !== 'number') return;
      let on;
      if (msg.address === c.address) {
        on = Number(c.value) === 0 ? a.value === 0 : a.value !== 0;
      } else if (c.address.endsWith('/connect') && msg.address === c.address + 'ed') {
        on = c.address.includes('/clips/') ? a.value >= 3 : a.value > 0;
      } else {
        return;
      }
      if (c.mode === 'toggle') {
        if (on) latched.add(key); else latched.delete(key);
        b.classList.toggle('latched', on);
      } else if (c.mode === 'hold') {
        if (!holdActive) b.classList.toggle('latched', on);
      } else if (on && !b.classList.contains('pressed')) {
        b.classList.add('pressed');
        setTimeout(() => { if (!holdActive) b.classList.remove('pressed'); }, 160);
      }
    });

    fxHandles[offsets[kind] + i] = {
      press: () => { if (!isEditMode()) press(); },
      release,
    };
  }

  const tabs = document.createElement('div');
  tabs.className = 'page-tabs';
  el.appendChild(tabs);
  const pageEls = [];

  let curPage = 0;
  // Settings → Pages hides everything but Page 1 (PAGE_DEFS[0]) by label;
  // covers any future page (e.g. BPM) automatically since it just checks
  // labels, not a hardcoded list.
  const hiddenPages = new Set(state.get().ui?.hiddenPages ?? []);
  const visibleDefs = PAGE_DEFS.filter((d, i) => i === 0 || !hiddenPages.has(d.label));

  function showPage(p) {
    curPage = p;
    pageEls.forEach((pg, i) => pg.classList.toggle('active', i === p));
    tabs.querySelectorAll('.page-tab').forEach((t, i) => t.classList.toggle('on', i === p));
    // The layout keys off which page is up: the Colors page carries its own
    // target chips and swatch bank, so the footer's copy of both is hidden
    // there and the picker gets the space instead.
    const def = visibleDefs[p];
    lastPageLabel = def?.label ?? null;
    document.body.dataset.page = (def?.label ?? '').toLowerCase().replace(/\s+/g, '-');
  }
  activeSetPage = showPage;
  activeGetPage = () => curPage;


  visibleDefs.forEach(({ kind, label, layout, faderKind }, p) => {
    const buttons = state.get()[kind] ?? [];
    const tab = document.createElement('button');
    tab.className = 'page-tab u-caps';
    tab.dataset.page = p;
    tab.textContent = label;
    tab.addEventListener('pointerdown', () => showPage(p));
    tabs.appendChild(tab);

    const pageEl = document.createElement('div');
    pageEl.className = 'fx-page';
    el.appendChild(pageEl);
    pageEls.push(pageEl);

    function bankTitle(text) {
      const t = document.createElement('div');
      t.className = 'bank-title';
      t.textContent = text;
      return t;
    }

    if (layout === 'colors') {
      pageEl.classList.add('fx-page--custom');
      renderColorLab(pageEl, { isEditMode, onEdit });
    } else if (layout === 'bpm') {
      pageEl.classList.add('fx-page--custom');
      renderBpmPage(pageEl);
    } else if (layout === 'banks') {
      const flashBank = document.createElement('div');
      flashBank.className = 'fx-bank';
      const bumpBank = document.createElement('div');
      bumpBank.className = 'fx-bank';
      pageEl.append(bankTitle('Flash'), flashBank, bankTitle('Bump'), bumpBank);
      pageEl.classList.add('fx-page--banks');
      // The utility toggles used to be a 2x2 quad wedged into the first bump
      // slot. They are a strip along the bottom of the column now (see
      // renderUtilStrip): it holds any number of them and stops them competing
      // for space with the big triggers.
      buttons.forEach((_, i) => makeButton(kind, i, i < 8 ? flashBank : bumpBank, false));
    } else if (layout === 'mix') {
      const flashBank = document.createElement('div');
      flashBank.className = 'fx-bank';
      const tempoRow = document.createElement('div');
      tempoRow.className = 'tempo-row';
      function bigTempo(id, lbl, address, onPress) {
        const btn = document.createElement('button');
        btn.className = 'tempo-big u-caps';
        btn.id = id;
        btn.textContent = lbl;
        btn.addEventListener('pointerdown', e => {
          btn.setPointerCapture(e.pointerId);
          rogger.sendTyped(address, [{ type: 'i', value: 1 }]);
          if (onPress) onPress();
        });
        const up = () => rogger.sendTyped(address, [{ type: 'i', value: 0 }]);
        btn.addEventListener('pointerup', up);
        btn.addEventListener('pointercancel', up);
        return btn;
      }
      tempoRow.append(
        bigTempo('big-tap', 'Tap Tempo', '/composition/tempocontroller/tempotap', beat.tap),
        bigTempo('big-resync', 'Resync', '/composition/tempocontroller/resync'));
      const bumpBank = document.createElement('div');
      bumpBank.className = 'fx-bank';
      const faderZone = document.createElement('div');
      faderZone.className = 'page-fader-zone';
      renderFaderSet(faderZone, { isEditMode, onEdit }, faderKind);
      pageEl.append(bankTitle('Ramp'), flashBank, bankTitle('Bump'), bumpBank,
        tempoRow, bankTitle('Groups'), faderZone);
      pageEl.classList.add('fx-page--mix');
      buttons.forEach((_, i) => makeButton(kind, i, i < 8 ? flashBank : bumpBank, false));
    } else {
      const head = bankTitle(label);
      const sync = document.createElement('button');
      sync.className = 'mini-btn u-caps';
      sync.id = `sync-${kind}`;
      sync.textContent = 'Sync from Resolume';
      sync.addEventListener('pointerdown', async () => {
        try {
          const result = await rogger.syncDjPage();
          // Older bridges returned the config directly; accept both.
          const cfg = result?.config ?? result;
          const report = result?.report ?? null;
          state.setAll(cfg);
          showToast(report ? summariseSync(report) : 'DJ page synced from Resolume');
          // A column the group's layers disagree about means a button that
          // says one name and puts another on the screens. Say so loudly —
          // this is the failure nobody catches until it is live.
          if (report?.mismatches?.length) reportSyncMismatches(report.mismatches);
        } catch {
          showToast('Sync failed — enable the Resolume webserver', { error: true });
        }
      });
      head.appendChild(sync);
      const grid = document.createElement('div');
      grid.className = 'fx-bank grid24';
      pageEl.append(head, grid);
      pageEl.classList.add('fx-page--grid');
      buttons.forEach((_, i) => makeButton(kind, i, grid, false));
    }
  });

  // The utility strip: small latching buttons along the bottom of the FX
  // column, on every page. They are ordinary configurable controls — the same
  // `utilButtons` the remote API, the gamepad handles and the grandMA3 DMX map
  // already address — so whatever sits on them today can be re-pointed at
  // something else tomorrow from the editor, without touching any code, and
  // the row simply gets longer if more are added.
  // Full width under the surface rather than inside the FX column: nine of
  // them wrapped to two rows in the narrower column, which cost more height
  // than the Ally X has to give.
  const strip = document.getElementById('util-strip');
  if (strip) {
    strip.replaceChildren();
    strip.className = 'util-strip';
    (state.get().utilButtons ?? []).forEach((_, u) => makeButton('utilButtons', u, strip, true));
  }

  // Stay on the page that was up, unless it has just been hidden.
  const keep = visibleDefs.findIndex(d => d.label === lastPageLabel);
  showPage(keep >= 0 ? keep : 0);
}
