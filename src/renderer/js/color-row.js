// 10 color preset buttons + a target switch (the small squares at the end).
// Preset buttons with an rgb triplet route through the ACTIVE color target
// (e.g. BG colorize, logo outline-haze, flash-master strobe color); legacy
// buttons fire their own address/macro. Feedback lights the matching preset.
import { rogger } from './bridge.js';
import * as state from './state.js';

const EPS = 0.03;

// Remote-API handles: one per color preset button, { press() } — same
// action as a touch tap. Rebuilt in place on every render.
export const colorHandles = [];

export function renderColorRow(el, { isEditMode, onEdit }) {
  el.innerHTML = '';
  colorHandles.length = 0;
  const lastVals = new Map();
  const buttons = [];

  const targetsCfg = () => state.get().colorTargets;
  const activeTarget = () => {
    const t = targetsCfg();
    return t?.items?.find(x => x.id === t.active) ?? t?.items?.[0] ?? null;
  };
  const targetMode = () => state.get().colorButtons.some(c => Array.isArray(c.rgb) || c.isOff);

  function evaluateSelection() {
    const cfgs = state.get().colorButtons;
    const t = activeTarget();
    let winner = -1;
    cfgs.forEach((c, i) => {
      if (winner !== -1) return;
      if (Array.isArray(c.rgb) && t?.colorBases?.length) {
        const base = t.colorBases[0];
        const ok = ['red', 'green', 'blue'].every((ch, k) => {
          const last = lastVals.get(`${base}/${ch}`);
          return typeof last === 'number' && Math.abs(last - c.rgb[k]) < EPS;
        });
        if (ok) winner = i;
      } else if (c.macro?.length) {
        const ok = c.macro.every(step => {
          const v = step.values?.[0];
          if (typeof v !== 'number') return true;
          const last = lastVals.get(step.address);
          return typeof last === 'number' && Math.abs(last - v) < EPS;
        });
        if (ok) winner = i;
      }
    });
    cfgs.forEach((c, i) => {
      if (Array.isArray(c.rgb) || c.macro?.length) {
        buttons[i].classList.toggle('selected', i === winner);
      }
    });
  }

  rogger.onMessage(msg => {
    const a = msg.args?.[0];
    if (!a || typeof a.value !== 'number') return;
    const t = activeTarget();
    const watched =
      t?.colorBases?.some(b => msg.address.startsWith(b + '/')) ||
      state.get().colorButtons.some(c => c.macro?.some(s => s.address === msg.address));
    if (!watched) return;
    lastVals.set(msg.address, a.value);
    evaluateSelection();
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

    function doPress() {
      b.classList.add('pressed');
      const c = cfg();
      const t = activeTarget();
      // the beat pulse borrows the last picked color
      if (!c.isOff) document.documentElement.style.setProperty('--beat-color', c.color);
      if (c.isOff && t) {
        for (const s of t.offSteps ?? []) rogger.send(s.address, s.values ?? []);
      } else if (Array.isArray(c.rgb) && t) {
        for (const s of t.onSteps ?? []) rogger.send(s.address, s.values ?? []);
        for (const base of t.colorBases ?? []) {
          rogger.sendTyped(`${base}/red`, [{ type: 'f', value: c.rgb[0] }]);
          rogger.sendTyped(`${base}/green`, [{ type: 'f', value: c.rgb[1] }]);
          rogger.sendTyped(`${base}/blue`, [{ type: 'f', value: c.rgb[2] }]);
        }
      } else if (c.macro?.length) {
        for (const step of c.macro) rogger.send(step.address, step.values ?? []);
      } else {
        rogger.send(c.address, c.args ?? []);
      }
      setTimeout(() => b.classList.remove('pressed'), 160);
    }
    colorHandles[i] = { press: doPress };

    b.addEventListener('pointerdown', e => {
      if (isEditMode()) { onEdit('colorButtons', i); return; }
      b.setPointerCapture(e.pointerId);
      doPress();
    });
    const off = () => b.classList.remove('pressed');
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);

    // Legacy single-address feedback (target/macro buttons use vector matching).
    rogger.onMessage(msg => {
      const c = cfg();
      if (Array.isArray(c.rgb) || c.isOff || c.macro?.length) return;
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

  // The target switch: small squares choosing what the picker points at.
  if (targetMode() && targetsCfg()?.items?.length) {
    const sw = document.createElement('div');
    sw.className = 'color-target-switch';
    el.appendChild(sw);
    targetsCfg().items.forEach((item, ti) => {
      const tb = document.createElement('button');
      tb.className = 'target-pick u-caps';
      tb.dataset.target = item.id;
      tb.textContent = item.label;
      tb.style.setProperty('--sw', item.swatch);
      tb.addEventListener('pointerdown', () => {
        if (isEditMode()) { onEdit('colorTargets', ti); return; }
        state.setColorTarget(item.id);
        lastVals.clear();
        evaluateSelection();
      });
      sw.appendChild(tb);
    });
    function refreshSwitch() {
      const active = targetsCfg()?.active;
      sw.querySelectorAll('.target-pick').forEach(x =>
        x.classList.toggle('on', x.dataset.target === active));
    }
    refreshSwitch();
    state.subscribe(refreshSwitch);
  }
}
