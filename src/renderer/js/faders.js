// Multitouch faders in two racks: vertical columns and horizontal strips
// (orientation per fader). Per-fader pointer capture, rAF-throttled float
// sends (optionally mirrored to extraAddress), min/max mapping, invert,
// sensitivity (>=1 absolute, <1 fine relative), double-tap resets to default.
import { rogger } from './bridge.js';
import * as state from './state.js';
import { showToast } from './toast.js';
import { beatMs } from './beat-clock.js';

const fmt = v => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export function renderFaders(el, { isEditMode, onEdit }) {
  el.innerHTML = '';
  const all = state.get().faders;
  const vIdx = [];
  const hIdx = [];
  all.forEach((f, i) => (f.orientation === 'h' ? hIdx : vIdx).push(i));

  const vRack = document.createElement('div');
  vRack.className = 'fader-rack-v';
  vRack.style.gridTemplateColumns = `repeat(${Math.max(1, vIdx.length)}, 1fr)`;
  const hRack = document.createElement('div');
  hRack.className = 'fader-rack-h';
  el.append(vRack, hRack);
  if (!hIdx.length) hRack.style.display = 'none';

  function buildFader(i) {
    const isH = all[i].orientation === 'h';
    const wrap = document.createElement('div');
    wrap.className = 'fader' + (isH ? ' fader--h' : '');
    wrap.dataset.index = i;
    wrap.innerHTML = isH
      ? `<div class="fader-label u-caps"></div>
         <div class="fader-track"><div class="fader-fill"></div><div class="fader-thumb"></div></div>
         <div class="fader-value u-num"></div>`
      : `<div class="fader-label u-caps"></div>
         <div class="fader-value u-num"></div>
         <div class="fader-track"><div class="fader-fill"></div><div class="fader-thumb"></div></div>`;
    (isH ? hRack : vRack).appendChild(wrap);

    const track = wrap.querySelector('.fader-track');
    const fill = wrap.querySelector('.fader-fill');
    const thumb = wrap.querySelector('.fader-thumb');
    const valueEl = wrap.querySelector('.fader-value');
    const cfg = () => state.get().faders[i];

    // norm is the visual position 0..1 (bottom-up / left-right);
    // invert only affects the output value.
    function normOf(c, value) {
      const n = (value - c.min) / (c.max - c.min || 1);
      const vis = c.invert ? 1 - n : n;
      return Math.min(1, Math.max(0, vis));
    }
    function valueOf(c, n) {
      const nn = c.invert ? 1 - n : n;
      return c.min + nn * (c.max - c.min);
    }

    let norm = normOf(cfg(), cfg().defaultValue);
    let lastSent = null;
    let raf = null;
    let lastTapTime = 0;
    let startPos = 0;
    let startNorm = 0;

    function paint() {
      const c = cfg();
      wrap.style.setProperty('--fader-color', c.color);
      wrap.querySelector('.fader-label').textContent = c.label;
      if (isH) {
        fill.style.width = `${norm * 100}%`;
        thumb.style.left = `calc((100% - 36px) * ${norm})`;
      } else {
        fill.style.height = `${norm * 100}%`;
        // keep the 44px thumb fully inside the track at both extremes
        thumb.style.top = `calc((100% - 44px) * ${1 - norm} + 22px)`;
      }
      valueEl.textContent = fmt(valueOf(c, norm));
    }
    paint();
    state.subscribe(paint);

    function sendValue() {
      const c = cfg();
      const v = valueOf(c, norm);
      if (v === lastSent) return;
      lastSent = v;
      const args = [{ type: 'f', value: v }];
      rogger.sendTyped(c.address, args);
      if (c.extraAddress) rogger.sendTyped(c.extraAddress, args);
      for (const a of c.extraAddresses ?? []) rogger.sendTyped(a, args);
    }
    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        sendValue();
        paint();
      });
    }

    function posNorm(e, rect) {
      return isH
        ? (e.clientX - rect.left) / rect.width
        : 1 - (e.clientY - rect.top) / rect.height;
    }

    track.addEventListener('pointerdown', e => {
      if (isEditMode()) { onEdit('faders', i); return; }
      const now = performance.now();
      if (now - lastTapTime < 300) {
        norm = normOf(cfg(), cfg().defaultValue);
        schedule();
        lastTapTime = 0;
        return;
      }
      lastTapTime = now;
      track.setPointerCapture(e.pointerId);
      wrap.classList.add('active');
      const rect = track.getBoundingClientRect();
      if (cfg().sensitivity >= 1) {
        norm = Math.min(1, Math.max(0, posNorm(e, rect)));
      }
      startPos = isH ? e.clientX : e.clientY;
      startNorm = norm;
      schedule();
    });

    track.addEventListener('pointermove', e => {
      if (!wrap.classList.contains('active')) return;
      const rect = track.getBoundingClientRect();
      const c = cfg();
      if (c.sensitivity >= 1) {
        norm = posNorm(e, rect);
      } else {
        const delta = isH
          ? (e.clientX - startPos) / rect.width
          : (startPos - e.clientY) / rect.height;
        norm = startNorm + delta * c.sensitivity;
      }
      norm = Math.min(1, Math.max(0, norm));
      schedule();
    });

    function up() {
      wrap.classList.remove('active');
      schedule();
    }
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);

    // ♪ button: set the value from the tapped beat (value = bpm / bpmAt1)
    if (all[i].beatSync?.enabled) {
      const beatBtn = document.createElement('button');
      beatBtn.className = 'mini-btn beat-btn u-num';
      beatBtn.textContent = '♪';
      beatBtn.addEventListener('pointerdown', () => {
        const ms = beatMs();
        if (!ms) { showToast('Tap a tempo first', { error: true }); return; }
        const c = cfg();
        const bpm = 60000 / ms;
        const value = Math.min(c.max, Math.max(c.min,
          c.min + (c.max - c.min) * (bpm / (c.beatSync.bpmAt1 || 300))));
        norm = normOf(c, value);
        lastSent = null; // force the send even if unchanged
        schedule();
      });
      wrap.appendChild(beatBtn);
    }

    // Bidirectional feedback: follow matching inbound OSC unless a finger
    // currently owns this fader.
    rogger.onMessage(msg => {
      if (wrap.classList.contains('active')) return;
      const c = cfg();
      if (msg.address !== c.address) return;
      const a = msg.args?.[0];
      if (!a || typeof a.value !== 'number') return;
      norm = normOf(c, a.value);
      lastSent = a.value; // remote value is current — don't echo it back
      paint();
    });
  }

  for (const i of [...vIdx, ...hIdx]) buildFader(i);
}
