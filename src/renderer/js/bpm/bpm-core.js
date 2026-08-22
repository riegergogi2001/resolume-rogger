// Pure DSP core for the mic/line-in BPM analyser — no DOM, no Web Audio, so
// it can run (and be unit-tested) directly under Node.
//
// Pipeline per hop of incoming audio:
//   1. Slide a rolling `frameSize`-sample window forward by `hop` samples.
//   2. Hann-window it and run a radix-2 FFT -> magnitude spectrum.
//   3. Log-compress the magnitude, take the positive-only (half-wave
//      rectified) frame-to-frame difference summed over the ~30 Hz-5 kHz
//      band -> "spectral flux" (the classic broadband-onset feature).
//   4. Subtract a ~0.5 s local mean and rectify again -> the onset value for
//      this hop, pushed into an `windowSec`-long ring buffer.
// `estimate()` autocorrelates that onset envelope over the lag range implied
// by [minBpm, maxBpm], weights it with a log-Gaussian prior centred on
// `priorBpm`, picks the best peak (with an octave-error guard + parabolic
// interpolation), and reports a median-smoothed bpm with a confidence score.
// `predictBeats()`/`nextBeatIn()`/`tick()` locate the beat phase inside the
// same envelope so callers can flash a dot or resync on the next beat.

// ---- radix-2 iterative Cooley-Tukey FFT (in place, re/im same length, a
// power of two). Negative-exponent (forward) transform. ----
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curWr = 1, curWi = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const vr = re[b] * curWr - im[b] * curWi;
        const vi = re[b] * curWi + im[b] * curWr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] = re[a] + vr; im[a] = im[a] + vi;
        const nWr = curWr * wr - curWi * wi;
        const nWi = curWr * wi + curWi * wr;
        curWr = nWr; curWi = nWi;
      }
    }
  }
}

