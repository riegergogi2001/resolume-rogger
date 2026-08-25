// Top bar: wordmark, OSC target readout, status lamp, EDIT latch, settings.
import { rogger } from './bridge.js';
import * as state from './state.js';
import * as beat from './beat-clock.js';

export function renderTopbar(el, { onToggleEdit, onOpenSettings }) {
  el.innerHTML = '';
  const mark = document.createElement('div');
  mark.className = 'wordmark';
  mark.innerHTML = 'R<b>O</b>GGER';

  const target = document.createElement('div');
  target.className = 'target-readout u-num';

  const spacer = document.createElement('div');
  spacer.className = 'topbar-spacer';

  // Persistent warning when the OSC engine could not bind the configured
  // listen port and is on a fallback one: commands still land, but nothing
  // from Resolume will arrive until the port is freed or changed. A toast
  // would be gone in seconds; this stays until the port is right.
  const warn = document.createElement('div');
  warn.className = 'listen-warn trig-readout u-caps';
  warn.id = 'listen-warn';
  warn.hidden = true;

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

  // beat clock readout (shared beat-clock module; repeats can sync to it)
  const bpm = document.createElement('div');
  bpm.className = 'bpm-readout u-caps u-num';
  bpm.id = 'bpm-readout';
  function refreshBpm() {
    const ms = beat.beatMs();
    bpm.textContent = ms ? `${(60000 / ms).toFixed(1)} bpm · ${Math.round(ms)} ms` : '— bpm';
  }
  refreshBpm();
  // beat pulse: the readout flashes on the beat, tinted by the last picked color
  function refreshPulse() {
    const ms = beat.beatMs();
    if (!ms) { bpm.classList.remove('pulsing'); return; }
    bpm.style.animationDuration = `${Math.round(ms)}ms`;
    bpm.classList.remove('pulsing');
    void bpm.offsetWidth; // restart the animation from phase zero
    bpm.classList.add('pulsing');
  }
  beat.onChange(() => { refreshBpm(); refreshPulse(); });
  function multButton(id, label, factor) {
    const btn = document.createElement('button');
    btn.className = 'mini-btn u-num';
    btn.id = id;
    btn.textContent = label;
    btn.addEventListener('pointerdown', () => beat.scaleBeat(factor));
    return btn;
  }
  // BPM-centric: /2 halves the displayed BPM (doubles the beat time), x2 doubles it
  const half = multButton('bpm-half', '÷2', 2);
  const dbl = multButton('bpm-double', '×2', 0.5);

  // beat source: manual taps, auto-follow the target app's BPM, or the mic
  // analyser (BPM page). Cycles TAP -> AUTO -> MIC -> TAP.
  const SOURCE_LABELS = { tap: 'Tap', auto: 'Auto', mic: 'Mic' };
  const SOURCE_CYCLE = ['tap', 'auto', 'mic'];
  const srcBtn = document.createElement('button');
  srcBtn.className = 'mini-btn u-caps';
  srcBtn.id = 'bpm-source';
  function applySource(src) {
    beat.setMode(src);
    srcBtn.textContent = SOURCE_LABELS[src] ?? 'Tap';
    srcBtn.classList.toggle('on', src !== 'tap');
    if (src === 'auto') {
      rogger.seedBpm().then(bpm => { if (bpm) beat.setAutoBpm(bpm); }).catch(() => {});
    }
  }
  srcBtn.addEventListener('pointerdown', () => {
    const cur = SOURCE_CYCLE.indexOf(beat.getMode());
    const next = SOURCE_CYCLE[(cur + 1) % SOURCE_CYCLE.length] ?? 'tap';
    if (state.get().beat) state.get().beat.source = next;
    state.persist();
    applySource(next);
  });
  applySource(state.get().beat?.source ?? 'tap');
  rogger.onMessage(msg => {
    if (msg.address !== '/composition/tempocontroller/tempo') return;
    const a = msg.args?.[0];
    if (!a || typeof a.value !== 'number') return;
    beat.setAutoBpm(20 + a.value * 480); // tempo feedback arrives normalized
  });

  const tap = tempoButton('tap-tempo', 'Tap', '/composition/tempocontroller/tempotap', beat.tap);
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
    const s = state.get().sticks ?? {};
    const parts = [];
    if (t.lt?.enabled) parts.push(t.lt.label || 'LT');
    if (t.rt?.enabled) parts.push(t.rt.label || 'RT');
    if (s.ls?.enabled) parts.push(s.ls.label || 'LS');
    if (s.rs?.enabled) parts.push(s.rs.label || 'RS');
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

  el.append(mark, target, trig, warn, spacer, bpm, srcBtn, half, dbl, batt, clock, tap, resync, pill, edit, gear);

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

  // The topbar is full at the window floor by design (nothing in it shrinks),
  // so the warning takes the trigger readout's slot rather than adding one:
  // that readout is a reminder of the LT/RT/LS/RS labels, this is a fault.
  function setListen(info) {
    const bad = Boolean(info?.fallback);
    warn.hidden = !bad;
    trig.hidden = bad;
    if (bad) warn.textContent = `NO FEEDBACK · PORT ${info.configured} BUSY · SETTINGS → NETWORK`;
  }
  rogger.getListen?.().then(setListen).catch(() => {});
  rogger.onListen?.(setListen);
}
