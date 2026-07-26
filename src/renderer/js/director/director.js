// Director: the Visual Director's orchestrator. Ingests sidecar telemetry,
// evaluates the policy on musical events + a downbeat-ish tick, applies the
// operator's safety envelope (confidence tiers, safe mode, supervisor
// backoff, health monitoring) and executes through the intent executor.
// Boots DISARMED in suggest mode — it must be armed per session.
import { rogger } from '../bridge.js';
import * as state from '../state.js';
import { MusicState } from './music-state.js';
import { VisualState } from './visual-state.js';
import { decide } from './policy.js';
import { buildShowModel } from './show-model.js';
import { IntentExecutor } from './intent-executor.js';

const PREFIX = '/rogger/agent/';
// intent type → visual-state heat category (Hold/none stay unlisted)
const CATEGORY = {
  TriggerStrobe: 'strobe', TriggerFlash: 'flash', TriggerImpactFX: 'impact',
  TriggerCameraFX: 'camerafx', SwitchDeck: 'deckswitch',
  PrepareTransition: 'transition', PrepareNextClip: 'transition',
  IncreaseEnergy: 'energy', ReduceDensity: 'density',
};
const IMPACT_TENSION = { none: 0, low: 0.2, medium: 0.45, high: 0.85 };

export class Director {
  constructor() {
    this.cfg = () => state.get().director ?? {};
    this.music = new MusicState();
    this.visual = new VisualState(() => performance.now());
    this.executor = new IntentExecutor({
      send: (a, v) => rogger.send(a, v),
      getShowModel: () => this.showModel,
      getConfig: () => state.get(),
    });
    this.showModel = null;
    this.showModelHash = '';
    this.showModelError = null;
    this.armed = false;             // page-local, never persisted
    this.lastManualAt = -Infinity;  // supervisor: operator touch timestamp
    this.resumedAt = -Infinity;     // gentle takeback window start
    this.lastNotifyAt = 0;
    this.frameAvg = 16;             // rAF frame-time EMA (GPU/UI overload proxy)
    this.log = [];                  // ring buffer of decisions
    this.subs = new Set();
    this.lastDecision = null;
    this.safeMode = false;
    this.started = false;
  }

  subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  notify() { for (const fn of this.subs) fn(this); }

  start() {
    if (this.started) return;
    this.started = true;
    rogger.onMessage(msg => {
      if (!msg.address.startsWith(PREFIX)) return;
      const kind = msg.address.slice(PREFIX.length);
      this.music.ingest(kind, (msg.args ?? []).map(a => a.value));
      if (kind === 'event' || kind === 'downbeat') this.evaluate(kind === 'event');
    });
    // supervisor: any manual touch on the performance surface backs the AI off
    document.addEventListener('pointerdown', e => {
      if (e.target.closest?.('.fx-btn, .fader, .fader-h, .color-btn, .tempo-big, .lab-swatch, .morph-toggle, .sv-wrap, .hue-strip')) {
        this.lastManualAt = performance.now();
      }
    }, true);
    // UI/GPU overload proxy: sustained slow frames trip a health issue
    const frame = t0 => requestAnimationFrame(t1 => {
      this.frameAvg += 0.05 * ((t1 - t0) - this.frameAvg);
      frame(t1);
    });
    frame(performance.now());
    // steady heartbeat so the director still thinks with no downbeats arriving
    this.tick = setInterval(() => this.evaluate(false), 2000);
    this.rebuildTimer = setInterval(() => this.rebuildShowModel(), this.cfg().rebuildIntervalMs ?? 60000);
    this.rebuildShowModel();
  }

  async rebuildShowModel() {
    try {
      const comp = await rogger.inspectComposition();
      const hash = JSON.stringify((comp.layers ?? []).map(L =>
        [(L.name?.value ?? L.name ?? ''), (L.clips ?? []).map(c => c?.name?.value ?? c?.name ?? '')]));
      if (hash !== this.showModelHash) {
        this.showModel = buildShowModel(comp, this.cfg().protectedPatterns ?? []);
        const changed = this.showModelHash !== '';
        this.showModelHash = hash;
        if (changed) this.pushLog({ note: 'composition changed — semantic model rebuilt' });
      }
      this.showModelError = null;
    } catch (e) {
      this.showModelError = String(e?.message ?? e);
    }
    this.notify();
  }

