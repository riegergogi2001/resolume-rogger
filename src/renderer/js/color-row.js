// 10 color preset buttons — each fires its assigned OSC command or macro.
// Feedback: single-address buttons light on a nonzero report; macro buttons
// light when every reported parameter matches their target values.
import { rogger } from './bridge.js';
import * as state from './state.js';

const EPS = 0.03;

export function renderColorRow(el, { isEditMode, onEdit }) {
  el.innerHTML = '';
  const lastVals = new Map();
  const buttons = [];

  function evaluateMacroSelection() {
    const cfgs = state.get().colorButtons;
    let winner = -1;
    cfgs.forEach((c, i) => {
      if (!c.macro?.length || winner !== -1) return;
      const ok = c.macro.every(step => {
        const v = step.values?.[0];
        if (typeof v !== 'number') return true;
        const last = lastVals.get(step.address);
        return typeof last === 'number' && Math.abs(last - v) < EPS;
      });
      if (ok) winner = i;
    });
    cfgs.forEach((c, i) => {
      if (c.macro?.length) buttons[i].classList.toggle('selected', i === winner);
    });
  }

  rogger.onMessage(msg => {
    const a = msg.args?.[0];
    if (!a || typeof a.value !== 'number') return;
    const used = state.get().colorButtons.some(c => c.macro?.some(s => s.address === msg.address));
    if (!used) return;
    lastVals.set(msg.address, a.value);
    evaluateMacroSelection();
  });

  state.get().colorButtons.forEach((_, i) => {
    const b = document.createElement('button');
    b.className = 'color-btn';
    b.dataset.index = i;
    b.innerHTML = '<div class="swatch"></div><div class="color-label u-caps"></div>';
    el.appendChild(b);
    buttons[i] = b;

    const cfg = () => state.get().colorButtons[i];
    function apply() {
      const c = cfg();
      b.style.setProperty('--swatch', c.color);
      b.querySelector('.color-label').textContent = c.label;
    }
    apply();
    state.subscribe(apply);

    b.addEventListener('pointerdown', e => {
      if (isEditMode()) { onEdit('colorButtons', i); return; }
      b.setPointerCapture(e.pointerId);
      b.classList.add('pressed');
      const c = cfg();
      if (c.macro?.length) {
        for (const step of c.macro) rogger.send(step.address, step.values ?? []);
      } else {
        rogger.send(c.address, c.args ?? []);
      }
    });
    const off = () => b.classList.remove('pressed');
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);

    // Feedback for single-address buttons (macro buttons use vector matching).
    rogger.onMessage(msg => {
      const c = cfg();
      if (c.macro?.length) return;
      if (msg.address !== c.address) return;
      const a = msg.args?.[0];
      if (!a || typeof a.value !== 'number') return;
      if (a.value !== 0) {
        el.querySelectorAll('.color-btn.selected').forEach(x => x.classList.remove('selected'));
        b.classList.add('selected');
      } else {
        b.classList.remove('selected');
      }
    });
  });
}
