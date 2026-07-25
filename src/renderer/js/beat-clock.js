// Shared tap-derived beat clock: feeds the topbar readout and beat-synced
// button repeats. Purely local — taps come from the TAP button, no OSC here.
let taps = [];
let mult = 1;
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

// Current beat length in ms (taps averaged, x mult), or null before 2 taps.
export function beatMs() {
  if (taps.length < 2) return null;
  return ((taps[taps.length - 1] - taps[0]) / (taps.length - 1)) * mult;
}

export function onChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}
