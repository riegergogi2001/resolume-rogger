// AGENT page: the AI VJ agent's cockpit. Renders the audio sidecar's OSC
// telemetry (/rogger/agent/*) — link state, BPM, band meters, section state,
// event log — and fires the armed cue rules (macros → Resolume) with
// per-rule cooldowns and pulse auto-release. Boots DISARMED, always.
import { rogger } from './bridge.js';
import * as state from './state.js';
import * as beat from './beat-clock.js';
import { showToast } from './toast.js';

const PREFIX = '/rogger/agent/';
const STATES = ['idle', 'build', 'drop', 'sustain', 'breakdown'];

export function renderAgentPage(el) {
  el.classList.add('agent-page');
  const cfg = () => state.get().agent ?? { rules: [] };

  let armed = false;               // page-local: never persisted
  const lastFired = new Map();     // rule id → ts

  // ---- header: link lamp, engine, bpm, state ----
  const head = document.createElement('div');
  head.className = 'agent-head';
  head.innerHTML =
    '<div class="agent-lamp u-caps" id="agent-lamp">OFFLINE</div>' +
    '<div class="agent-engine u-caps" id="agent-engine">—</div>' +
    '<div class="agent-bpm u-num" id="agent-bpm">— BPM</div>' +
    '<div class="agent-state u-caps" id="agent-state">idle</div>';
  const armBtn = document.createElement('button');
  armBtn.className = 'agent-arm u-caps';
  armBtn.textContent = 'ARM';
  armBtn.addEventListener('pointerdown', () => {
    armed = !armed;
    armBtn.classList.toggle('armed', armed);
    armBtn.textContent = armed ? 'ARMED' : 'ARM';
    showToast(armed ? 'Agent ARMED — cues will fire' : 'Agent disarmed');
  });
  head.appendChild(armBtn);

  const lamp = () => head.querySelector('#agent-lamp');
  const engineEl = () => head.querySelector('#agent-engine');
  const bpmEl = () => head.querySelector('#agent-bpm');
  const stateEl = () => head.querySelector('#agent-state');

  // ---- viz: band meters + energy history ----
  const viz = document.createElement('div');
  viz.className = 'agent-viz';
  const canvas = document.createElement('canvas');
  canvas.className = 'agent-canvas';
  viz.appendChild(canvas);
  const history = [];
  let bands = [0, 0, 0, 0];
  let beatFlash = 0;

  function draw() {
    const w = canvas.width = canvas.clientWidth || 400;
    const h = canvas.height = canvas.clientHeight || 110;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    // energy history sparkline (right of the bars)
    ctx.beginPath();
    const n = history.length;
    for (let i = 0; i < n; i++) {
      const x = w - (n - i) * 3;
      if (x < 130) continue;
      const y = h - history[i] * (h - 8) - 4;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(0,224,255,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // band bars
    const names = ['SUB', 'BASS', 'MID', 'HIGH'];
    const colors = ['#ff4757', '#ffb400', '#2ee66b', '#00e0ff'];
    bands.forEach((v, i) => {
      const bw = 22, x = 8 + i * 30;
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.fillRect(x, 4, bw, h - 20);
      ctx.fillStyle = colors[i];
      const bh = v * (h - 20);
      ctx.fillRect(x, 4 + (h - 20) - bh, bw, bh);
      ctx.fillStyle = '#8e9299';
      ctx.font = '700 8px Inter, sans-serif';
      ctx.fillText(names[i], x + 2, h - 6);
    });
    // beat pulse
    if (beatFlash > 0) {
      ctx.fillStyle = `rgba(0,224,255,${beatFlash * 0.5})`;
      ctx.beginPath();
      ctx.arc(w - 16, 16, 8, 0, 7);
      ctx.fill();
      beatFlash = Math.max(0, beatFlash - 0.08);
      requestAnimationFrame(draw);
    }
  }

  // ---- rules ----
  const rulesEl = document.createElement('div');
  rulesEl.className = 'agent-rules';
  const variantCursor = new Map();   // rule id → next variant index

  function fireRule(rule) {
    // variants rotate per fire so repeats vary the look
    const pool = rule.variants?.length ? rule.variants : [rule.macro ?? []];
    const n = variantCursor.get(rule.id) ?? 0;
    variantCursor.set(rule.id, (n + 1) % pool.length);
    const steps = pool[n % pool.length] ?? [];
    for (const step of steps) rogger.send(step.address, step.values ?? []);
    if (rule.pulseMs > 0) {
      setTimeout(() => {
        for (const step of steps) {
          rogger.send(step.address, (step.values ?? [1]).map(() => 0));
        }
      }, rule.pulseMs);
    }
  }

  function ruleSummary(rule) {
    const pool = rule.variants?.length ? rule.variants : [rule.macro ?? []];
    const first = pool[0]?.[0]?.address?.split('/').slice(-2).join('/') ?? 'no macro';
    const extra = pool.length > 1 ? ` +${pool.length - 1}var` : '';
    return `${rule.event} → ${first}${extra} · cd ${(rule.cooldownMs / 1000).toFixed(0)}s` +
      (rule.pulseMs ? ` · ${(rule.pulseMs / 1000).toFixed(1)}s` : '');
  }

  function buildRules() {
    rulesEl.innerHTML = '';
    (cfg().rules ?? []).forEach((rule, i) => {
      const row = document.createElement('div');
      row.className = 'agent-rule';
      row.dataset.rule = rule.id;
      row.innerHTML =
        `<button class="rule-enable ${rule.enabled ? 'on' : ''}"></button>` +
        `<div class="rule-main"><span class="rule-label u-caps">${rule.label}</span>` +
        `<span class="rule-macro u-num">${ruleSummary(rule)}</span></div>` +
        '<button class="rule-edit u-caps">Edit</button>' +
        '<button class="rule-test u-caps">Test</button>';
      row.querySelector('.rule-enable').addEventListener('pointerdown', () => {
        const rules = cfg().rules;
        rules[i].enabled = !rules[i].enabled;
        row.querySelector('.rule-enable').classList.toggle('on', rules[i].enabled);
        state.persist();
      });
      row.querySelector('.rule-edit').addEventListener('pointerdown', () => openCueEditor(i));
      row.querySelector('.rule-test').addEventListener('pointerdown', () => {
        fireRule(cfg().rules[i]);
        flashRule(rule.id);
      });
      rulesEl.appendChild(row);
    });
  }

  // ---- compact cue editor (label / event / timing / macro JSON) ----
  const CUE_EVENTS = ['drop', 'dropimminent', 'buildstart', 'breakdown', 'steady',
    'fakebuild', 'vocalstart', 'vocalend', 'downbeat', 'phrasestart'];

  function openCueEditor(i) {
    const root = document.getElementById('overlay-root');
    if (root.querySelector('.overlay')) return;
    const rule = cfg().rules[i];
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const macroJson = JSON.stringify(rule.variants?.length ? rule.variants : rule.macro, null, 1);
    overlay.innerHTML =
      '<div class="panel"><div class="panel-head u-caps">Edit cue</div>' +
      '<div class="panel-body cue-edit">' +
      `<label class="u-caps">Name<input id="cue-label" value="${rule.label}"></label>` +
      `<label class="u-caps">Event<select id="cue-event">${CUE_EVENTS.map(e =>
        `<option ${e === rule.event ? 'selected' : ''}>${e}</option>`).join('')}</select></label>` +
      `<label class="u-caps">Cooldown s<input id="cue-cd" type="number" step="0.5" value="${rule.cooldownMs / 1000}"></label>` +
      `<label class="u-caps">Pulse s (0 = latch)<input id="cue-pulse" type="number" step="0.1" value="${rule.pulseMs / 1000}"></label>` +
      '<label class="u-caps">Macro — steps, or list of variants' +
      `<textarea id="cue-macro" rows="8">${macroJson}</textarea></label>` +
      '</div><div class="panel-foot">' +
      '<button class="big-btn u-caps" id="cue-cancel">Cancel</button>' +
      '<button class="big-btn primary u-caps" id="cue-save">Save</button>' +
      '</div></div>';
    root.appendChild(overlay);
    overlay.querySelector('#cue-cancel').addEventListener('pointerdown', () => overlay.remove());
    overlay.querySelector('#cue-save').addEventListener('pointerdown', () => {
      let parsed;
      try {
        parsed = JSON.parse(overlay.querySelector('#cue-macro').value);
      } catch {
        showToast('Macro is not valid JSON', { error: true });
        return;
      }
      const rules = cfg().rules;
      const r = rules[i];
      r.label = overlay.querySelector('#cue-label').value || r.label;
      r.event = overlay.querySelector('#cue-event').value;
      r.cooldownMs = Math.max(0, Number(overlay.querySelector('#cue-cd').value) * 1000 || 0);
      r.pulseMs = Math.max(0, Number(overlay.querySelector('#cue-pulse').value) * 1000 || 0);
      if (Array.isArray(parsed) && Array.isArray(parsed[0])) {
        r.variants = parsed;
        r.macro = parsed[0];
      } else if (Array.isArray(parsed)) {
        r.macro = parsed;
        r.variants = [];
      }
      state.persist();
      buildRules();
      overlay.remove();
      showToast(`Cue "${r.label}" saved`);
    });
  }

  function flashRule(id) {
    const row = rulesEl.querySelector(`[data-rule="${id}"]`);
    if (!row) return;
    row.classList.remove('fired');
    void row.offsetWidth;
    row.classList.add('fired');
  }

  // ---- event log ----
  const log = document.createElement('div');
  log.className = 'agent-log u-num';
  function logLine(text, cls = '') {
    const d = new Date();
    const ts = `${String(d.getHours()).padStart(2, '0')}:` +
      `${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const line = document.createElement('div');
    line.className = 'log-line ' + cls;
    line.textContent = `${ts}  ${text}`;
    log.prepend(line);
    while (log.children.length > 24) log.lastChild.remove();
  }

  // ---- feed beat clock toggle + fader riders ----
  const opts = document.createElement('div');
  opts.className = 'agent-opts';
  const feedBtn = document.createElement('button');
  feedBtn.className = 'mini-btn u-caps';
  feedBtn.textContent = 'Feed beat clock';
  feedBtn.classList.toggle('on', !!cfg().feedBeatClock);
  feedBtn.addEventListener('pointerdown', () => {
    const a = cfg();
    a.feedBeatClock = !a.feedBeatClock;
    feedBtn.classList.toggle('on', a.feedBeatClock);
    state.persist();
  });
  opts.appendChild(feedBtn);
  (cfg().riders ?? []).forEach((rider, i) => {
    const b = document.createElement('button');
    b.className = 'mini-btn u-caps';
    b.textContent = `Ride ${rider.label}`;
    b.classList.toggle('on', rider.enabled);
    b.addEventListener('pointerdown', () => {
      const r = cfg().riders[i];
      r.enabled = !r.enabled;
      b.classList.toggle('on', r.enabled);
      state.persist();
    });
    opts.appendChild(b);
  });

  // ---- continuous fader riders: bands → layer opacity (armed only) ----
  // fast attack / slow release, ~12 Hz sends, only on real change
  const riderState = new Map();
  let lastMetrics = { energy: 0, tension: 0, vocal: 0 };
  let lastRideSend = 0;
  function processRiders(b) {
    if (!armed) return;
    const src = {
      sub: b[0] ?? 0, bass: b[1] ?? 0, mid: b[2] ?? 0, high: b[3] ?? 0,
      energy: lastMetrics.energy, tension: lastMetrics.tension, vocal: lastMetrics.vocal,
    };
    for (const r of cfg().riders ?? []) {
      if (!r.enabled || !r.address) continue;
      const v = Math.min(1, Math.max(0, src[r.source] ?? 0));
      const target = r.min + v * (r.max - r.min);
      const st = riderState.get(r.id) ?? { v: target, sent: -1 };
      st.v += (target - st.v) * (target > st.v ? 0.35 : 0.08);
      riderState.set(r.id, st);
    }
    const now = performance.now();
    if (now - lastRideSend < 80) return;
    lastRideSend = now;
    for (const r of cfg().riders ?? []) {
      if (!r.enabled || !r.address) continue;
      const st = riderState.get(r.id);
      if (st && Math.abs(st.v - st.sent) > 0.01) {
        st.sent = st.v;
        rogger.sendTyped(r.address, [{ type: 'f', value: st.v }]);
      }
    }
  }

  // ---- OSC ingestion ----
  let lastPing = 0;
  setInterval(() => {
    const online = performance.now() - lastPing < 3000;
    lamp().textContent = online ? 'ONLINE' : 'OFFLINE';
    lamp().classList.toggle('online', online);
  }, 500);

  function handleEvent(name) {
    logLine(`event: ${name}`, name === 'drop' ? 'log-drop' : '');
    (cfg().rules ?? []).forEach(rule => {
      if (rule.event !== name || !rule.enabled) return;
      const now = performance.now();
      if (!armed) return;
      if (now - (lastFired.get(rule.id) ?? -1e9) < rule.cooldownMs) return;
      lastFired.set(rule.id, now);
      fireRule(rule);
      flashRule(rule.id);
      logLine(`fired: ${rule.label}`, 'log-fired');
    });
  }

  rogger.onMessage(msg => {
    if (!msg.address.startsWith(PREFIX)) return;
    const kind = msg.address.slice(PREFIX.length);
    const args = (msg.args ?? []).map(a => a.value);
    if (kind === 'ping') {
      lastPing = performance.now();
    } else if (kind === 'engine') {
      engineEl().textContent = String(args[0] ?? '—').toUpperCase();
    } else if (kind === 'bpm') {
      const [bpm, conf] = args;
      bpmEl().textContent = `${Number(bpm).toFixed(1)} BPM · ${(Number(conf) * 100).toFixed(0)}%`;
      if (cfg().feedBeatClock && typeof bpm === 'number' && bpm > 0) beat.setAutoBpm(bpm);
    } else if (kind === 'beat') {
      beatFlash = 1;
      requestAnimationFrame(draw);
    } else if (kind === 'downbeat') {
      handleEvent('downbeat');
    } else if (kind === 'bands') {
      bands = args.map(Number);
      history.push(bands.reduce((a, b) => a + b, 0) / 4);
      if (history.length > 400) history.shift();
      draw();
      processRiders(bands);
    } else if (kind === 'metrics') {
      const [energy, tension, , , vocal] = args.map(Number);
      lastMetrics = { energy, tension, vocal };
    } else if (kind === 'state') {
      const s = String(args[0]);
      stateEl().textContent = s;
      STATES.forEach(x => stateEl().classList.toggle(`st-${x}`, x === s));
      logLine(`state: ${s}`);
    } else if (kind === 'event') {
      handleEvent(String(args[0]));
    }
  });

  const title = document.createElement('div');
  title.className = 'bank-title';
  title.innerHTML = 'AI VJ Agent <span class="apc-meta u-num">agent/rogger_agent.py · ' +
    'events fire only while ARMED</span>';

  buildRules();
  el.append(title, head, viz, rulesEl, opts, log);
  requestAnimationFrame(draw);
}
