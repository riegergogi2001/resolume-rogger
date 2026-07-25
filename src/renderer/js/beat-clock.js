// Shared tap-derived beat clock: feeds the topbar readout and beat-synced
// button repeats. Purely local — taps come from the TAP button, no OSC here.
let taps = [];
let mult = 1;
let mode = 'tap'; // 'tap' = manual taps, 'auto' = follow the target app's BPM
let autoBpm = null;
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

// Current beat length in ms (x mult): auto BPM when following the target app,
// otherwise tap-averaged; null before 2 taps.
export function beatMs() {
  if (mode === 'auto' && autoBpm) return (60000 / autoBpm) * mult;
  if (taps.length < 2) return null;
  return ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)) * mult;
}

export function onChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
