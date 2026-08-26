// Pure gamepad → FX-handle binding resolver. Modifier combos let a single
// pad button (e.g. RT) held while pressing another (e.g. A) fire a
// different binding than the plain press. No DOM, no imports — safe to
// `require()` from node:test and to `import` from the renderer alike.

// Order handles are laid out in for the gamepad (see fxHandles in
// fx-grid.js): all FX pages in turn, then the utility quad.
// tempoButtons last: the two big Page 2 tempo buttons (fixed addresses, only
// their pad binding is editable) — appended so the other kinds' handle
// offsets never moved.
export const HANDLE_KINDS = ['fxButtons', 'fxButtons2', 'fxButtons3', 'utilButtons', 'tempoButtons'];

// Set of pad button indices used as a `gamepadModifier` anywhere in cfg.
export function modifierSet(cfg) {
  const set = new Set();
  for (const kind of HANDLE_KINDS) {
    for (const c of cfg[kind] ?? []) {
      if (c && c.gamepadModifier >= 0) set.add(c.gamepadModifier);
    }
  }
  return set;
}

// Resolve which control fires for a press of `buttonIndex`, given the set
// of pad buttons currently held (heldSet). Candidates are every entry
// across HANDLE_KINDS whose gamepadButton === buttonIndex. A combo
// candidate (gamepadModifier >= 0) whose modifier is currently held wins,
// first in HANDLE_KINDS/index order if several qualify; otherwise the
// plain candidate (gamepadModifier === -1) wins; otherwise null.
export function resolveBinding(cfg, buttonIndex, heldSet) {
  let base = 0;
  let combo = null;
  let plain = null;
  for (const kind of HANDLE_KINDS) {
    const arr = cfg[kind] ?? [];
    for (let i = 0; i < arr.length; i++) {
      const c = arr[i];
      if (!c || c.gamepadButton !== buttonIndex) continue;
      const modifier = c.gamepadModifier ?? -1;
      const entry = { kind, index: i, handle: base + i };
      if (modifier >= 0) {
        if (!combo && heldSet.has(modifier)) combo = entry;
      } else if (!plain) {
        plain = entry;
      }
    }
    base += arr.length;
  }
  return combo ?? plain ?? null;
}

// Like resolveBinding, but only a combo counts: the entry whose modifier is
// currently held, or null. The analog triggers use this — LT/RT never act as
// plain buttons (their pull is the stomp), yet with a pad button held they
// can be a combo's target, e.g. LB+RT.
export function comboBinding(cfg, buttonIndex, heldSet) {
  const entry = resolveBinding(cfg, buttonIndex, heldSet);
  if (!entry) return null;
  const c = cfg[entry.kind]?.[entry.index];
  return (c?.gamepadModifier ?? -1) >= 0 ? entry : null;
}

// 'A', 'RT+A' or '' (button unbound).
export function bindingLabel(names, button, modifier) {
  if (button == null || button < 0) return '';
  const b = names[button] ?? '';
  if (!b) return '';
  if (modifier != null && modifier >= 0) {
    const m = names[modifier];
    if (m) return `${m}+${b}`;
  }
  return b;
}

// Clear the exact (button, modifier) pair from every entry other than
// (kind, index), so binding a new bit to a physical button+modifier pair
// steals cleanly across pages without touching other pairs on the same
// physical button (e.g. adding RT+A leaves a plain A binding intact).
// Mutates cfg in place; returns the number of entries cleared.
export function stealBinding(cfg, kind, index, button, modifier) {
  const mod = modifier ?? -1;
  let count = 0;
  for (const k of HANDLE_KINDS) {
    const arr = cfg[k] ?? [];
    for (let i = 0; i < arr.length; i++) {
      if (k === kind && i === index) continue;
      const c = arr[i];
      if (!c) continue;
      if (c.gamepadButton === button && (c.gamepadModifier ?? -1) === mod) {
        c.gamepadButton = -1;
        c.gamepadModifier = -1;
        count++;
      }
    }
  }
  return count;
}
