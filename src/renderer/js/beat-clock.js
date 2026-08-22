// Shared tap-derived beat clock: feeds the topbar readout and beat-synced
// button repeats. Purely local — taps come from the TAP button, no OSC here.
let taps = [];
let mult = 1;
let mode = 'tap'; // 'tap' = manual taps, 'auto' = follow the target app's BPM, 'mic' = BPM page analyser
let autoBpm = null;
let micBpm = null;
const subs = new Set();

function notify() {
  for (const fn of subs) fn();
}

export function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  if (taps.length > 8) taps.shift();
  mult = 1;
  notify();
}

export function scaleBeat(factor) {
  mult = Math.min(4, Math.max(0.25, mult * factor));
  notify();
}

export function setMode(m) {
  mode = m;
  mult = 1; // switching source starts from the plain beat
  notify();
}

export function getMode() {
  return mode;
}

export function setAutoBpm(bpm) {
  if (!bpm || !Number.isFinite(bpm)) return;
  const changed = autoBpm === null || Math.abs(bpm - autoBpm) > 0.05;
  autoBpm = bpm;
  if (changed) notify();
}

// Set by the BPM page's mic analyser on every update; null when it has no
// confident reading yet.
export function setMicBpm(bpm) {
  const next = bpm && Number.isFinite(bpm) ? bpm : null;
  const changed = next !== micBpm && !(next !== null && micBpm !== null && Math.abs(next - micBpm) <= 0.05);
  micBpm = next;
  if (changed) notify();
}

export function getMicBpm() {
  return micBpm;
}

// Current beat length in ms (x mult): mic-analyser BPM, auto BPM when
// following the target app, or tap-averaged; null before a source is ready.
export function beatMs() {
  if (mode === 'mic') return micBpm ? (60000 / micBpm) * mult : null;
  if (mode === 'auto' && autoBpm) return (60000 / autoBpm) * mult;
  if (taps.length < 2) return null;
  return ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)) * mult;
}

export function onChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
