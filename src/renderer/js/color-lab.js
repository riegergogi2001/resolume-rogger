// COLORS page: advanced picker driving the switchable color targets.
// Hue strip + saturation/value pad (throttled OSC), quick swatch bank, and a
// ColorMorph strip (Color 1 / Color 3 wells, speed slider, on/off toggle).
import { rogger } from './bridge.js';
import * as state from './state.js';

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

export function renderColorLab(el) {
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
  function buildChips() {
    chips.innerHTML = '';
    (targetsCfg()?.items ?? []).forEach(item => {
      const c = document.createElement('button');
      c.className = 'target-pick u-caps';
      c.dataset.target = item.id;
      c.textContent = item.label;
      c.style.setProperty('--sw', item.swatch);
      c.addEventListener('pointerdown', () => state.setColorTarget(item.id));
      chips.appendChild(c);
    });
    const off = document.createElement('button');
    off.className = 'target-pick target-off u-caps';
    off.textContent = 'OFF';
    off.addEventListener('pointerdown', () => {
      const t = activeTarget();
      for (const s of t?.offSteps ?? []) rogger.send(s.address, s.values ?? []);
    });
    chips.appendChild(off);
    refreshChips();
  }
  function refreshChips() {
    const active = targetsCfg()?.active;
    chips.querySelectorAll('.target-pick[data-target]').forEach(x =>
      x.classList.toggle('on', x.dataset.target === active));
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

  function dragged(surface, onPoint) {
    surface.addEventListener('pointerdown', e => {
      surface.setPointerCapture(e.pointerId);
      onPoint(e);
      const move = ev => onPoint(ev);
      const up = () => {
        surface.removeEventListener('pointermove', move);
        surface.removeEventListener('pointerup', up);
        surface.removeEventListener('pointercancel', up);
        sendColor(true);
      };
      surface.addEventListener('pointermove', move);
      surface.addEventListener('pointerup', up);
      surface.addEventListener('pointercancel', up);
    });
  }

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

  // ---- ColorMorph strip ----
  const morph = document.createElement('div');
  morph.className = 'lab-morph';
  const morphCfg = () => state.get().colorMorph ?? {};

  function morphWell(id, label) {
    const w = document.createElement('button');
    w.className = 'morph-well';
    w.dataset.target = id;
    w.innerHTML = `<span class="well-swatch"></span><span class="u-caps">${label}</span>`;
    w.addEventListener('pointerdown', () => state.setColorTarget(id));
    return w;
  }
  const well1 = morphWell('morph1', 'Color 1');
  const well2 = morphWell('morph2', 'Color 3');

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
  speedWrap.innerHTML = '<span class="u-caps">Speed</span>';
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

  morph.append(well1, well2, speedWrap, morphToggle);

  // ---- OSC feedback: morph wells + on/off + speed ----
  const wellVals = { morph1: {}, morph2: {} };
  rogger.onMessage(msg => {
    const a = msg.args?.[0];
    if (!a || typeof a.value !== 'number') return;
    const t = targetsCfg();
    for (const id of ['morph1', 'morph2']) {
      const item = t?.items?.find(x => x.id === id);
      const base = item?.colorBases?.[0];
      if (base && msg.address.startsWith(base + '/')) {
        const ch = msg.address.slice(base.length + 1);
        if (['red', 'green', 'blue'].includes(ch)) {
          wellVals[id][ch] = a.value;
          const v = wellVals[id];
          const w = id === 'morph1' ? well1 : well2;
          w.querySelector('.well-swatch').style.background =
            rgbHex(v.red ?? 0, v.green ?? 0, v.blue ?? 0);
        }
      }
    }
    if (msg.address === morphCfg().bypassAddress) setMorphOn(a.value === 0, false);
    if (msg.address === morphCfg().speedAddress) speedFill.style.width = `${a.value * 100}%`;
  });

  function refreshWells() {
    const active = targetsCfg()?.active;
    [well1, well2].forEach(w => w.classList.toggle('on', w.dataset.target === active));
  }
  refreshWells();
  state.subscribe(refreshWells);

  const title = document.createElement('div');
  title.className = 'bank-title';
  title.textContent = 'Color Lab';

  el.append(title, chips, picker, bank, morph);

  // canvas needs layout before first draw
  requestAnimationFrame(() => { drawPad(); refreshUi(); });
}
