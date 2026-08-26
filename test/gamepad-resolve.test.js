'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  HANDLE_KINDS, modifierSet, resolveBinding, comboBinding, bindingLabel, stealBinding,
} = require('../src/renderer/js/gamepad-resolve.js');

const NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'VIEW', 'MENU', 'LS', 'RS', 'D-UP', 'D-DN', 'D-LT', 'D-RT'];

function ctrl(over = {}) {
  return { gamepadButton: -1, gamepadModifier: -1, ...over };
}

function cfg(over = {}) {
  const base = { fxButtons: [], fxButtons2: [], fxButtons3: [], utilButtons: [] };
  return { ...base, ...over };
}

test('HANDLE_KINDS matches the fxHandles page order', () => {
  assert.deepEqual(HANDLE_KINDS, ['fxButtons', 'fxButtons2', 'fxButtons3', 'utilButtons']);
});

test('plain A resolves to the plain binding', () => {
  const c = cfg({ fxButtons: [ctrl({ gamepadButton: 0 })] });
  const res = resolveBinding(c, 0, new Set([0]));
  assert.deepEqual(res, { kind: 'fxButtons', index: 0, handle: 0 });
});

test('RT held + A resolves to the combo binding, not the plain one', () => {
  const c = cfg({
    fxButtons: [
      ctrl({ gamepadButton: 0 }),                       // plain A
      ctrl({ gamepadButton: 0, gamepadModifier: 7 }),    // RT+A
    ],
  });
  const plainOnly = resolveBinding(c, 0, new Set([0]));
  assert.deepEqual(plainOnly, { kind: 'fxButtons', index: 0, handle: 0 });

  const withRt = resolveBinding(c, 0, new Set([0, 7]));
  assert.deepEqual(withRt, { kind: 'fxButtons', index: 1, handle: 1 });
});

test('combo-only button with no modifier held resolves to null', () => {
  const c = cfg({ fxButtons: [ctrl({ gamepadButton: 0, gamepadModifier: 7 })] });
  const res = resolveBinding(c, 0, new Set([0])); // RT (7) not held
  assert.equal(res, null);
});

test('an unbound button resolves to null', () => {
  const c = cfg({ fxButtons: [ctrl()] });
  assert.equal(resolveBinding(c, 0, new Set([0])), null);
});

test('modifier button (RT) still resolves its own plain binding', () => {
  // RT (7) itself has a plain binding; RT is held (it's the button just
  // pressed), and nothing else is held, so the plain RT binding fires.
  const c = cfg({ fxButtons: [ctrl({ gamepadButton: 7 })] });
  const res = resolveBinding(c, 7, new Set([7]));
  assert.deepEqual(res, { kind: 'fxButtons', index: 0, handle: 0 });
});

test('two combos on the same button with different modifiers pick correctly', () => {
  const c = cfg({
    fxButtons: [
      ctrl({ gamepadButton: 0, gamepadModifier: 7 }), // RT+A
      ctrl({ gamepadButton: 0, gamepadModifier: 6 }), // LT+A
    ],
  });
  const withRt = resolveBinding(c, 0, new Set([0, 7]));
  assert.deepEqual(withRt, { kind: 'fxButtons', index: 0, handle: 0 });

  const withLt = resolveBinding(c, 0, new Set([0, 6]));
  assert.deepEqual(withLt, { kind: 'fxButtons', index: 1, handle: 1 });
});

