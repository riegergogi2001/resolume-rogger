// 16 assignable FX trigger buttons: tap / toggle / hold, flash, repeat, macro.
import { rogger } from './bridge.js';
import * as state from './state.js';

function typedArgs(type, value) {
  if (type === 'command') return [];
  if (type === 'float') return [{ type: 'f', value: Number(value) }];
  return [{ type: 'i', value: Math.trunc(Number(value)) }];
}

function fire(btn, value) {
  if (btn.macro && btn.macro.length) {
    for (const step of btn.macro) rogger.send(step.address, step.values ?? []);
    return;
  }
  rogger.sendTyped(btn.address, typedArgs(btn.type, value));
}

export function renderFxGrid(el, { isEditMode, onEdit }) {
  el.innerHTML = '';
  const latched = new Set();

  state.get().fxButtons.forEach((_, i) => {
    const b = document.createElement('button');
    b.className = 'fx-btn';
    b.dataset.index = i;
    b.innerHTML =
      '<span class="fx-icon"></span><span class="fx-mode u-caps"></span><span class="fx-label u-caps"></span>';
    el.appendChild(b);

    let repeatTimer = null;
    let holdActive = false;
    const cfg = () => state.get().fxButtons[i];

    function apply() {
      const c = cfg();
      b.style.setProperty('--fx-color', c.color);
      b.querySelector('.fx-icon').textContent = c.icon;
      b.querySelector('.fx-label').textContent = c.label;
      b.querySelector('.fx-mode').textContent = c.mode === 'tap' ? '' : c.mode;
    }
    apply();
    state.subscribe(apply);

    b.addEventListener('pointerdown', e => {
      if (isEditMode()) { onEdit('fxButtons', i); return; }
      b.setPointerCapture(e.pointerId);
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
    });

    function release() {
      clearInterval(repeatTimer);
      repeatTimer = null;
      b.classList.remove('pressed', 'flashing');
      if (holdActive) {
        holdActive = false;
        const c = cfg();
        fire(c, c.releaseValue);
      }
    }
    b.addEventListener('pointerup', release);
    b.addEventListener('pointercancel', release);
  });
}
