// Two pages of 16 assignable FX trigger buttons (FLASH + BUMP banks each).
// Tap / toggle / hold, flash animation, repeat, ramp-while-held (value sweep,
// e.g. rising strobe), macros, and gamepad bindings shown as badges.
import { rogger } from './bridge.js';
import * as state from './state.js';
import { BUTTON_NAMES } from './gamepad.js';
import { beatMs } from './beat-clock.js';

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
  rogger.sendTyped(address, typedArgs(btn.type, value));
}

export const PAGE_KINDS = ['fxButtons', 'fxButtons2'];
// Flat press/release handles: page 1 = 0-15, page 2 = 16-31 (gamepad uses these).
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

  PAGE_KINDS.forEach((kind, p) => {
    const tab = document.createElement('button');
    tab.className = 'page-tab u-caps';
    tab.dataset.page = p;
    tab.textContent = `Page ${p + 1}`;
    tab.addEventListener('pointerdown', () => setPage(p));
    tabs.appendChild(tab);

    const pageEl = document.createElement('div');
    pageEl.className = 'fx-page';
    const flashTitle = document.createElement('div');
    flashTitle.className = 'bank-title';
    flashTitle.textContent = 'Flash';
    const flashBank = document.createElement('div');
    flashBank.className = 'fx-bank';
    const bumpTitle = document.createElement('div');
    bumpTitle.className = 'bank-title';
    bumpTitle.textContent = 'Bump';
    const bumpBank = document.createElement('div');
    bumpBank.className = 'fx-bank';
    pageEl.append(flashTitle, flashBank, bumpTitle, bumpBank);
    el.appendChild(pageEl);
    pageEls.push(pageEl);

    const latched = new Set();

    state.get()[kind].forEach((_, i) => {
      const b = document.createElement('button');
      b.className = 'fx-btn';
      b.dataset.index = i;
      b.dataset.kind = kind;
      b.innerHTML =
        '<span class="fx-icon"></span><span class="fx-mode u-caps"></span>' +
        '<span class="fx-label u-caps"></span><span class="fx-pad u-num"></span>';
      (i < 8 ? flashBank : bumpBank).appendChild(b);

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
        const iv = r.sync ? (beatMs() ?? r.intervalMs) : r.intervalMs;
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
          fire(c, c.releaseValue, c.releaseAddress || c.address);
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

      fxHandles[p * 16 + i] = {
        press: () => { if (!isEditMode()) press(); },
        release,
      };
    });
  });

  setPage(0);
}