test('handle index offsets across kinds match fxHandles layout', () => {
  const c = cfg({
    fxButtons: [ctrl(), ctrl(), ctrl({ gamepadButton: 3 })], // handle 2
    fxButtons2: [ctrl({ gamepadButton: 3 })],                 // handle 3 (offset 3)
    fxButtons3: [ctrl(), ctrl({ gamepadButton: 3 })],         // handle 5 (offset 4)
    utilButtons: [ctrl({ gamepadButton: 3 })],                // handle 6 (offset 6)
  });
  assert.equal(resolveBinding(c, 3, new Set([3])).handle, 2);
  // fxButtons has priority (first match in HANDLE_KINDS order) when
  // several plain candidates share the same button — so isolate each
  // kind to confirm its own offset arithmetic.
  const c2 = cfg({ fxButtons2: [ctrl({ gamepadButton: 3 })] });
  assert.equal(resolveBinding(c2, 3, new Set([3])).handle, 0);
  const c3 = cfg({
    fxButtons: [ctrl(), ctrl()],
    fxButtons2: [ctrl()],
    fxButtons3: [ctrl(), ctrl({ gamepadButton: 3 })],
  });
  assert.equal(resolveBinding(c3, 3, new Set([3])).handle, 4); // 2 + 1 + 1
  const c4 = cfg({
    fxButtons: [ctrl()],
    fxButtons2: [ctrl(), ctrl()],
    fxButtons3: [ctrl()],
    utilButtons: [ctrl({ gamepadButton: 3 })],
  });
  assert.equal(resolveBinding(c4, 3, new Set([3])).handle, 4); // 1 + 2 + 1
});

// The analog triggers only ever fire as a combo's target (LB+RT), never as a
// plain button: comboBinding is resolveBinding minus the plain fallback.
test('comboBinding: LB held + RT resolves the LB+RT combo, RT alone resolves nothing', () => {
  const c = cfg({
    fxButtons: [ctrl({ gamepadButton: 7 })],                             // plain RT — dead by design
    fxButtons2: [ctrl(), ctrl({ gamepadButton: 7, gamepadModifier: 4 })], // LB+RT
  });
  assert.deepEqual(comboBinding(c, 7, new Set([4, 7])), { kind: 'fxButtons2', index: 1, handle: 2 });
  assert.equal(comboBinding(c, 7, new Set([7])), null, 'no modifier held: the plain RT binding does not count');
  assert.equal(comboBinding(c, 7, new Set([5, 7])), null, 'a different modifier held: nothing');
  assert.equal(comboBinding(cfg(), 7, new Set([4, 7])), null, 'nothing bound: nothing');
});

test('modifierSet collects every gamepadModifier in use', () => {
  const c = cfg({
    fxButtons: [ctrl({ gamepadButton: 0, gamepadModifier: 7 }), ctrl({ gamepadButton: 1 })],
    fxButtons2: [ctrl({ gamepadButton: 2, gamepadModifier: 6 })],
  });
  assert.deepEqual(modifierSet(c), new Set([7, 6]));
});

test('stealBinding only clears the exact (button, modifier) pair', () => {
  const c = cfg({
    fxButtons: [
      ctrl({ gamepadButton: 0 }),                     // plain A — must survive
      ctrl({ gamepadButton: 0, gamepadModifier: 7 }),  // RT+A — the new binding
    ],
  });
  const cleared = stealBinding(c, 'fxButtons', 1, 0, 7);
  assert.equal(cleared, 0);
  assert.equal(c.fxButtons[0].gamepadButton, 0, 'plain A binding survives adding RT+A');
  assert.equal(c.fxButtons[1].gamepadButton, 0);
  assert.equal(c.fxButtons[1].gamepadModifier, 7);
});

test('stealBinding clears a duplicate of the same pair on another entry', () => {
  const c = cfg({
    fxButtons: [
      ctrl({ gamepadButton: 0, gamepadModifier: 7 }), // stale RT+A elsewhere
      ctrl({ gamepadButton: 0, gamepadModifier: 7 }), // the entry being saved
    ],
  });
  const cleared = stealBinding(c, 'fxButtons', 1, 0, 7);
  assert.equal(cleared, 1);
  assert.equal(c.fxButtons[0].gamepadButton, -1);
  assert.equal(c.fxButtons[0].gamepadModifier, -1);
});

test('stealBinding treats missing gamepadModifier as -1', () => {
  const c = cfg({
    fxButtons: [
      { gamepadButton: 5 }, // no gamepadModifier field at all (old saved config)
      ctrl({ gamepadButton: 5 }),
    ],
  });
  const cleared = stealBinding(c, 'fxButtons', 1, 5, -1);
  assert.equal(cleared, 1);
  assert.equal(c.fxButtons[0].gamepadButton, -1);
});

