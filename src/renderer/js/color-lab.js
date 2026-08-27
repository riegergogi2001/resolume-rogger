// COLORS page: advanced picker driving the switchable color targets.
// Hue strip + saturation/value pad (throttled OSC), quick swatch bank, and a
// ColorMorph strip (speed slider + on/off toggle for the comp-level effect).
import { rogger } from './bridge.js';
import * as state from './state.js';
import * as colorMemory from './color-memory.js';
import { chipOrder, isRecallTarget, recallAll } from './color-recall.js';

const SEND_MS = 33; // drag send throttle

// The comp's 8-color rainbow palette (same as the APC grid rows) + practical extras.
const SWATCHES = [
  '#ff0000', '#ff8000', '#ffff00', '#00ff00', '#00ffff', '#0000ff', '#8000ff', '#ff00ff',
  '#ffffff', '#ffd9a0', '#ff3b6e', '#2ee66b', '#3aa0ff', '#b46bff', '#ff3df0', '#101014',
];

function hsvToRgb(h, s, v) {
  const f = (n, k = (n + h * 6) % 6) => v - v * s * Math.max(Math.min(k, 4 - k, 1), 0);
  return [f(5), f(3), f(1)];
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0, max];
}

const hex2 = n => Math.round(n * 255).toString(16).padStart(2, '0');
const rgbHex = (r, g, b) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

