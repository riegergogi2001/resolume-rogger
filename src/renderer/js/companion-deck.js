// Companion page: an emulated Stream Deck XL (8x4). The main process
// (src/main/companion.js) registers it with Companion's Satellite API; this
// page draws the 72x72 key bitmaps Companion renders and sends presses back.
import { rogger } from './bridge.js';
import * as state from './state.js';

const COLS = 8;
const KEYS = 32;
const SIZE = 72;
const STATUS_TEXT = {
  off: 'OFF',
  connecting: 'CONNECTING…',
  connected: 'CONNECTED',
  error: 'ERROR',
};

// The surface is rebuilt on every rerender; drop the previous page's listener.
let unsubscribe = null;

export function renderCompanionDeck(pageEl) {
  pageEl.classList.add('companion-page');
  const saved = state.get().ui?.companion ?? {};

  const head = document.createElement('div');
  head.className = 'bank-title companion-head';
  head.innerHTML = `<span>Companion · Stream Deck XL</span>
    <span class="companion-addr u-num"></span>
    <button class="mini-btn u-caps companion-toggle"></button>
    <span class="companion-status u-caps"></span>`;
  const addr = head.querySelector('.companion-addr');
  const target = () => {
    const c = state.get().ui?.companion ?? {};
    return { host: c.host || '127.0.0.1', port: Number(c.port) || 16622 };
  };
  const toggle = head.querySelector('.companion-toggle');
  const statusEl = head.querySelector('.companion-status');
  let enabled = !!saved.enabled;

  const deck = document.createElement('div');
  deck.className = 'companion-deck';
  deck.style.setProperty('--cols', COLS);
  const wrap = document.createElement('div');
  wrap.className = 'companion-wrap';
  wrap.appendChild(deck);
  pageEl.append(head, wrap);

  const keys = [];
  for (let k = 0; k < KEYS; k++) {
    const btn = document.createElement('button');
    btn.className = 'companion-key';
    btn.dataset.key = k;
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const label = document.createElement('span');
    label.className = 'companion-key-text';
    btn.append(canvas, label);
    const up = () => { btn.classList.remove('down'); rogger.companionPress?.(k, false); };
    btn.addEventListener('pointerdown', e => {
      btn.setPointerCapture(e.pointerId);
      btn.classList.add('down');
      rogger.companionPress?.(k, true);
    });
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    deck.appendChild(btn);
    keys.push({ btn, ctx: canvas.getContext('2d'), label });
  }

  function drawKey({ key, bitmap, color, text }) {
    const k = keys[key];
    if (!k) return;
    k.label.textContent = '';
    if (bitmap) {
      const rgb = Uint8Array.from(atob(bitmap), c => c.charCodeAt(0));
      if (rgb.length >= SIZE * SIZE * 3) {
        const img = k.ctx.createImageData(SIZE, SIZE);
        for (let i = 0, j = 0; i < SIZE * SIZE * 3; i += 3, j += 4) {
          img.data[j] = rgb[i]; img.data[j + 1] = rgb[i + 1]; img.data[j + 2] = rgb[i + 2]; img.data[j + 3] = 255;
        }
        k.ctx.putImageData(img, 0, 0);
        return;
      }
    }
    // no bitmap: fall back to colour + text
    k.ctx.fillStyle = color || '#000';
    k.ctx.fillRect(0, 0, SIZE, SIZE);
    k.label.textContent = text ?? '';
  }
  function clearAll() {
    keys.forEach(k => { k.ctx.clearRect(0, 0, SIZE, SIZE); k.label.textContent = ''; });
  }
  function showStatus(status, message) {
    const t = target();
    addr.textContent = `${t.host}:${t.port}`;
    statusEl.textContent = STATUS_TEXT[status] ?? status;
    statusEl.dataset.status = status;
    statusEl.title = message ?? '';
    if (status === 'error' && message) statusEl.textContent = `ERROR · ${message}`;
    toggle.textContent = enabled ? 'Disconnect' : 'Connect';
    deck.classList.toggle('offline', status !== 'connected');
  }

  toggle.addEventListener('click', async () => {
    enabled = !enabled;
    const opts = { ...target(), enabled };
    // keep the renderer's copy in step so a later config save doesn't undo it
    state.updateSection('ui', { companion: opts });
    if (!enabled) clearAll();
    const snap = await rogger.companionConnect?.(opts);
    showStatus(snap?.status ?? 'off');
  });

  unsubscribe?.();
  unsubscribe = rogger.onCompanion?.(ev => {
    if (ev.type === 'key') drawKey(ev);
    else if (ev.type === 'clear') clearAll();
    else if (ev.type === 'status') showStatus(ev.status, ev.message);
    else if (ev.type === 'brightness') deck.style.setProperty('--deck-brightness', Math.max(0.15, ev.value / 100));
  });
  state.subscribe(() => { const t = target(); addr.textContent = `${t.host}:${t.port}`; });
  showStatus('off');
  rogger.companionSnapshot?.().then(snap => {
    if (!snap) return;
    showStatus(snap.status);
    snap.keys.forEach(drawKey);
  });
}
