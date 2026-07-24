// 16 assignable FX trigger buttons in two banks: FLASH (0-7, momentary hold
// by default) and BUMP (8-15, one-shot by default). Tap / toggle / hold,
// flash animation, repeat, macros, and gamepad bindings shown as badges.
import { rogger } from './bridge.js';
import * as state from './state.js';
import { BUTTON_NAMES } from './gamepad.js';

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

// Per-button {press, release} handles so the gamepad drives the exact same
// logic (and visual feedback) as touch.
export const fxHandles = [];

export function renderFxGrid(el, { isEditMode, onEdit }) {
  el.innerHTML = '';
  fxHandles.length = 0;
  const latched = new Set();

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
  el.append(flashTitle, flashBank, bumpTitle, bumpBank);

  state.get().fxButtons.forEach((_, i) => {
    const b = document.createElement('button');
    b.className = 'fx-btn';
    b.dataset.index = i;
    b.innerHTML =
      '<span class="fx-icon"></span><span class="fx-mode u-caps"></span>' +
      '<span class="fx-label u-caps"></span><span class="fx-pad u-num"></span>';
    (i < 8 ? flashBank : bumpBank).appendChild(b);

    let repeatTimer = null;
    let holdActive = false;
    const cfg = () => state.get().fxButtons[i];

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
      fire(c, c.value);
      if (c.repeat?.enabled) {
        repeatTimer = setInterval(() => fire(cfg(), cfg().value), Math.max(50, c.repeat.intervalMs));
      }
    }

    function release() {
      clearInterval(repeatTimer);
      repeatTimer = null;
      b.classList.remove('pressed', 'flashing');
      if (holdActive) {
        holdActive = false;
        const c = cfg();
        fire(c, c.releaseValue, c.releaseAddress || c.address);
      }
    }

    b.addEventListener('pointerdown', e => {
      if (isEditMode()) { onEdit('fxButtons', i); return; }
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
        // remote state lights the button; a local hold owns the visuals
        if (!holdActive) b.classList.toggle('latched', on);
      } else if (on && !b.classList.contains('pressed')) {
        b.classList.add('pressed'); // brief acknowledgment blink for taps
        setTimeout(() => { if (!holdActive) b.classList.remove('pressed'); }, 160);
      }
    });

    fxHandles[i] = {
      press: () => { if (!isEditMode()) press(); },
      release,
    };
  });
}
