// Rolling memory of the visual performance for the autonomous AI Visual
// Director: tracks recent actions per category and derives "heat" (how hot
// a category is right now), fatigue (overall action rate) and tension (an
// externally-set mood knob) so the director can price the cost of doing
// something again. No DOM, no timers — clock is injected for testability.

export const HALF_LIFE_MS = {
  strobe: 45000,
  flash: 20000,
  impact: 30000,
  camerafx: 25000,
  deckswitch: 240000,
  transition: 60000,
  clip: 90000,
  energy: 30000,
  density: 30000,
};

// Bound memory for a 12-hour show: entries older than this never contribute
// to heat/fatigue, so they're pruned on every write instead of kept forever.
const RETENTION_MS = 10 * 60 * 1000;
const TENSION_HALF_LIFE_MS = 60000;
const FATIGUE_WINDOW_MS = 5 * 60 * 1000;
const FATIGUE_SATURATION_COUNT = 12; // non-clip actions inside the window that saturates fatigue to 1
const HEAT_CAP = 2;

export class VisualState {
  constructor(now = () => 0) {
    this._now = now;
    this._entries = []; // {category, at, meta}
    this._tension = 0;
    this._tensionSetAt = 0;
  }

  noteAction(category, meta = {}) {
    const at = this._now();
    this._entries.push({ category, at, meta });
    this._prune(at);
  }

  _prune(at) {
    const cutoff = at - RETENTION_MS;
    while (this._entries.length && this._entries[0].at < cutoff) {
      this._entries.shift();
    }
  }

  heat(category) {
    const halfLife = HALF_LIFE_MS[category];
    if (!halfLife) return 0;
    const at = this._now();
    let sum = 0;
    for (const e of this._entries) {
      if (e.category !== category) continue;
      const age = at - e.at;
      if (age < 0) continue;
      sum += Math.pow(0.5, age / halfLife);
    }
    return Math.min(HEAT_CAP, sum);
  }

  cost(category) {
    return Math.min(1, this.heat(category) * 0.6 + this.fatigue() * 0.4);
  }

  clipUseCount(id) {
    let count = 0;
    for (const e of this._entries) {
      if (e.category === 'clip' && e.meta && e.meta.id === id) count++;
    }
    return count;
  }

  deckDwellMs() {
    const at = this._now();
    for (let i = this._entries.length - 1; i >= 0; i--) {
      if (this._entries[i].category === 'deckswitch') return at - this._entries[i].at;
    }
    return Infinity;
  }

  setTension(v) {
    this._tension = Math.min(1, Math.max(0, v));
    this._tensionSetAt = this._now();
  }

  get tension() {
    const age = this._now() - this._tensionSetAt;
    if (age < 0) return this._tension;
    return this._tension * Math.pow(0.5, age / TENSION_HALF_LIFE_MS);
  }

  fatigue() {
    const at = this._now();
    const cutoff = at - FATIGUE_WINDOW_MS;
    let count = 0;
    for (const e of this._entries) {
      if (e.category === 'clip') continue;
      if (e.at >= cutoff && e.at <= at) count++;
    }
    return Math.min(1, count / FATIGUE_SATURATION_COUNT);
  }

  snapshot() {
    const heats = {};
    for (const category of Object.keys(HALF_LIFE_MS)) heats[category] = this.heat(category);
    const recent = this._entries.slice(-20).map(e => ({ category: e.category, at: e.at, meta: e.meta }));
    return {
      heats,
      fatigue: this.fatigue(),
      tension: this.tension,
      deckDwellMs: this.deckDwellMs(),
      recent,
    };
  }
}
