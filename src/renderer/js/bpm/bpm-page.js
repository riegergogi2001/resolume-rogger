// BPM page: mic/line-in tempo analyser UI. Device pick, start/stop, level
// meter, lock + /2 + x2, "send tempo to Resolume" throttled sender, a
// resync-on-next-beat button, a huge readout with a beat-pulse dot, and a
// canvas scrolling the onset envelope with predicted-beat ticks.
import { rogger } from '../bridge.js';
import * as state from '../state.js';
import { showToast } from '../toast.js';
import * as beat from '../beat-clock.js';
import { createBpmAnalyser } from './bpm-analyser.js';

const SEND_MIN_INTERVAL_MS = 1000;
const SEND_MIN_CONFIDENCE = 0.6;
const SEND_MIN_DELTA = 0.5;

export function renderBpmPage(el) {
  el.classList.add('bpm-page');
  el.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'bank-title';
  title.textContent = 'BPM';

  const status = document.createElement('div');
  status.className = 'bpm-status u-caps';
  status.id = 'bpm-status';
  status.textContent = 'Idle — pick a device and press Start';

  const main = document.createElement('div');
  main.className = 'bpm-main';

  // ---- left column: controls ----
  const controls = document.createElement('div');
  controls.className = 'bpm-controls';

  const deviceSelect = document.createElement('select');
  deviceSelect.className = 'bpm-select';
  deviceSelect.id = 'bpm-device';

  const runBtn = document.createElement('button');
  runBtn.className = 'bpm-btn bpm-run u-caps';
  runBtn.id = 'bpm-run';
  runBtn.textContent = 'Start';

  const meterRow = document.createElement('div');
  meterRow.className = 'bpm-meter-row';
  const meterWrap = document.createElement('div');
  meterWrap.className = 'bpm-meter-wrap';
  const meterFill = document.createElement('div');
  meterFill.className = 'bpm-meter-fill';
  meterWrap.appendChild(meterFill);
  const meterLabel = document.createElement('div');
  meterLabel.className = 'bpm-meter-label u-caps';
  meterLabel.textContent = 'Level';
  meterRow.append(meterWrap, meterLabel);

  const lockBtn = document.createElement('button');
  lockBtn.className = 'bpm-btn bpm-lock u-caps';
  lockBtn.id = 'bpm-lock';
  lockBtn.textContent = 'Lock';

  const scaleRow = document.createElement('div');
  scaleRow.className = 'bpm-btn-row';
  const halfBtn = document.createElement('button');
  halfBtn.className = 'bpm-btn u-num';
  halfBtn.id = 'bpm-half';
  halfBtn.textContent = '÷2';
  const dblBtn = document.createElement('button');
  dblBtn.className = 'bpm-btn u-num';
  dblBtn.id = 'bpm-double';
  dblBtn.textContent = '×2';
  scaleRow.append(halfBtn, dblBtn);

  const sendBtn = document.createElement('button');
  sendBtn.className = 'bpm-btn bpm-send u-caps';
  sendBtn.id = 'bpm-send';
  sendBtn.textContent = 'Send Tempo to Resolume';

  const resyncBtn = document.createElement('button');
  resyncBtn.className = 'bpm-btn bpm-resync u-caps';
  resyncBtn.id = 'bpm-resync';
  resyncBtn.textContent = 'Resync on Next Beat';

  controls.append(deviceSelect, runBtn, meterRow, lockBtn, scaleRow, sendBtn, resyncBtn);

  // ---- centre: big readout ----
  const centre = document.createElement('div');
  centre.className = 'bpm-centre';

  const dot = document.createElement('div');
  dot.className = 'bpm-dot';
  dot.id = 'bpm-dot';

  const value = document.createElement('div');
  value.className = 'bpm-value u-num';
  value.id = 'bpm-value';
  value.textContent = '—';

  const confBar = document.createElement('div');
  confBar.className = 'bpm-conf-bar';
  const confFill = document.createElement('div');
  confFill.className = 'bpm-conf-fill';
  confBar.appendChild(confFill);

  const raw = document.createElement('div');
  raw.className = 'bpm-raw u-num';
  raw.id = 'bpm-raw';
  raw.textContent = 'raw —';

  centre.append(dot, value, confBar, raw);
  main.append(controls, centre);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'bpm-canvas-wrap';
  const canvas = document.createElement('canvas');
  canvas.className = 'bpm-canvas';
  canvas.id = 'bpm-canvas';
  canvasWrap.appendChild(canvas);

  el.append(title, status, main, canvasWrap);

  // ---- wiring ----
  const cfg = () => state.get().beat ?? {};
  let locked = false;
  let sendOn = !!cfg().micSendTempo;
  sendBtn.classList.toggle('latched', sendOn);
  let lastSentBpm = null;
  let lastSentAt = 0;

  function drawCanvas() {
    const tracker = analyser.tracker;
    const w = (canvas.width = canvas.clientWidth || 600);
    const h = (canvas.height = canvas.clientHeight || 160);
    const ctx2d = canvas.getContext('2d');
    ctx2d.clearRect(0, 0, w, h);
    if (!tracker) return;
    const env = tracker.getOnsetEnvelope();
    if (env.length < 2) return;
    let maxV = 1e-6;
    for (const v of env) if (v > maxV) maxV = v;

    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#00e0ff';
    ctx2d.strokeStyle = accent;
    ctx2d.lineWidth = 2;
    ctx2d.beginPath();
    const n = env.length;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - (env[i] / maxV) * (h - 6) - 3;
      if (i === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();

    const info = tracker.predictBeats();
    if (info && info.periodMs > 0) {
      const msPerHop = tracker.msPerHop();
      const periodHops = info.periodMs / msPerHop;
      const phaseHops = info.phaseMs / msPerHop;
      ctx2d.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx2d.lineWidth = 1;
      let idx = n - 1 - phaseHops;
      while (idx >= 0) {
        const x = (idx / (n - 1)) * w;
        ctx2d.beginPath();
        ctx2d.moveTo(x, 0);
        ctx2d.lineTo(x, h);
        ctx2d.stroke();
        idx -= periodHops;
      }
    }
  }

  function handleUpdate(s) {
    value.textContent = s.bpm != null ? s.bpm.toFixed(1) : '—';
    raw.textContent = s.rawBpm != null ? `raw ${s.rawBpm.toFixed(1)}` : 'raw —';
    confFill.style.width = `${Math.round((s.confidence ?? 0) * 100)}%`;
    meterFill.style.height = `${Math.round(Math.min(1, s.level ?? 0) * 100)}%`;

    if (s.beat) {
      dot.classList.remove('flash');
      void dot.offsetWidth; // restart the animation
      dot.classList.add('flash');
    }

    if (s.running) {
      status.textContent = s.deviceLabel ? `Listening: ${s.deviceLabel}` : 'Listening…';
    }

    beat.setMicBpm(s.bpm);

    if (sendOn && s.bpm != null && s.confidence >= SEND_MIN_CONFIDENCE) {
      const now = performance.now();
      const bigEnoughChange = lastSentBpm == null || Math.abs(s.bpm - lastSentBpm) >= SEND_MIN_DELTA;
      if (bigEnoughChange && now - lastSentAt >= SEND_MIN_INTERVAL_MS) {
        rogger.sendTyped('/composition/tempocontroller/tempo', [{ type: 'f', value: (s.bpm - 20) / 480 }]);
        lastSentBpm = s.bpm;
        lastSentAt = now;
      }
    }

    drawCanvas();
  }

  const analyser = createBpmAnalyser({ onUpdate: handleUpdate });

  async function refreshDevices() {
    try {
      const devices = await analyser.listDevices();
      const want = cfg().micDeviceId;
      deviceSelect.innerHTML = '';
      devices.forEach((d, i) => {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || `Microphone ${i + 1}`;
        deviceSelect.appendChild(opt);
      });
      if (want && devices.some(d => d.deviceId === want)) deviceSelect.value = want;
    } catch {
      showToast('Could not list audio input devices', { error: true });
      status.textContent = 'Error: could not list audio devices';
    }
  }
  refreshDevices();

  deviceSelect.addEventListener('change', () => {
    if (state.get().beat) state.get().beat.micDeviceId = deviceSelect.value;
    state.persist();
  });

  async function doStart() {
    if (analyser.isRunning()) return;
    try {
      await analyser.start(deviceSelect.value || undefined);
      runBtn.textContent = 'Stop';
      runBtn.classList.add('latched');
      status.textContent = 'Listening…';
      if (state.get().beat) state.get().beat.micAutoStart = true;
      state.persist();
    } catch (err) {
      const msg = err?.message || 'Microphone permission denied';
      showToast(msg, { error: true });
      status.textContent = `Error: ${msg}`;
    }
  }
  function doStop() {
    analyser.stop();
    runBtn.textContent = 'Start';
    runBtn.classList.remove('latched');
    status.textContent = 'Stopped';
    if (state.get().beat) state.get().beat.micAutoStart = false;
    state.persist();
  }
  runBtn.addEventListener('pointerdown', () => {
    if (analyser.isRunning()) doStop(); else doStart();
  });
  if (cfg().micAutoStart) doStart();

  lockBtn.addEventListener('pointerdown', () => {
    locked = !locked;
    analyser.lock(locked);
    lockBtn.classList.toggle('latched', locked);
  });

  halfBtn.addEventListener('pointerdown', () => { analyser.scale(0.5); beat.scaleBeat(2); });
  dblBtn.addEventListener('pointerdown', () => { analyser.scale(2); beat.scaleBeat(0.5); });

  sendBtn.addEventListener('pointerdown', () => {
    sendOn = !sendOn;
    sendBtn.classList.toggle('latched', sendOn);
    if (state.get().beat) state.get().beat.micSendTempo = sendOn;
    state.persist();
  });

  resyncBtn.addEventListener('pointerdown', () => {
    const tracker = analyser.tracker;
    const ms = tracker?.nextBeatIn();
    if (ms == null) { showToast('No beat detected yet', { error: true }); return; }
    setTimeout(() => {
      rogger.sendTyped('/composition/tempocontroller/resync', [{ type: 'i', value: 1 }]);
      setTimeout(() => rogger.sendTyped('/composition/tempocontroller/resync', [{ type: 'i', value: 0 }]), 40);
    }, Math.max(0, ms));
  });

  requestAnimationFrame(drawCanvas);
}
