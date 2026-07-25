// Top bar: wordmark, OSC target readout, status lamp, EDIT latch, settings.
import { rogger } from './bridge.js';
import * as state from './state.js';

export function renderTopbar(el, { onToggleEdit, onOpenSettings }) {
  el.innerHTML = '';
  const mark = document.createElement('div');
  mark.className = 'wordmark';
  mark.innerHTML = 'R<b>O</b>GGER';

  const target = document.createElement('div');
  target.className = 'target-readout u-num';

  const spacer = document.createElement('div');
  spacer.className = 'topbar-spacer';

  const pill = document.createElement('div');
  pill.className = 'status-pill u-caps';
  pill.dataset.status = 'offline';
  pill.innerHTML = '<span class="dot"></span><span class="status-text">OFFLINE</span>';

  // dedicated tempo controls — always one touch away
  function tempoButton(id, label, address, onPress) {
    const btn = document.createElement('button');
    btn.className = 'topbar-btn u-caps';
    btn.id = id;
    btn.textContent = label;
    btn.addEventListener('pointerdown', e => {
      btn.setPointerCapture(e.pointerId);
      rogger.sendTyped(address, [{ type: 'i', value: 1 }]);
      if (onPress) onPress();
    });
    const up = () => rogger.sendTyped(address, [{ type: 'i', value: 0 }]);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    return btn;
  }

  // beat clock derived locally from the tap button (display only, no OSC)
  let taps = [];
  let beatMult = 1;
  const bpm = document.createElement('div');
  bpm.className = 'bpm-readout u-caps u-num';
  bpm.id = 'bpm-readout';
  function beatMs() {
    if (taps.length < 2) return null;
    return ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)) * beatMult;
  }
  function refreshBpm() {
    const ms = beatMs();
    bpm.textContent = ms ? `${(60000 / ms).toFixed(1)} bpm · ${Math.round(ms)} ms` : '— bpm';
  }
  refreshBpm();
  function onTap() {
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 8) taps.shift();
    beatMult = 1;
    refreshBpm();
  }
  function multButton(id, label, factor) {
    const btn = document.createElement('button');
    btn.className = 'mini-btn u-num';
    btn.id = id;
    btn.textContent = label;
    btn.addEventListener('pointerdown', () => {
      beatMult = Math.min(4, Math.max(0.25, beatMult * factor));
      refreshBpm();
    });
    return btn;
  }
  const half = multButton('bpm-half', '÷2', 0.5);
  const dbl = multButton('bpm-double', '×2', 2);

  const tap = tempoButton('tap-tempo', 'Tap', '/composition/tempocontroller/tempotap', onTap);
  const resync = tempoButton('tap-resync', 'Resync', '/composition/tempocontroller/resync');

  // battery + clock — show hardware state on a kiosk screen
  const batt = document.createElement('div');
  batt.className = 'meta-readout u-num';
  batt.id = 'battery-readout';
  if (navigator.getBattery) {
    navigator.getBattery().then(b => {
      const upd = () => {
        batt.textContent = `${Math.round(b.level * 100)}%${b.charging ? ' ⚡' : ''}`;
        batt.classList.toggle('warn', b.level < 0.2 && !b.charging);
      };
      upd();
      b.addEventListener('levelchange', upd);
      b.addEventListener('chargingchange', upd);
    }).catch(() => { batt.style.display = 'none'; });
  } else {
    batt.style.display = 'none';
  }
  const clock = document.createElement('div');
  clock.className = 'meta-readout u-num';
  clock.id = 'clock-readout';
  function updClock() {
    const d = new Date();
    clock.textContent =
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  updClock();
  setInterval(updClock, 10000);

  // analog trigger assignments are invisible hardware — surface them
  const trig = document.createElement('div');
  trig.className = 'trig-readout u-caps';
  function refreshTrig() {
    const t = state.get().triggers ?? {};
    const parts = [];
    if (t.lt?.enabled) parts.push(t.lt.label || 'LT');
    if (t.rt?.enabled) parts.push(t.rt.label || 'RT');
    trig.textContent = parts.join('  ·  ');
    trig.style.display = parts.length ? '' : 'none';
  }
  refreshTrig();
  state.subscribe(refreshTrig);

  const edit = document.createElement('button');
  edit.className = 'topbar-btn u-caps';
  edit.id = 'edit-toggle';
  edit.textContent = 'Edit';
  edit.addEventListener('pointerdown', () => {
    const on = onToggleEdit();
    edit.classList.toggle('latched', on);
  });

  const gear = document.createElement('button');
  gear.className = 'topbar-btn';
  gear.id = 'settings-open';
  gear.setAttribute('aria-label', 'Settings');
  gear.textContent = '⚙';
  gear.addEventListener('pointerdown', onOpenSettings);

  el.append(mark, target, trig, spacer, bpm, half, dbl, batt, clock, tap, resync, pill, edit, gear);

  function refreshTarget() {
    const n = state.get().network;
    target.textContent = `${n.targetIp}:${n.targetPort}`;
  }
  refreshTarget();
  state.subscribe(refreshTarget);

  function setStatus(s) {
    pill.dataset.status = s;
    pill.querySelector('.status-text').textContent = s.toUpperCase();
  }
  rogger.getStatus().then(setStatus);
  rogger.onStatus(setStatus);
}
