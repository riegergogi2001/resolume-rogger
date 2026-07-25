// Two pages of 16 assignable FX trigger buttons (FLASH + BUMP banks each).
// Tap / toggle / hold, flash animation, repeat, ramp-while-held (value sweep,
// e.g. rising strobe), macros, and gamepad bindings shown as badges.
import { rogger } from './bridge.js';
import * as state from './state.js';
import { showToast } from './toast.js';
import { BUTTON_NAMES } from './gamepad.js';
import * as beat from './beat-clock.js';
import { renderFaderSet } from './faders.js';

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
  if (btn.extraAddress && address === btn.address) rogger.sendTyped(btn.extraAddress, args);
}

export const PAGE_DEFS = [
  { kind: 'fxButtons', label: 'Page 1', layout: 'banks' },
  { kind: 'fxButtons2', label: 'Page 2', layout: 'mix', faderKind: 'groupFaders' },
  { kind: 'fxButtons3', label: 'DJ Intro', layout: 'grid' },
];
// Flat press/release handles across all pages, in PAGE_DEFS order.
export const fxHandles = [];

export function renderFxGrid(el, { isEditMode, onEdit }) {
  el.innerHTML = '';
  fxHandles.length = 0;

  const tabs = document.createElement('div');
  tabs.className = 'page-tabs';
  el.appendChild(tabs);
  const pageEls = [];

  function setPage(p) {
    pageEls.forEach((pg, i) => pg.classList.toggle('active', i === p));
    tabs.querySelectorAll('.page-tab').forEach((t, i) => t.classList.toggle('on', i === p));
  }

  let handleBase = 0;
  PAGE_DEFS.forEach(({ kind, label, layout, faderKind }, p) => {
    const buttons = state.get()[kind] ?? [];
    const tab = document.createElement('button');
    tab.className = 'page-tab u-caps';
    tab.dataset.page = p;
    tab.textContent = label;
    tab.addEventListener('pointerdown', () => setPage(p));
    tabs.appendChild(tab);

    const pageEl = document.createElement('div');
    pageEl.className = 'fx-page';
    let flashBank;
    let bumpBank;
    if (layout === 'banks') {
      const flashTitle = document.createElement('div');
      flashTitle.className = 'bank-title';
      flashTitle.textContent = 'Flash';
      flashBank = document.createElement('div');
      flashBank.className = 'fx-bank';
      const bumpTitle = document.createElement('div');
      bumpTitle.className = 'bank-title';
      bumpTitle.textContent = 'Bump';
      bumpBank = document.createElement('div');
      bumpBank.className = 'fx-bank';
      pageEl.append(flashTitle, flashBank, bumpTitle, bumpBank);
      pageEl.classList.add('fx-page--banks');
    } else if (layout === 'mix') {
      // top: 8 ramp/punch buttons; below: big tempo controls + group faders
      const flashTitle = document.createElement('div');
      flashTitle.className = 'bank-title';
      flashTitle.textContent = 'Flash';
      flashBank = document.createElement('div');
      flashBank.className = 'fx-bank';
      bumpBank = flashBank;
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
      const gTitle = document.createElement('div');
      gTitle.className = 'bank-title';
      gTitle.textContent = 'Groups';
      const faderZone = document.createElement('div');
      faderZone.className = 'page-fader-zone';
      renderFaderSet(faderZone, { isEditMode, onEdit }, faderKind);
      pageEl.append(flashTitle, flashBank, tempoRow, gTitle, faderZone);
      pageEl.classList.add('fx-page--mix');
    } else {
      const head = document.createElement('div');
      head.className = 'bank-title';
      head.textContent = label;
      const sync = document.createElement('button');
      sync.className = 'mini-btn u-caps';
      sync.id = `sync-${kind}`;
      sync.textContent = 'Sync from Resolume';
      sync.addEventListener('pointerdown', async () => {
        try {
          const cfg = await rogger.syncDjPage();
          state.setAll(cfg);
          showToast('DJ page synced from Resolume');
        } catch {
          showToast('Sync failed — enable the Resolume webserver', { error: true });
        }
      });
      head.appendChild(sync);
      flashBank = document.createElement('div');
      flashBank.className = 'fx-bank grid24';
      bumpBank = flashBank;
      pageEl.append(head, flashBank);
      pageEl.classList.add('fx-page--grid');
    }
    el.appendChild(pageEl);
    pageEls.push(pageEl);

    const latched = new Set();
    const pageBase = handleBase;
    handleBase += buttons.length;

    const renderCount = layout === 'mix' ? Math.min(8, buttons.length) : buttons.length;
    buttons.slice(0, renderCount).forEach((_, i) => {
      const b = document.createElement('button');
      b.className = 'fx-btn';
      b.dataset.index = i;
      b.dataset.kind = kind;
      b.innerHTML =
        '<span class="fx-icon"></span><span class="fx-mode u-caps"></span>' +
        '<span class="fx-label u-caps"></span><span class="fx-pad u-num"></span>';
      (layout === 'banks' && i >= 8 ? bumpBank : flashBank).appendChild(b);

      let repeatTimer = null;
      let holdActive = false;
      let rampRaf = null;
      const cfg = () => state.get()[kind][i];

      function apply() {
        const c = cfg();
        b.style.setProperty('--fx-color', c.color);
        b.querySelector('.fx-icon').textContent = c.icon;
        b.querySelector('.fx-label').textContent = c.label;
        b.querySelector('.fx-mode').textContent = c.mode === 'tap' ? '' : c.mode;
        b.querySelector('.fx-pad').textContent = BUTTON_NAMES[c.gamepadButton] ?? '';
      }
      apply();
      state.subscribe(apply);

      function startRamp() {
        const startedAt = performance.now();
        const step = () => {
          if (rampRaf === null) return;
          const c = cfg();
          const r = c.ramp;
          const t = Math.min(1, (performance.now() - startedAt) / Math.max(50, r.durationMs));
          const v = r.from + (r.to - r.from) * t;
          rogger.sendTyped(c.address, [{ type: 'f', value: v }]);
          if (t < 1) rampRaf = requestAnimationFrame(step);
        };
        rampRaf = requestAnimationFrame(step);
      }

      function press() {
        const c = cfg();
        // tempotap buttons also drive the local beat clock (touch + gamepad)
        if (c.address === '/composition/tempocontroller/tempotap') beat.tap();
        if (c.mode === 'toggle') {
          if (latched.has(i)) {
            latched.delete(i);
            b.classList.remove('latched');
            fire(c, c.offValue);
          } else {
            latched.add(i);
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
        repeatTimer = setTimeout(() => {
          fire(cfg(), cfg().value);
          scheduleRepeat();
        }, Math.max(50, iv));
      }

      function release() {
        if (rampRaf !== null) {
          cancelAnimationFrame(rampRaf);
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
      rogger.onMessage(msg => {
        const c = cfg();
        if (msg.address !== c.address) return;
        const a = msg.args?.[0];
        if (!a || typeof a.value !== 'number') return;
        const on = a.value !== 0;
        if (c.mode === 'toggle') {
          if (on) latched.add(i); else latched.delete(i);
          b.classList.toggle('latched', on);
        } else if (c.mode === 'hold') {
          if (!holdActive) b.classList.toggle('latched', on);
        } else if (on && !b.classList.contains('pressed')) {
          b.classList.add('pressed');
          setTimeout(() => { if (!holdActive) b.classList.remove('pressed'); }, 160);
        }
      });

      fxHandles[pageBase + i] = {
        press: () => { if (!isEditMode()) press(); },
        release,
      };
    });
  });

  setPage(0);
}
