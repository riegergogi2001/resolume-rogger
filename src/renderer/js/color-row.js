// 10 color preset buttons — each fires its assigned OSC command.
import { rogger } from './bridge.js';
import * as state from './state.js';

export function renderColorRow(el, { isEditMode, onEdit }) {
  el.innerHTML = '';

  state.get().colorButtons.forEach((_, i) => {
    const b = document.createElement('button');
    b.className = 'color-btn';
    b.dataset.index = i;
    b.innerHTML = '<div class="swatch"></div><div class="color-label u-caps"></div>';
    el.appendChild(b);

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
      rogger.send(c.address, c.args ?? []);
    });
    const off = () => b.classList.remove('pressed');
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
  });
}