export function hann(n) {
  const w = new Float32Array(n);
  if (n === 1) { w[0] = 1; return w; }
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Fixed-capacity circular buffer with chronological access (`at(0)` oldest).
class Ring {
  constructor(cap) {
    this.cap = Math.max(1, cap);
    this.buf = new Float32Array(this.cap);
    this.write = 0;
    this.count = 0;
  }
  push(v) {
    this.buf[this.write] = v;
    this.write = (this.write + 1) % this.cap;
    if (this.count < this.cap) this.count++;
  }
  at(i) {
    if (i < 0) i = 0;
    if (i > this.count - 1) i = this.count - 1;
    const start = (this.write - this.count + this.cap) % this.cap;
    return this.buf[(start + i) % this.cap];
  }
  sum() {
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.buf[i]; // order doesn't matter for a sum
    return s;
  }
  mean() {
    return this.count ? this.sum() / this.count : 0;
  }
}

const LEVEL_FLOOR = 0.01;   // RMS below this over the window = "silent"
const MIN_SECONDS = 3;      // minimum onset history before estimating
const PRIOR_SIGMA_OCT = 0.5; // log-Gaussian prior width, in octaves
const OCTAVE_GUARD_RATIO = 1.3;

export class TempoTracker {
  constructor({
    sampleRate = 44100,
    frameSize = 1024,
    hop = 512,
    minBpm = 60,
    maxBpm = 200,
    priorBpm = 125,
    windowSec = 8,
  } = {}) {
    this.sampleRate = sampleRate;
    this.frameSize = frameSize;
    this.hop = hop;
    this.minBpm = minBpm;
    this.maxBpm = maxBpm;
    this.priorBpm = priorBpm;
    this.windowSec = windowSec;

    // rolling time-domain window (most recent `frameSize` samples)
    this.window = new Float32Array(frameSize);
    this.filled = 0;
    this.accBuf = new Float32Array(hop);
    this.accLen = 0;
    this.totalHops = 0;

    this.hannW = hann(frameSize);
    this.re = new Float64Array(frameSize);
    this.im = new Float64Array(frameSize);
    const half = frameSize >> 1;
    this.logMag = new Float64Array(half + 1);
    this.prevLogMag = new Float64Array(half + 1);
    this.havePrev = false;

    const binHz = sampleRate / frameSize;
    this.kMin = Math.max(1, Math.round(30 / binHz));
    this.kMax = Math.min(half - 1, Math.round(5000 / binHz));

    const localMeanLen = Math.max(1, Math.round(0.5 * (sampleRate / hop)));
    this.fluxRing = new Ring(localMeanLen);

    const ringLen = Math.max(1, Math.ceil(windowSec * (sampleRate / hop)));
    this.onsetRing = new Ring(ringLen);
    this.levelRing = new Ring(ringLen);

    this.minHopsFor3s = Math.ceil((MIN_SECONDS * sampleRate) / hop);

    this.rawBpmHistory = [];
    this.bpm = null;

    this.locked = false;
    this._lockedBpm = null;
    this.scaleFactor = 1;

    this._periodHops = null;
    this._phaseHopsAgo = null;
    this._prevPhaseHopsAgo = null;
  }

  // Accepts any-length Float32Array; internally drains it in `hop`-sized
  // pieces. Returns an array of { onset, level } — one per hop completed
  // during this call (usually exactly one when fed hop-sized chunks).
  pushFrame(samples) {
    const results = [];
    let offset = 0;
    const n = samples.length;
    while (offset < n) {
      const need = this.hop - this.accLen;
      const take = Math.min(need, n - offset);
      this.accBuf.set(samples.subarray(offset, offset + take), this.accLen);
      this.accLen += take;
      offset += take;
      if (this.accLen >= this.hop) {
        results.push(this._consumeHop());
        this.accLen = 0;
      }
    }
    return results;
  }

  _consumeHop() {
    const hopBuf = this.accBuf;
    let sumSq = 0;
    for (let i = 0; i < this.hop; i++) sumSq += hopBuf[i] * hopBuf[i];
    const level = Math.min(1, Math.sqrt(sumSq / this.hop));

    this.window.copyWithin(0, this.hop);
    this.window.set(hopBuf, this.frameSize - this.hop);
    this.filled = Math.min(this.filled + this.hop, this.frameSize);
    this.totalHops++;

    const onset = this.filled >= this.frameSize ? this._computeOnset() : 0;
    this.onsetRing.push(onset);
    this.levelRing.push(level);
    return { onset, level };
  }

  _computeOnset() {
    for (let i = 0; i < this.frameSize; i++) {
      this.re[i] = this.window[i] * this.hannW[i];
      this.im[i] = 0;
    }
    fft(this.re, this.im);
    const half = this.frameSize >> 1;
    for (let k = 0; k <= half; k++) {
      const mag = Math.sqrt(this.re[k] * this.re[k] + this.im[k] * this.im[k]);
      this.logMag[k] = Math.log(1 + mag);
    }
    let flux = 0;
    if (this.havePrev) {
      for (let k = this.kMin; k <= this.kMax; k++) {
        const d = this.logMag[k] - this.prevLogMag[k];
        if (d > 0) flux += d;
      }
    }
    const tmp = this.prevLogMag; this.prevLogMag = this.logMag; this.logMag = tmp;
    this.havePrev = true;

    const localMean = this.fluxRing.count ? this.fluxRing.mean() : 0;
    this.fluxRing.push(flux);
    return Math.max(0, flux - localMean);
  }

  _prior(bpm) {
    const oct = Math.log2(bpm / this.priorBpm);
    return Math.exp(-0.5 * (oct / PRIOR_SIGMA_OCT) * (oct / PRIOR_SIGMA_OCT));
  }

  _autocorr(lag) {
    const n = this.onsetRing.count;
    let sum = 0, cnt = 0;
    for (let i = lag; i < n; i++) {
      sum += this.onsetRing.at(i) * this.onsetRing.at(i - lag);
      cnt++;
    }
    return cnt > 0 ? sum / cnt : 0;
  }

  _octaveGuard(peakLag, lagMin, lagMax, scores, hopRate) {
    const scoreAt = l => (l >= lagMin && l <= lagMax ? scores[l - lagMin] : -Infinity);
    const bpmAt = l => (hopRate * 60) / l;
    const candLags = [peakLag, peakLag * 2, Math.round(peakLag / 2)]
      .filter(l => l >= lagMin && l <= lagMax);
    const scored = candLags.map(l => ({ l, bpm: bpmAt(l), score: scoreAt(l) }));
    const inRange = scored.filter(c => c.bpm >= 80 && c.bpm <= 160);
    if (!inRange.length) return peakLag;
    let best = inRange[0];
    for (const c of inRange) if (c.score > best.score) best = c;
    let strongest = scored[0];
    for (const c of scored) if (c.score > strongest.score) strongest = c;
    if (strongest !== best && strongest.score > OCTAVE_GUARD_RATIO * best.score) return strongest.l;
    return best.l;
  }

  _parabolic(sm1, s0, sp1) {
    const denom = sm1 - 2 * s0 + sp1;
    if (Math.abs(denom) < 1e-12) return 0;
    const off = 0.5 * (sm1 - sp1) / denom;
    return Math.max(-0.5, Math.min(0.5, off));
  }

  // Runs the autocorrelation pick, updates the raw-history/median state, and
  // returns the *unscaled* live numbers. `estimate()` layers lock/scale on
  // top of this so a lock can freeze the reported bpm while this keeps
  // tracking underneath (for a clean resume on unlock).
  _liveEstimate() {
    if (this.onsetRing.count < this.minHopsFor3s) return { rawBpm: null, confidence: 0 };
    if (this.levelRing.mean() < LEVEL_FLOOR) return { rawBpm: null, confidence: 0 };

    const hopRate = this.sampleRate / this.hop;
    const lagMin = Math.max(1, Math.round((hopRate * 60) / this.maxBpm));
    const lagMax = Math.min(this.onsetRing.count - 1, Math.round((hopRate * 60) / this.minBpm));
    if (lagMax <= lagMin + 1) return { rawBpm: null, confidence: 0 };

    const len = lagMax - lagMin + 1;
    const scores = new Float64Array(len);
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const ac = this._autocorr(lag);
      const bpm = (hopRate * 60) / lag;
      scores[lag - lagMin] = ac * this._prior(bpm);
    }

    let peakIdx = 0, peakVal = -Infinity;
    for (let i = 0; i < len; i++) if (scores[i] > peakVal) { peakVal = scores[i]; peakIdx = i; }
    let peakLag = peakIdx + lagMin;
    peakLag = this._octaveGuard(peakLag, lagMin, lagMax, scores, hopRate);

    const li = peakLag - lagMin;
    let refinedLag = peakLag;
    if (li > 0 && li < len - 1) {
      refinedLag = peakLag + this._parabolic(scores[li - 1], scores[li], scores[li + 1]);
    }
    const rawBpmVal = (hopRate * 60) / refinedLag;

    this.rawBpmHistory.push(rawBpmVal);
    if (this.rawBpmHistory.length > 5) this.rawBpmHistory.shift();
    const med = median(this.rawBpmHistory);
    this.bpm = med;

    let mean = 0;
    for (let i = 0; i < len; i++) mean += scores[i];
    mean /= len;
    let min = Infinity;
    for (let i = 0; i < len; i++) if (scores[i] < min) min = scores[i];
    const chosenScore = scores[li] ?? peakVal;
    const prom = chosenScore - min > 1e-9 ? (chosenScore - mean) / (chosenScore - min) : 0;
    const agreement = this.rawBpmHistory.filter(v => Math.abs(v - med) <= 2).length / this.rawBpmHistory.length;
    const confidence = Math.max(0, Math.min(1, prom)) * agreement;

    return { rawBpm: rawBpmVal, confidence };
  }

  estimate() {
    const live = this._liveEstimate();
    if (this.locked) {
      const base = this._lockedBpm;
      return {
        bpm: base != null ? base * this.scaleFactor : null,
        rawBpm: live.rawBpm != null ? live.rawBpm * this.scaleFactor : null,
        confidence: live.confidence,
      };
    }
    if (live.rawBpm == null) return { bpm: null, rawBpm: null, confidence: 0 };
    return {
      bpm: this.bpm * this.scaleFactor,
      rawBpm: live.rawBpm * this.scaleFactor,
      confidence: live.confidence,
    };
  }

  // Freezes the reported bpm at its current value (scale resets to 1 on
  // every lock state change — "until unlocked/relocked").
  lock(bool) {
    this.locked = !!bool;
    this.scaleFactor = 1;
    this._lockedBpm = this.locked ? this.bpm : null;
  }

  scale(factor) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    this.scaleFactor = Math.min(4, Math.max(0.25, this.scaleFactor * factor));
  }

  getLevel() {
    return this.levelRing.count ? this.levelRing.at(this.levelRing.count - 1) : 0;
  }

  getOnsetEnvelope() {
    const out = new Array(this.onsetRing.count);
    for (let i = 0; i < this.onsetRing.count; i++) out[i] = this.onsetRing.at(i);
    return out;
  }

  msPerHop() {
    return (1000 * this.hop) / this.sampleRate;
  }

  _envAtInterp(idx) {
    if (idx < 0) return 0;
    const count = this.onsetRing.count;
    if (!count) return 0;
    const i0 = Math.floor(idx);
    if (i0 > count - 1) return 0;
    const i1 = Math.min(count - 1, i0 + 1);
    const frac = idx - i0;
    const v0 = this.onsetRing.at(i0), v1 = this.onsetRing.at(i1);
    return v0 + (v1 - v0) * frac;
  }

  // Phase that maximises the sum of the onset envelope sampled at period
  // multiples over the last ~4 s. Returns { periodMs, phaseMs } where
  // phaseMs = time since the most recent predicted beat (0..periodMs), or
  // null when there's no usable tempo yet.
  predictBeats() {
    const bpm = this.locked ? this._lockedBpm : this.bpm;
    if (!bpm || !Number.isFinite(bpm)) { this._periodHops = null; this._phaseHopsAgo = null; return null; }
    const hopRate = this.sampleRate / this.hop;
    const periodHops = (hopRate * 60) / bpm;
    if (!(periodHops > 0) || !Number.isFinite(periodHops)) { this._periodHops = null; return null; }
    const count = this.onsetRing.count;
    if (count < 2) return null;

    const maxLookback = Math.min(count - 1, Math.round(4 * hopRate));
    const K = Math.max(1, Math.floor(maxLookback / periodHops));
    const steps = 32;
    let bestD = 0, bestScore = -Infinity;
    for (let s = 0; s < steps; s++) {
      const d = (s / steps) * periodHops;
      let score = 0;
      for (let k = 0; k <= K; k++) {
        score += this._envAtInterp(count - 1 - (d + k * periodHops));
      }
      if (score > bestScore) { bestScore = score; bestD = d; }
    }
    this._periodHops = periodHops;
    this._phaseHopsAgo = bestD;
    const msPerHop = this.msPerHop();
    return { periodMs: periodHops * msPerHop, phaseMs: bestD * msPerHop };
  }

  // Milliseconds until the next predicted beat crossing (0..periodMs).
  nextBeatIn() {
    const info = this.predictBeats();
    if (!info) return null;
    return Math.max(0, info.periodMs - info.phaseMs);
  }

  // Call once per completed hop: returns true the hop a predicted beat is
  // crossed (self-corrects to the live phase search each call).
  tick() {
    const info = this.predictBeats();
    if (!info) { this._prevPhaseHopsAgo = null; return false; }
    const d = this._phaseHopsAgo;
    const crossed = this._prevPhaseHopsAgo != null && d < this._prevPhaseHopsAgo - 1e-9;
    this._prevPhaseHopsAgo = d;
    return crossed;
  }
}
