// Brain driver: lets a local model (LM Studio / Ollama) make the Director's
// decisions. Decisions are requested asynchronously on a bar cadence so the
// realtime loop never blocks on inference; the freshest validated plan is
// consumed by Director.evaluate(). A vision model periodically reviews a
// screenshot of the output display and its verdict feeds the next decision.
// Everything the model says passes through brain-schema validation, and the
// heuristic policy remains the fallback whenever the model is off, slow or
// talking nonsense.
import { rogger } from '../bridge.js';
import * as state from '../state.js';
import {
  decisionSystemPrompt, decisionUserPrompt, parseDecision,
  lookSystemPrompt, parseLook,
} from './brain-schema.js';

const VISION_RE = /vl|vision|llava|moondream|pixtral/i;

export class Brain {
  constructor({ music, visual, show, log }) {
    this.music = music;   // () => MusicState
    this.visual = visual; // () => VisualState
    this.show = show;     // () => showModel | null
    this.log = log;       // note => void
    this.status = 'off';  // off | ready | error:<why>
    this.model = '';
    this.visionModel = '';
    this.plan = null;     // { intent, extras, at }
    this.lastLook = null; // { ok, score, notes, at }
    this.inflight = false;
    this.barCount = 0;
    this.lastDecideMs = 0;
    this.timers = [];
  }

  cfg() { return state.get().director?.brain ?? {}; }
  enabled() { return !!this.cfg().enabled; }

  start() {
    this.refreshStatus();
    this.timers.push(setInterval(() => this.refreshStatus(), 10000));
    this.timers.push(setInterval(() => this.look(), Math.max(15000, this.cfg().lookEveryMs ?? 45000)));
  }

  async refreshStatus() {
    if (!this.enabled()) { this.status = 'off'; return; }
    try {
      const models = await rogger.brainModels();
      const want = this.cfg().model;
      this.model = (want && models.includes(want)) ? want
        : models.find(m => !VISION_RE.test(m)) ?? models[0] ?? '';
      const wantV = this.cfg().visionModel;
      this.visionModel = wantV === 'off' ? ''
        : (wantV && models.includes(wantV)) ? wantV
          : models.find(m => VISION_RE.test(m)) ?? '';
      this.status = this.model ? 'ready' : 'error:no model loaded';
    } catch (e) {
      this.status = 'error:' + String(e?.message ?? e).slice(0, 60);
      this.model = '';
    }
  }

  // Called by the Director on every downbeat.
  onDownbeat() {
    this.barCount += 1;
    const every = Math.max(1, this.cfg().decideEveryBars ?? 8);
    if (this.enabled() && this.model && this.barCount % every === 0) this.decide();
  }

  async decide() {
    if (this.inflight) return;
    this.inflight = true;
    const t0 = performance.now();
    try {
      const m = this.music();
      const snap = this.visual().snapshot();
      const show = this.show();
      const user = decisionUserPrompt({
        music: {
          bpm: m.bpm, section: m.section,
          msInSection: performance.now() - (m.sectionSince ?? performance.now()),
          bar: m.bar, phrasePos: m.phrasePos, phraseLen: m.phraseLen,
          metrics: m.metrics,
        },
        visual: { tension: this.visual().tension, heats: snap.heats, fatigue: snap.fatigue },
        roles: show ? Object.keys(show.clipsByRole ?? {}).filter(r => show.hasRole(r)) : [],
        lastLook: this.lastLook ? { ok: this.lastLook.ok, notes: this.lastLook.notes } : null,
        recent: (snap.recent ?? []).slice(-5).map(r => r.intent ?? r.category ?? ''),
      });
      const res = await rogger.brainChat({
        model: this.model, system: decisionSystemPrompt(), user,
      });
      const parsed = parseDecision(res.json);
      if (parsed) {
        this.plan = { ...parsed, at: performance.now() };
        this.lastDecideMs = performance.now() - t0;
      } else {
        this.log(`brain: unusable reply dropped (${JSON.stringify(res.json).slice(0, 80)})`);
      }
    } catch (e) {
      this.status = 'error:' + String(e?.message ?? e).slice(0, 60);
    } finally {
      this.inflight = false;
    }
  }

  // Freshness window: the plan may drive exactly one decision cycle and
  // expires after roughly its own cadence so stale moods can't fire late.
  takeFreshPlan() {
    if (!this.enabled() || !this.plan) return null;
    const bpm = this.music().bpm || 128;
    const maxAge = (this.cfg().decideEveryBars ?? 8) * 4 * (60000 / bpm) + 4000;
    const plan = this.plan;
    this.plan = null;
    return (performance.now() - plan.at) <= maxAge ? plan : null;
  }

  // Color mood / morph riders that accompany an executed brain decision.
  applyExtras({ color, morph, morphSpeed }) {
    const cfgAll = state.get();
    const applied = [];
    if (color) {
      const bg = cfgAll.colorTargets?.items?.find(t => t.id === 'bg');
      for (const s of bg?.onSteps ?? []) rogger.send(s.address, s.values ?? []);
      for (const base of bg?.colorBases ?? []) {
        rogger.sendTyped(`${base}/red`, [{ type: 'f', value: color.r }]);
        rogger.sendTyped(`${base}/green`, [{ type: 'f', value: color.g }]);
        rogger.sendTyped(`${base}/blue`, [{ type: 'f', value: color.b }]);
      }
      applied.push('color');
    }
    if (morph !== null && cfgAll.colorMorph?.bypassAddress) {
      rogger.sendTyped(cfgAll.colorMorph.bypassAddress, [{ type: 'i', value: morph ? 0 : 1 }]);
      applied.push(morph ? 'morph on' : 'morph off');
    }
    if (morphSpeed !== null && cfgAll.colorMorph?.speedAddress) {
      rogger.sendTyped(cfgAll.colorMorph.speedAddress, [{ type: 'f', value: morphSpeed }]);
      applied.push('speed');
    }
    return applied;
  }

  async look() {
    if (!this.enabled() || !this.visionModel || (this.cfg().lookEveryMs ?? 45000) <= 0) return;
    try {
      const shot = await rogger.brainScreenshot();
      const res = await rogger.brainChat({
        model: this.visionModel, system: lookSystemPrompt(),
        user: 'Review this output frame.', images: [shot],
        timeoutMs: Math.max(15000, this.cfg().timeoutMs ?? 8000),
      });
      const look = parseLook(res.json);
      if (look) {
        this.lastLook = { ...look, at: Date.now() };
        this.log(`brain look: ${look.ok ? 'ok' : 'OFF'} ${(look.score * 100) | 0}%` +
          (look.notes ? ` — ${look.notes}` : ''));
      }
    } catch { /* look checks are best-effort — never disturb the show */ }
  }
}
