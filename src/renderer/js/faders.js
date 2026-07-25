// 6 multitouch faders: per-fader pointer capture, rAF-throttled float sends,
// min/max mapping, invert, sensitivity (>=1 absolute, <1 fine relative),
// double-tap resets to default.
import { rogger } from './bridge.js';
import * as state from './state.js';

const fmt = v => (Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export function renderFaders(el, { isEditMode, onEdit }) {
  el.innerHTML = '';
  el.style.gridTemplateColumns = `repeat(${state.get().faders.length}, 1fr)`;

  state.get().faders.forEach((_, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'fader';
    wrap.dataset.index = i;
    wrap.innerHTML = `
      <div class="fader-label u-caps"></div>
      <div class="fader-value u-num"></div>
      <div class="fader-track"><div class="fader-fill"></div><div class="fader-thumb"></div></div>`;
    el.appendChild(wrap);

    const track = wrap.querySelector('.fader-track');
    const fill = wrap.querySelector('.fader-fill');
    const thumb = wrap.querySelector('.fader-thumb');
    const valueEl = wrap.querySelector('.fader-value');
    const cfg = () => state.get().faders[i];

    // norm is the visual position 0..1 (bottom-up); invert only affects output.
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
    let startY = 0;
    let startNorm = 0;

    function paint() {
      const c = cfg();
      wrap.style.setProperty('--fader-color', c.color);
      wrap.querySelector('.fader-label').textContent = c.label;
      fill.style.height = `${norm * 100}%`;
      // keep the 44px thumb fully inside the track at both extremes
      thumb.style.top = `calc((100% - 44px) * ${1 - norm} + 22px)`;
      valueEl.textContent = fmt(valueOf(c, norm));
    }
    paint();
    state.subscribe(paint);

    function sendValue() {
      const v = valueOf(cfg(), norm);
      if (v === lastSent) return;
      lastSent = v;
      rogger.sendTyped(cfg().address, [{ type: 'f', value: v }]);
    }
    function schedule() {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        sendValue();
        paint();
      });
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
        norm = Math.min(1, Math.max(0, 1 - (e.clientY - rect.top) / rect.height));
      }
      startY = e.clientY;
      startNorm = norm;
      schedule();
    });

    track.addEventListener('pointermove', e => {
      if (!wrap.classList.contains('active')) return;
      const rect = track.getBoundingClientRect();
      const c = cfg();
      if (c.sensitivity >= 1) {
        norm = 1 - (e.clientY - rect.top) / rect.height;
      } else {
        norm = startNorm + ((startY - e.clientY) / rect.height) * c.sensitivity;
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

    // Bidirectional feedback: follow matching inbound OSC (e.g. the fader was
    // moved inside Resolume) unless a finger currently owns this fader.
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
  });
}
