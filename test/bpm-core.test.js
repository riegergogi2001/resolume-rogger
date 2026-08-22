'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TempoTracker, fft, hann } = require('../src/renderer/js/bpm/bpm-core.js');

// ---- deterministic synthetic audio: kick-like bursts on the beat, quieter
// hats on the off-beat, at a given (possibly time-varying) bpm. ----
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function addKick(buf, sr, startSec, rng) {
  const durSec = 0.08;
  const start = Math.round(startSec * sr);
  const len = Math.round(durSec * sr);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const tt = i / sr;
    const env = Math.exp(-tt / 0.03);
    const tone = Math.sin(2 * Math.PI * 60 * tt);
    const noiseEnv = Math.exp(-tt / 0.01);
    const noise = (rng() * 2 - 1) * noiseEnv;
    buf[start + i] += env * tone * 0.8 + noise * 0.6;
  }
}

function addHat(buf, sr, startSec, rng) {
  const durSec = 0.03;
  const start = Math.round(startSec * sr);
  const len = Math.round(durSec * sr);
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const tt = i / sr;
    const env = Math.exp(-tt / 0.008);
    const noise = (rng() * 2 - 1);
    buf[start + i] += noise * env * 0.22; // quieter than the kick
  }
}

// bpmAt(tSec) lets the caller vary tempo over time (constant-bpm tests pass
// a fixed-value function).
function synthBeats({ sampleRate = 44100, durationSec = 20, bpmAt, seed = 1 }) {
  const buf = new Float32Array(Math.floor(sampleRate * durationSec));
  const rng = makeRng(seed);
  let t = 0;
  let beatIndex = 0;
  while (t < durationSec) {
    addKick(buf, sampleRate, t, rng);
    const bpm = bpmAt(t);
    const period = 60 / bpm;
    const hatT = t + period / 2;
    if (hatT < durationSec) addHat(buf, sampleRate, hatT, rng);
    beatIndex++;
    t += period;
    void beatIndex;
  }
  return buf;
}

function feed(tracker, buf, hop = 512) {
  for (let i = 0; i < buf.length; i += hop) {
    tracker.pushFrame(buf.subarray(i, Math.min(buf.length, i + hop)));
  }
}

test('FFT of a pure 1 kHz sine peaks at the right bin', () => {
  const n = 2048;
  const sampleRate = 44100;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const w = hann(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 1000 * i) / sampleRate) * w[i];
  fft(re, im);
  const half = n / 2;
  let peakBin = 0, peakMag = -Infinity;
  for (let k = 0; k <= half; k++) {
    const mag = Math.hypot(re[k], im[k]);
    if (mag > peakMag) { peakMag = mag; peakBin = k; }
  }
  const expected = Math.round((1000 * n) / sampleRate);
  assert.ok(Math.abs(peakBin - expected) <= 1, `bin ${peakBin} expected ~${expected}`);
});

test('locks onto 128 BPM within +-1.5 with confidence > 0.5', () => {
  const tracker = new TempoTracker({ sampleRate: 44100 });
  const buf = synthBeats({ durationSec: 20, bpmAt: () => 128, seed: 128 });
  feed(tracker, buf);
  const { bpm, confidence } = tracker.estimate();
  assert.ok(bpm !== null, 'bpm should be detected');
  assert.ok(Math.abs(bpm - 128) <= 1.5, `bpm ${bpm} expected ~128`);
  assert.ok(confidence > 0.5, `confidence ${confidence} expected > 0.5`);
});

test('locks onto 96 BPM within +-1.5 (not the 48/192 octave error)', () => {
  const tracker = new TempoTracker({ sampleRate: 44100 });
  const buf = synthBeats({ durationSec: 20, bpmAt: () => 96, seed: 96 });
  feed(tracker, buf);
  const { bpm } = tracker.estimate();
  assert.ok(bpm !== null, 'bpm should be detected');
  assert.ok(Math.abs(bpm - 96) <= 1.5, `bpm ${bpm} expected ~96, not an octave error`);
});

test('locks onto 174 BPM within +-2', () => {
  const tracker = new TempoTracker({ sampleRate: 44100 });
  const buf = synthBeats({ durationSec: 20, bpmAt: () => 174, seed: 174 });
  feed(tracker, buf);
  const { bpm } = tracker.estimate();
  assert.ok(bpm !== null, 'bpm should be detected');
  assert.ok(Math.abs(bpm - 174) <= 2, `bpm ${bpm} expected ~174`);
});

test('silence reports null bpm and zero confidence', () => {
  const tracker = new TempoTracker({ sampleRate: 44100 });
  const buf = new Float32Array(44100 * 20); // all zero
  feed(tracker, buf);
  const { bpm, rawBpm, confidence } = tracker.estimate();
  assert.equal(bpm, null);
  assert.equal(rawBpm, null);
  assert.equal(confidence, 0);
});

test('tracks a tempo change 120 -> 140 at 12s, within +-2 of 140 at the end', () => {
  const tracker = new TempoTracker({ sampleRate: 44100 });
  const buf = synthBeats({ durationSec: 20, bpmAt: t => (t < 12 ? 120 : 140), seed: 42 });
  feed(tracker, buf);
  const { bpm } = tracker.estimate();
  assert.ok(bpm !== null, 'bpm should be detected');
  assert.ok(Math.abs(bpm - 140) <= 2, `bpm ${bpm} expected ~140 after the tempo change`);
});

test('nextBeatIn() is between 0 and the beat period', () => {
  const tracker = new TempoTracker({ sampleRate: 44100 });
  const buf = synthBeats({ durationSec: 20, bpmAt: () => 128, seed: 7 });
  feed(tracker, buf);
  const { bpm } = tracker.estimate();
  assert.ok(bpm !== null);
  const period = 60000 / bpm;
  const next = tracker.nextBeatIn();
  assert.ok(next !== null);
  assert.ok(next >= 0 && next <= period + 1e-6, `nextBeatIn ${next} expected within [0, ${period}]`);
});

test('lock() freezes bpm; scale() halves/doubles it until relocked', () => {
  const tracker = new TempoTracker({ sampleRate: 44100 });
  const buf = synthBeats({ durationSec: 20, bpmAt: () => 128, seed: 128 });
  feed(tracker, buf);
  const before = tracker.estimate();
  tracker.lock(true);
  const locked = tracker.estimate();
  assert.ok(Math.abs(locked.bpm - before.bpm) < 1e-6, 'lock freezes at the current bpm');
  tracker.scale(0.5);
  const halved = tracker.estimate();
  assert.ok(Math.abs(halved.bpm - locked.bpm / 2) < 1e-6, 'scale(0.5) halves the reported bpm');
  tracker.scale(2);
  const doubled = tracker.estimate();
  assert.ok(Math.abs(doubled.bpm - locked.bpm) < 1e-6, 'scale(2) undoes the halving');
  tracker.lock(false);
  tracker.lock(true);
  const relocked = tracker.estimate();
  assert.ok(Math.abs(relocked.bpm - locked.bpm) < 1e-6, 'relocking resets the scale factor to 1');
});
