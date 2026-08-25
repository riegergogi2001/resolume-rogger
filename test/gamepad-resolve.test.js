'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  HANDLE_KINDS, modifierSet, resolveBinding, bindingLabel, stealBinding,
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

// The shipped pad layout: LB is a clean modifier and LB+A/B/X/Y are the bump
// combos. Checked on both the defaults and the show config, so the two cannot
// drift apart and a plain binding cannot quietly land on LB again.
const store = require('../src/main/config-store.js');
const fs = require('node:fs');
const path = require('node:path');
const LB = 4;

function labelOf(cfg, entry) { return entry ? cfg[entry.kind][entry.index].label : null; }

for (const [name, load] of [
  ['defaults', () => store.defaults()],
  ['configs/campus-forum-stage.json', () => store.load(path.join(__dirname, '..', 'configs', 'campus-forum-stage.json'))],
]) {
  test(`${name}: LB is a clean modifier and LB+A/B/X/Y fire the bump combos`, () => {
    const cfg = load();
    assert.equal(resolveBinding(cfg, LB, new Set([LB])), null, 'nothing fires on LB alone');
    const held = new Set([LB]);
    assert.deepEqual(
      [0, 1, 2, 3].map(b => labelOf(cfg, resolveBinding(cfg, b, held))),
      ['PUSH BLK', 'PUSH X2', 'BOOM BLOW', 'BOOM INV'], 'LB+A/B/X/Y');
    assert.deepEqual(
      [0, 1, 2, 3].map(b => labelOf(cfg, resolveBinding(cfg, b, new Set()))),
      ['PUSH WHT', 'FLASH M', 'FLASH M2', 'INVERT'], 'A/B/X/Y alone are unchanged');
    assert.equal(labelOf(cfg, resolveBinding(cfg, 11, new Set())), 'SUCK IT!', 'SUCK IT! moved to RS-click');
    const RT = 7;
    assert.deepEqual(
      [0, 1, 2, 3].map(b => labelOf(cfg, resolveBinding(cfg, b, new Set([RT])))),
      ['GLITCH', 'BLOOM', 'EDGE FX', 'HUE SPIN'], 'RT+A/B/X/Y are the page-2 content pushers');
    // Both modifiers down is an operator error, not a crash: each button still
    // resolves to one of its two combos (first in page/index order), never to
    // the plain binding.
    for (const b of [0, 1, 2, 3]) {
      const lb = labelOf(cfg, resolveBinding(cfg, b, new Set([LB])));
      const rt = labelOf(cfg, resolveBinding(cfg, b, new Set([RT])));
      const both = labelOf(cfg, resolveBinding(cfg, b, new Set([LB, RT])));
      assert.ok(both === lb || both === rt, `LB+RT+${NAMES[b]} resolves to a combo (${both})`);
    }
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