  health() {
    const h = this.music.health();
    const issues = [...h.issues];
    if (this.showModelError) issues.push('resolume-api');
    if (!this.showModel) issues.push('no-show-model');
    if (this.frameAvg > 50) issues.push('ui-overload');
    return { ok: issues.length === 0, issues };
  }

  supervisorState() {
    const backoff = this.cfg().supervisorBackoffMs ?? 30000;
    const sinceManual = performance.now() - this.lastManualAt;
    if (sinceManual < backoff) return 'operator';
    if (sinceManual - backoff < 10000) return 'resuming'; // gentle takeback
    return 'ai';
  }

  // The full decision pipeline. eventDriven=true when a one-shot arrived.
  evaluate(eventDriven) {
    const cfg = this.cfg();
    const lastEvent = eventDriven ? this.music.takeEvent() : null;
    const health = this.health();
    const supervisor = this.supervisorState();

    let intent;
    let tier = 'act';
    if (!health.ok) {
      // unhealthy: don't get clever — hold a stable look (safe mode)
      this.safeMode = true;
      intent = {
        type: 'HoldCurrentVisual', confidence: 1, impact: 'none',
        reasoning: `safe mode — ${health.issues.join(', ')}`,
      };
      tier = 'safe';
    } else {
      this.safeMode = false;
      intent = decide(this.music.forPolicy(lastEvent), this.visual,
        this.showModel ?? { hasRole: () => false });
      const t = cfg.confidence ?? { act: 0.9, cautious: 0.65, hold: 0.4 };
      if (intent.confidence >= t.act) {
        tier = 'act';
      } else if (intent.confidence >= t.cautious) {
        tier = 'cautious';
        if (intent.impact === 'high') {
          intent = { ...intent, type: 'HoldCurrentVisual', impact: 'none',
            reasoning: `cautious tier — withholding high-impact ${intent.type}: ${intent.reasoning}` };
        }
      } else if (intent.confidence >= t.hold) {
        tier = 'hold';
        if (intent.type !== 'HoldCurrentVisual') {
          intent = { ...intent, type: 'HoldCurrentVisual', impact: 'none',
            reasoning: `confidence ${(intent.confidence * 100) | 0}% — holding instead of ${intent.type}` };
        }
      } else {
        tier = 'notify';
        intent = { ...intent, type: 'HoldCurrentVisual', impact: 'none' };
        const now = performance.now();
        if (now - this.lastNotifyAt > 30000) {
          this.lastNotifyAt = now;
          this.onNotify?.('Low confidence, manual attention recommended.');
        }
      }
    }

    // gentle takeback: right after the operator window, re-enter softly
    if (supervisor === 'resuming' && (intent.impact === 'high' || intent.impact === 'medium')) {
      intent = { ...intent, type: 'HoldCurrentVisual', impact: 'none',
        reasoning: `resuming after operator control — easing back in (was ${intent.type})` };
    }

    const auto = cfg.mode === 'auto' && this.armed && supervisor !== 'operator';
    let result = { executed: false, detail: auto ? '' : (supervisor === 'operator' ? 'operator has control' : 'suggest mode'), targets: [] };
    if (auto && intent.type !== 'HoldCurrentVisual') {
      result = this.executor.execute(intent);
      if (result.executed) {
        const cat = CATEGORY[intent.type];
        if (cat) this.visual.noteAction(cat, { intent: intent.type });
        this.visual.setTension(Math.max(this.visual.tension, IMPACT_TENSION[intent.impact] ?? 0));
      }
    }

    this.lastDecision = {
      at: Date.now(), intent, tier, supervisor, executed: result.executed,
      detail: result.detail, targets: result.targets,
      music: { section: this.music.section, bpm: this.music.bpm, phrasePos: this.music.phrasePos },
    };
    // only log meaningful moments: every non-Hold, every event, tier shifts
    if (intent.type !== 'HoldCurrentVisual' || lastEvent || tier !== 'act') {
      this.pushLog(this.lastDecision);
    }
    this.notify();
  }

  pushLog(entry) {
    this.log.push({ at: Date.now(), ...entry });
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
  }

  exportLog() {
    return this.log.map(e => JSON.stringify(e)).join('\n');
  }
}

export const director = new Director();
