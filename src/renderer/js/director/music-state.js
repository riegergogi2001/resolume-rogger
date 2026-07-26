// MusicState: assembles the sidecar's /rogger/agent/* telemetry into the
// picture the policy consumes — beat/phrase position, section, metrics,
// drop predictions — plus link-health for the Director's safe mode.
export class MusicState {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.bpm = 0;
    this.confidence = 0;
    this.beatInBar = 1;
    this.bar = 0;
    this.phrasePos = 0;
    this.phraseLen = 16;
    this.section = 'idle';
    this.sectionSince = now();
    this.metrics = { energy: 0, tension: 0, bass: 0, density: 0, vocal: 0 };
    this.prediction = null;         // {event, beatsUntil, confidence, at}
    this.engine = null;
    this.lastPing = -Infinity;
    this.lastBeat = -Infinity;
    this.events = [];               // one-shot queue consumed by the director
  }

  ingest(kind, args) {
    const t = this.now();
    if (kind === 'ping') {
      this.lastPing = t;
    } else if (kind === 'engine') {
      this.engine = String(args[0] ?? '');
    } else if (kind === 'bpm') {
      this.bpm = Number(args[0]) || 0;
      this.confidence = Number(args[1]) || 0;
    } else if (kind === 'beat') {
      this.beatInBar = Number(args[0]) || 1;
      this.lastBeat = t;
    } else if (kind === 'downbeat') {
      this.bar = Number(args[0]) || 0;
    } else if (kind === 'phrase') {
      this.bar = Number(args[0]) || 0;
      this.phrasePos = Number(args[1]) || 0;
      this.phraseLen = Number(args[2]) || 16;
    } else if (kind === 'metrics') {
      const [energy, tension, bass, density, vocal] = args.map(Number);
      this.metrics = { energy, tension, bass, density, vocal };
    } else if (kind === 'state') {
      this.section = String(args[0]);
      this.sectionSince = t;
    } else if (kind === 'event') {
      this.events.push(String(args[0]));
    } else if (kind === 'predict') {
      this.prediction = {
        event: String(args[0]),
        beatsUntil: Number(args[1]) || 0,
        confidence: Number(args[2]) || 0,
        at: t,
      };
    }
  }

  takeEvent() {
    return this.events.shift() ?? null;
  }

  // Prediction is only valid until its horizon (+2 s slack) has passed.
  currentPrediction() {
    const p = this.prediction;
    if (!p || !this.bpm) return null;
    const horizon = p.beatsUntil * (60000 / this.bpm) + 2000;
    return this.now() - p.at <= horizon ? p : null;
  }

  // Snapshot in the exact shape policy.decide() expects.
  forPolicy(lastEvent = null) {
    return {
      bpm: this.bpm,
      confidence: this.confidence,
      beatInBar: this.beatInBar,
      bar: this.bar,
      phrasePos: this.phrasePos,
      phraseLen: this.phraseLen,
      section: this.section,
      msInSection: this.now() - this.sectionSince,
      lastEvent,
      metrics: this.metrics,
      prediction: this.currentPrediction(),
    };
  }

  health() {
    const t = this.now();
    const issues = [];
    if (t - this.lastPing > 3500) issues.push('audio-link-lost');
    else {
      if (t - this.lastBeat > 8000 || this.bpm <= 0) issues.push('bpm-lost');
      if (this.confidence < 0.2) issues.push('low-tracker-confidence');
    }
    return { ok: issues.length === 0, issues };
  }
}