export function renderColorLab(el, { isEditMode, onEdit } = {}) {
  el.classList.add('color-lab');

  const targetsCfg = () => state.get().colorTargets;
  const activeTarget = () => {
    const t = targetsCfg();
    return t?.items?.find(x => x.id === t.active) ?? t?.items?.[0] ?? null;
  };

  let hue = 0, sat = 1, val = 1;
  let lastSend = 0;
  let sendTimer = null;

  function sendColor(final = false) {
    const t = activeTarget();
    if (!t) return;
    const now = performance.now();
    if (!final && now - lastSend < SEND_MS) {
      // trailing send keeps the last drag position from being dropped
      clearTimeout(sendTimer);
      sendTimer = setTimeout(() => sendColor(true), SEND_MS);
      return;
    }
    lastSend = now;
    const [r, g, b] = hsvToRgb(hue, sat, val);
    colorMemory.setColor(t.id, [r, g, b]);
    for (const s of t.onSteps ?? []) rogger.send(s.address, s.values ?? []);
    for (const base of t.colorBases ?? []) {
      rogger.sendTyped(`${base}/red`, [{ type: 'f', value: r }]);
      rogger.sendTyped(`${base}/green`, [{ type: 'f', value: g }]);
      rogger.sendTyped(`${base}/blue`, [{ type: 'f', value: b }]);
    }
    document.documentElement.style.setProperty('--beat-color', rgbHex(r, g, b));
  }

  // ---- target chips ----
  const chips = document.createElement('div');
  chips.className = 'lab-chips';
  // Same contract as the footer switch in color-row.js: the row follows the
  // config by itself — label/swatch repaint in place, a changed set of ids
  // rebuilds the row — so editing a target never rebuilds the surface.
  const idsOf = () => (targetsCfg()?.items ?? []).map(x => x.id).join('\n');
  let builtIds = null;
  function buildChips() {
    chips.innerHTML = '';
    builtIds = idsOf();
    chipOrder(targetsCfg()?.items).forEach(({ item, index }) => {
      const c = document.createElement('button');
      c.className = 'target-pick u-caps';
      c.classList.toggle('target-recall', isRecallTarget(item));
      c.dataset.target = item.id;
      c.addEventListener('pointerdown', () => {
        if (isEditMode?.()) { onEdit?.('colorTargets', index); return; }
        state.setColorTarget(item.id);
        if (isRecallTarget(item)) recallAll(targetsCfg(), item, rogger, colorMemory);
      });
      chips.appendChild(c);
    });
    const off = document.createElement('button');
    off.className = 'target-pick target-off u-caps';
    off.textContent = 'OFF';
    off.addEventListener('pointerdown', () => {
      const t = activeTarget();
      if (t) colorMemory.clearColor(t.id);
      for (const s of t?.offSteps ?? []) rogger.send(s.address, s.values ?? []);
    });
    chips.appendChild(off);
    // A "+" that only shows in edit mode: the picker is not limited to the five
    // targets it ships with, and adding one by hand-editing the config was the
    // only way before. Always rendered and hidden by CSS, because edit mode is
    // a class on <body> — nothing re-renders when it is toggled.
    const add = document.createElement('button');
    add.className = 'target-pick target-add u-caps';
    add.id = 'lab-add-target';
    add.textContent = '+ TARGET';
    add.addEventListener('pointerdown', () => {
      if (!isEditMode?.()) return;
      const ti = state.addColorTarget();
      buildChips();
      onEdit?.('colorTargets', ti);
    });
    chips.appendChild(add);
    refreshChips();
  }
  function refreshChips() {
    if (idsOf() !== builtIds) { buildChips(); return; }
    const t = targetsCfg();
    chips.querySelectorAll('.target-pick[data-target]').forEach(x => {
      const item = t?.items?.find(i => i.id === x.dataset.target);
      if (item) {
        x.textContent = item.label;
        x.style.setProperty('--sw', item.swatch);
      }
      x.classList.toggle('on', x.dataset.target === t?.active);
    });
  }
  buildChips();
  state.subscribe(refreshChips);

  // ---- picker: SV pad + hue strip + preview ----
  const picker = document.createElement('div');
  picker.className = 'lab-picker';

  const pad = document.createElement('canvas');
  pad.className = 'sv-pad';
  const padDot = document.createElement('div');
  padDot.className = 'sv-dot';
  const padWrap = document.createElement('div');
  padWrap.className = 'sv-wrap';
  padWrap.append(pad, padDot);

  const hueStrip = document.createElement('div');
  hueStrip.className = 'hue-strip';
  const hueThumb = document.createElement('div');
  hueThumb.className = 'hue-thumb';
  hueStrip.appendChild(hueThumb);

  const side = document.createElement('div');
  side.className = 'lab-side';
  const preview = document.createElement('div');
  preview.className = 'lab-preview';
  const readout = document.createElement('div');
  readout.className = 'lab-readout u-num';
  side.append(preview, readout);

  picker.append(padWrap, hueStrip, side);

  function drawPad() {
    const w = pad.width = pad.clientWidth || 300;
    const h = pad.height = pad.clientHeight || 200;
    const ctx = pad.getContext('2d');
    const [hr, hg, hb] = hsvToRgb(hue, 1, 1);
    const gx = ctx.createLinearGradient(0, 0, w, 0);
    gx.addColorStop(0, '#ffffff');
    gx.addColorStop(1, rgbHex(hr, hg, hb));
    ctx.fillStyle = gx;
    ctx.fillRect(0, 0, w, h);
    const gy = ctx.createLinearGradient(0, 0, 0, h);
    gy.addColorStop(0, 'rgba(0,0,0,0)');
    gy.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = gy;
    ctx.fillRect(0, 0, w, h);
  }

  function refreshUi() {
    const [r, g, b] = hsvToRgb(hue, sat, val);
    const hx = rgbHex(r, g, b);
    preview.style.background = hx;
    readout.textContent = hx.toUpperCase();
    padDot.style.left = `${sat * 100}%`;
    padDot.style.top = `${(1 - val) * 100}%`;
    padDot.style.background = hx;
    hueThumb.style.left = `${hue * 100}%`;
    const [hr, hg, hb] = hsvToRgb(hue, 1, 1);
    hueThumb.style.background = rgbHex(hr, hg, hb);
  }

  let dragging = false;
  function dragged(surface, onPoint) {
    surface.addEventListener('pointerdown', e => {
      surface.setPointerCapture(e.pointerId);
      dragging = true;
      onPoint(e);
      const move = ev => onPoint(ev);
      const up = () => {
        surface.removeEventListener('pointermove', move);
        surface.removeEventListener('pointerup', up);
        surface.removeEventListener('pointercancel', up);
        dragging = false;
        sendColor(true);
      };
      surface.addEventListener('pointermove', move);
      surface.addEventListener('pointerup', up);
      surface.addEventListener('pointercancel', up);
    });
  }

  // Feedback: follow the active target's live color (another controller,
  // scene recall, ColorMorph...) whenever a finger doesn't own the picker.
  const inVals = {};
  rogger.onMessage(msg => {
    const a = msg.args?.[0];
    if (!a || typeof a.value !== 'number') return;
    const base = activeTarget()?.colorBases?.[0];
    if (!base || !msg.address.startsWith(base + '/')) return;
    const ch = msg.address.slice(base.length + 1);
    if (!['red', 'green', 'blue'].includes(ch)) return;
    inVals[ch] = a.value;
    if (dragging) return;
    if (['red', 'green', 'blue'].every(k => typeof inVals[k] === 'number')) {
      [hue, sat, val] = rgbToHsv(inVals.red, inVals.green, inVals.blue);
      drawPad();
      refreshUi();
    }
  });

  dragged(padWrap, e => {
    const rect = pad.getBoundingClientRect();
    sat = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    val = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
    refreshUi();
    sendColor();
  });

  dragged(hueStrip, e => {
    const rect = hueStrip.getBoundingClientRect();
    hue = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    drawPad();
    refreshUi();
    sendColor();
  });

  // ---- swatch bank ----
  const bank = document.createElement('div');
  bank.className = 'lab-swatches';
  SWATCHES.forEach(hx => {
    const b = document.createElement('button');
    b.className = 'lab-swatch';
    b.style.setProperty('--sw', hx);
    b.addEventListener('pointerdown', () => {
      const r = parseInt(hx.slice(1, 3), 16) / 255;
      const g = parseInt(hx.slice(3, 5), 16) / 255;
      const bl = parseInt(hx.slice(5, 7), 16) / 255;
      [hue, sat, val] = rgbToHsv(r, g, bl);
      drawPad();
      refreshUi();
      sendColor(true);
    });
    bank.appendChild(b);
  });

  // ---- ColorMorph strip: speed + on/off for the comp-level effect ----
  // The two morph colours are ordinary targets in the chip row above
  // (MORPH 1 / MORPH 2), edited and deleted like any other. This strip used
  // to repeat them as "Color 1" / "Color 3" wells, so each morph colour was
  // on the page twice — and the wells' swatches could never light, because
  // Resolume does not echo colours (see color-memory.js).
  const morph = document.createElement('div');
  morph.className = 'lab-morph';
  const morphCfg = () => state.get().colorMorph ?? {};
  const hasMorph = () => Boolean(morphCfg().speedAddress || morphCfg().bypassAddress);

  const morphToggle = document.createElement('button');
  morphToggle.className = 'morph-toggle u-caps';
  morphToggle.textContent = 'MORPH';
  let morphOn = false;
  function setMorphOn(on, send) {
    morphOn = on;
    morphToggle.classList.toggle('latched', on);
    if (send) {
      const a = morphCfg().bypassAddress;
      if (a) rogger.sendTyped(a, [{ type: 'i', value: on ? 0 : 1 }]);
    }
  }
  morphToggle.addEventListener('pointerdown', () => setMorphOn(!morphOn, true));

  const speedWrap = document.createElement('div');
  speedWrap.className = 'morph-speed';
  speedWrap.innerHTML = '<span class="u-caps">Morph speed</span>';
  const speedTrack = document.createElement('div');
  speedTrack.className = 'speed-track';
  const speedFill = document.createElement('div');
  speedFill.className = 'speed-fill';
  speedTrack.appendChild(speedFill);
  speedWrap.appendChild(speedTrack);
  let speedSend = 0;
  function speedPoint(e) {
    const rect = speedTrack.getBoundingClientRect();
    const v = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    speedFill.style.width = `${v * 100}%`;
    const now = performance.now();
    if (now - speedSend < SEND_MS) return;
    speedSend = now;
    const a = morphCfg().speedAddress;
    if (a) rogger.sendTyped(a, [{ type: 'f', value: v }]);
  }
  speedTrack.addEventListener('pointerdown', e => {
    speedTrack.setPointerCapture(e.pointerId);
    speedPoint(e);
    const move = ev => speedPoint(ev);
    const up = () => {
      speedTrack.removeEventListener('pointermove', move);
      speedTrack.removeEventListener('pointerup', up);
      speedTrack.removeEventListener('pointercancel', up);
    };
    speedTrack.addEventListener('pointermove', move);
    speedTrack.addEventListener('pointerup', up);
    speedTrack.addEventListener('pointercancel', up);
  });

  morph.append(speedWrap, morphToggle);

  // ---- OSC feedback: on/off + speed (Resolume does echo these) ----
  rogger.onMessage(msg => {
    const a = msg.args?.[0];
    if (!a || typeof a.value !== 'number') return;
    if (msg.address === morphCfg().bypassAddress) setMorphOn(a.value === 0, false);
    if (msg.address === morphCfg().speedAddress) speedFill.style.width = `${a.value * 100}%`;
  });

  function refreshMorph() { morph.hidden = !hasMorph(); }
  refreshMorph();
  state.subscribe(refreshMorph);

  const title = document.createElement('div');
  title.className = 'bank-title';
  title.textContent = 'Color Lab';

  el.append(title, chips, picker, bank, morph);

  // canvas needs layout before first draw
  requestAnimationFrame(() => { drawPad(); refreshUi(); });
}
