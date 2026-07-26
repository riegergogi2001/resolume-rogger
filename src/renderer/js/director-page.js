// DIRECTOR page: cockpit for the AI Visual Director. Shows what it hears
// (music state), what it remembers (visual state), what it decided and WHY —
// and holds the safety controls: suggest/auto, AUTOPILOT arm, supervisor and
// health readouts. Boots disarmed in suggest mode.
import * as state from './state.js';
import { showToast } from './toast.js';
import { director } from './director/director.js';

const METRIC_KEYS = ['energy', 'tension', 'bass', 'density', 'vocal'];
const HEAT_KEYS = ['strobe', 'flash', 'impact', 'camerafx', 'transition', 'deckswitch'];

export function renderDirectorPage(el) {
  el.classList.add('director-page');
  const cfg = () => state.get().director ?? {};

  const title = document.createElement('div');
  title.className = 'bank-title';
  title.innerHTML = 'AI Visual Director <span class="apc-meta u-num">decides WHAT · ' +
    'ROGGER decides HOW · never touches protected layers</span>';

  // ---- control strip ----
  const head = document.createElement('div');
  head.className = 'dir-head';
  const linkLamp = chip('dir-lamp', 'OFFLINE');
  const supChip = chip('dir-sup', 'AI');
  const healthChip = chip('dir-health', '—');
  // BRAIN chip: toggles the local-model decision layer (LM Studio/Ollama)
  const brainChip = document.createElement('button');
  brainChip.className = 'dir-chip dir-brain u-caps';
  brainChip.textContent = 'BRAIN OFF';
  brainChip.addEventListener('pointerdown', () => {
    const d = cfg();
    d.brain = { ...(d.brain ?? {}), enabled: !d.brain?.enabled };
    state.persist();
    director.brain.refreshStatus();
    showToast(d.brain.enabled
      ? 'Brain on — local model decides when reachable'
      : 'Brain off — heuristic policy decides');
  });
  const modeBtn = document.createElement('button');
  modeBtn.className = 'dir-mode u-caps';
  function refreshMode() {
    modeBtn.textContent = (cfg().mode ?? 'suggest') === 'auto' ? 'MODE: AUTO' : 'MODE: SUGGEST';
    modeBtn.classList.toggle('auto', cfg().mode === 'auto');
  }
  modeBtn.addEventListener('pointerdown', () => {
    const d = cfg();
    d.mode = d.mode === 'auto' ? 'suggest' : 'auto';
    state.persist();
    refreshMode();
  });
  refreshMode();
  const armBtn = document.createElement('button');
  armBtn.className = 'agent-arm u-caps';
  armBtn.textContent = 'AUTOPILOT';
  armBtn.addEventListener('pointerdown', () => {
    director.armed = !director.armed;
    armBtn.classList.toggle('armed', director.armed);
    armBtn.textContent = director.armed ? 'AUTOPILOT ON' : 'AUTOPILOT';
    showToast(director.armed
      ? 'Visual Director armed — will act in AUTO mode'
      : 'Visual Director disarmed');
  });
  head.append(linkLamp, supChip, healthChip, brainChip, modeBtn, armBtn);

  function chip(cls, text) {
    const d = document.createElement('div');
    d.className = `dir-chip ${cls} u-caps`;
    d.textContent = text;
    return d;
  }

  // ---- music readout ----
  const musicRow = document.createElement('div');
  musicRow.className = 'dir-music';
  musicRow.innerHTML =
    '<div class="dir-bpm u-num" id="dir-bpm">— BPM</div>' +
    '<div class="dir-section u-caps" id="dir-section">idle</div>' +
    '<div class="dir-phrase"><div class="dir-phrase-fill" id="dir-phrase-fill"></div>' +
    '<span class="u-num" id="dir-phrase-text">bar —</span></div>' +
    '<div class="dir-predict u-num" id="dir-predict"></div>';

  // ---- metrics + memory gauges ----
  const gauges = document.createElement('div');
  gauges.className = 'dir-gauges';
  const mkGauge = (id, label) => {
    const g = document.createElement('div');
    g.className = 'dir-gauge';
    g.innerHTML = `<span class="u-caps">${label}</span><div class="g-track"><div class="g-fill" id="g-${id}"></div></div>`;
    return g;
  };
  METRIC_KEYS.forEach(k => gauges.appendChild(mkGauge(`m-${k}`, k)));
  gauges.appendChild(mkGauge('m-vtension', 'vis·tension'));
  HEAT_KEYS.forEach(k => gauges.appendChild(mkGauge(`h-${k}`, `${k} heat`)));

  // ---- latest decision ----
  const decision = document.createElement('div');
  decision.className = 'dir-decision';
  decision.innerHTML = '<div class="dir-intent u-caps" id="dir-intent">—</div>' +
    '<div class="dir-reason" id="dir-reason">Waiting for the music intelligence…</div>';

  // ---- decision log + show model ----
  const foot = document.createElement('div');
  foot.className = 'dir-foot';
  const log = document.createElement('div');
  log.className = 'agent-log u-num';
  const model = document.createElement('div');
  model.className = 'dir-model';
  const modelText = document.createElement('div');
  modelText.className = 'dir-model-text u-num';
  const rebuild = document.createElement('button');
  rebuild.className = 'mini-btn u-caps';
  rebuild.textContent = 'Re-inspect comp';
  rebuild.addEventListener('pointerdown', () => director.rebuildShowModel());
  const exportBtn = document.createElement('button');
  exportBtn.className = 'mini-btn u-caps';
  exportBtn.textContent = 'Copy log';
  exportBtn.addEventListener('pointerdown', () => {
    navigator.clipboard?.writeText(director.exportLog())
      .then(() => showToast('Decision log copied as JSONL'))
      .catch(() => showToast('Clipboard unavailable', { error: true }));
  });
  model.append(modelText, rebuild, exportBtn);
  foot.append(log, model);

  el.append(title, head, musicRow, gauges, decision, foot);

  // ---- live refresh ----
  const q = id => el.querySelector(`#${id}`);
  const setFill = (id, v, warnAt = 2) => {
    const f = q(`g-${id}`);
    if (!f) return;
    const pct = Math.min(1, Math.max(0, v));
    f.style.width = `${pct * 100}%`;
    f.classList.toggle('hot', v >= warnAt * 0.5);
  };
  let lastLogged = 0;

  function refresh() {
    const m = director.music;
    const online = performance.now() - m.lastPing < 3500;
    linkLamp.textContent = online ? (m.engine ?? 'ONLINE').toUpperCase() : 'OFFLINE';
    linkLamp.classList.toggle('online', online);
    const sup = director.supervisorState();
    supChip.textContent = sup === 'operator' ? 'OPERATOR' : sup === 'resuming' ? 'RESUMING' : 'AI';
    supChip.classList.toggle('warn', sup !== 'ai');
    const h = director.health();
    healthChip.textContent = h.ok ? 'HEALTHY' : h.issues[0];
    healthChip.classList.toggle('bad', !h.ok);
    const br = director.brain;
    const brainOn = !!cfg().brain?.enabled;
    brainChip.textContent = !brainOn ? 'BRAIN OFF'
      : br.status === 'ready' ? `🧠 ${br.model.split(/[/\\]/).pop().slice(0, 16)}`
        : br.status.startsWith('error') ? 'BRAIN ERR' : 'BRAIN …';
    brainChip.classList.toggle('online', brainOn && br.status === 'ready');
    brainChip.classList.toggle('bad', brainOn && br.status.startsWith('error'));

    q('dir-bpm').textContent = m.bpm
      ? `${m.bpm.toFixed(1)} BPM · ${(m.confidence * 100).toFixed(0)}%` : '— BPM';
    const sec = q('dir-section');
    sec.textContent = m.section;
    ['idle', 'build', 'drop', 'sustain', 'breakdown'].forEach(s =>
      sec.classList.toggle(`st-${s}`, s === m.section));
    q('dir-phrase-fill').style.width = `${((m.phrasePos + 1) / m.phraseLen) * 100}%`;
    q('dir-phrase-text').textContent = `bar ${m.phrasePos + 1}/${m.phraseLen} · #${m.bar}`;
    const p = m.currentPrediction();
    q('dir-predict').textContent = p
      ? `DROP in ~${p.beatsUntil} beats (${(p.confidence * 100).toFixed(0)}%)` : '';

    METRIC_KEYS.forEach(k => setFill(`m-${k}`, m.metrics[k] ?? 0));
    setFill('m-vtension', director.visual.tension);
    const snap = director.visual.snapshot();
    HEAT_KEYS.forEach(k => setFill(`h-${k}`, (snap.heats[k] ?? 0) / 2, 2));

    const d = director.lastDecision;
    if (d) {
      q('dir-intent').textContent =
        `${d.intent.type} · ${(d.intent.confidence * 100).toFixed(0)}% · ${d.tier}`;
      q('dir-reason').textContent =
        d.intent.reasoning + (d.executed ? ` → ${d.detail}` : d.detail ? ` (${d.detail})` : '');
    }
    if (director.log.length !== lastLogged) {
      lastLogged = director.log.length;
      log.innerHTML = '';
      director.log.slice(-24).reverse().forEach(e => {
        const line = document.createElement('div');
        const cls = e.executed ? 'log-fired' : (e.tier === 'safe' || e.tier === 'notify') ? 'log-drop' : '';
        line.className = `log-line ${cls}`;
        const ts = new Date(e.at).toTimeString().slice(0, 8);
        line.textContent = e.note
          ? `${ts}  ${e.note}`
          : `${ts}  [${e.tier}] ${e.intent.type} ${(e.intent.confidence * 100).toFixed(0)}% — ${e.intent.reasoning}`;
        log.appendChild(line);
      });
    }
    const sm = director.showModel;
    const look = director.brain.lastLook;
    const lookTxt = look
      ? ` · look ${look.ok ? '✓' : '✗'} ${(look.score * 100) | 0}%${look.notes ? ` — ${look.notes}` : ''}`
      : '';
    modelText.textContent = (sm
      ? `${sm.stats.layers} layers · ${sm.stats.protectedCount} protected · ` +
        `${sm.stats.clips} clips · roles: ${Object.keys(sm.clipsByRole ?? {}).filter(r => sm.hasRole(r)).join(', ') || '—'}`
      : `no show model${director.showModelError ? ` — ${director.showModelError}` : ''}`) + lookTxt;
  }

  director.onNotify = msg => showToast(msg, { error: true });
  director.subscribe(refresh);
  setInterval(refresh, 500);
  refresh();
  director.start();
}