test('bindingLabel formatting', () => {
  assert.equal(bindingLabel(NAMES, -1, -1), '');
  assert.equal(bindingLabel(NAMES, 0, -1), 'A');
  assert.equal(bindingLabel(NAMES, 0, 7), 'RT+A');
  assert.equal(bindingLabel(NAMES, 0, null), 'A');
  assert.equal(bindingLabel(NAMES, undefined, undefined), '');
});

// The shipped pad layout: the 2026-08-22 plain layout (restored in 2.2.5)
// plus the 2.2.6 combos — RB+A/B/X/Y = the page-2 content pushers, LB+RT =
// ACUARELA with the trigger as the combo's target. Checked on both the
// defaults and the show config, so the two cannot drift apart.
const store = require('../src/main/config-store.js');
const path = require('node:path');
const LB = 4, RB = 5, RT = 7, LS = 10, RS = 11;

function labelOf(cfg, entry) { return entry ? cfg[entry.kind][entry.index].label : null; }

for (const [name, load] of [
  ['defaults', () => store.defaults()],
  ['configs/show.json', () => store.load(path.join(__dirname, '..', 'configs', 'show.json'))],
]) {
  test(`${name}: ships the plain layout — A/B/X/Y, LB SUCK IT!, RB PIXELATE, RS-click PUSH BLK — plus RB combos and LB+RT`, () => {
    const cfg = load();
    const plain = b => labelOf(cfg, resolveBinding(cfg, b, new Set()));
    assert.deepEqual([0, 1, 2, 3].map(plain), ['PUSH WHT', 'FLASH M', 'FLASH M2', 'INVERT'], 'A/B/X/Y');
    assert.equal(plain(LB), 'SUCK IT!', 'LB');
    assert.equal(plain(RB), 'PIXELATE', 'RB');
    assert.equal(plain(RS), 'PUSH BLK', 'RS-click');
    assert.equal(plain(LS), null, 'LS-click is free');
    assert.deepEqual([12, 13, 14, 15].map(plain), ['SLICE STR', 'BOOM BLUR', 'BOOM EXPO', 'BOOM EDGE'], 'D-pad');
    assert.deepEqual([0, 1, 2, 3].map(b => labelOf(cfg, resolveBinding(cfg, b, new Set([RB])))),
      ['GLITCH', 'BLOOM', 'EDGE FX', 'HUE SPIN'], 'RB+A/B/X/Y are the page-2 content pushers');
    assert.deepEqual([0, 1, 2, 3].map(b => labelOf(cfg, resolveBinding(cfg, b, new Set([LB])))),
      ['PUSH WHT', 'FLASH M', 'FLASH M2', 'INVERT'], 'LB+A/B/X/Y fall through to the plain bindings');
    assert.equal(labelOf(cfg, comboBinding(cfg, RT, new Set([LB]))), 'ACUARELA', 'LB+RT is ACUARELA');
    assert.equal(comboBinding(cfg, RT, new Set()), null, 'RT alone is the stomp, no combo');
    assert.equal(comboBinding(cfg, RT, new Set([RB])), null, 'RB+RT is nothing');
    assert.equal(bindingLabel(NAMES, 0, LB), 'LB+A');

    // No (button, modifier) pair is claimed twice anywhere on the surface.
    const seen = new Map();
    for (const kind of HANDLE_KINDS) {
      for (const c of cfg[kind] ?? []) {
        if (!c || c.gamepadButton < 0) continue;
        const key = `${c.gamepadButton}/${c.gamepadModifier ?? -1}`;
        assert.ok(!seen.has(key), `${c.label} and ${seen.get(key)} both claim ${bindingLabel(NAMES, c.gamepadButton, c.gamepadModifier)}`);
        seen.set(key, c.label);
      }
    }
  });
}
