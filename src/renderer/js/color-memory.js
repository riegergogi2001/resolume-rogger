// What colour is on each target right now.
//
// Resolume does not echo colours. Verified twice against Arena 7.26 with its
// OSC output on: driving a ParamColor's red/green/blue produces no feedback at
// all, while bypassed, opacity, transport positions and even ordinary float
// effect parameters all come straight back. So the surface cannot learn the
// current colour from the desk, and the preset-matching that waited for
// `<base>/red|green|blue` to arrive could never fire.
//
// It remembers what it last sent instead, per target, and lights the matching
// preset from that. Honest about what it is: this shows what *you* last set on
// that target, not what Resolume holds. Switching targets brings back that
// target's own last colour rather than leaving a stale highlight from another.
//
// Anything that does echo colour can write here too — the OSC listener in
// color-row.js feeds the same store — so a device that reports properly lights
// the presets for the right reason without any other change.

const lastByTarget = new Map();
const listeners = new Set();

/** @param {string} targetId  @param {number[]} rgb 0..1 triplet */
export function setColor(targetId, rgb) {
  if (!targetId || !Array.isArray(rgb) || rgb.length < 3) return;
  const next = rgb.slice(0, 3).map(Number);
  if (next.some(v => !Number.isFinite(v))) return;
  const prev = lastByTarget.get(targetId);
  if (prev && prev.every((v, i) => v === next[i])) return;
  lastByTarget.set(targetId, next);
  for (const fn of listeners) fn(targetId, next);
}

/** The colour last sent to a target, or null if nothing has been sent yet. */
export function getColor(targetId) {
  return lastByTarget.get(targetId) ?? null;
}

/** Forget a target's colour — used when its OFF step fires. */
export function clearColor(targetId) {
  if (!lastByTarget.delete(targetId)) return;
  for (const fn of listeners) fn(targetId, null);
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam. */
export function reset() {
  lastByTarget.clear();
}
