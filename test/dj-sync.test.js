'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDjButtons, crossCheck, isColumnKeyed, namesAgree, normalise, findGroup,
} = require('../src/main/dj-sync.js');

const clip = name => ({ name: { value: name ?? '' } });
const layer = (name, names, id) => ({ id, name: { value: name }, clips: names.map(clip) });

/** A composition shaped like the real one: a name plate layer grouped with
 *  a per-artist video layer and a static backplate. */
function composition({ names, dj, extra, wing } = {}) {
  const nameLayer = layer('TC/PB NAME SOURCE', names ?? ['OFF', 'ALPHA', 'BRAVO'], 100);
  const djLayer = layer('TC/PB DJ', dj ?? ['OFF', 'booth_alpha', 'booth_bravo'], 101);
  const backplate = layer('TC/PB EXTRA', extra ?? ['plate_01', 'plate_01', 'plate_01'], 102);
  const wingLayer = layer('TC/PB WING', wing ?? ['OFF', '', ''], 103);
  return {
    layers: [layer('VIDEO 1', ['a', 'b', 'c'], 1), backplate, djLayer, wingLayer, nameLayer],
    layergroups: [
      { name: { value: 'STOCKS' }, id: 9, layers: [{ id: 1 }] },
      { name: { value: 'TC A/B' }, id: 10, layers: [{ id: 102 }, { id: 101 }, { id: 103 }, { id: 100 }] },
    ],
  };
}

const slots = n => Array.from({ length: n }, (_, i) => ({
  id: `dj${i + 1}`, label: `#${i + 1}`, icon: '·', color: '#3a3f47',
  mode: 'tap', type: 'int', value: 1, releaseValue: 0, releaseAddress: '', address: '',
}));

test('normalise strips authoring conventions down to the name', () => {
  assert.equal(normalise('stage_dj_booth_alpha'), 'stagedjboothalpha');
  assert.equal(normalise('TWO WORDS'), 'twowords');
  assert.equal(normalise(null), '');
});

test('namesAgree matches a short name inside a long clip filename', () => {
  assert.ok(namesAgree('ALPHA', 'stage_dj_booth_alpha'));
  assert.ok(namesAgree('DELTA', 'stage_dj_booth_deltaecho'), 'a fuller name still counts');
  assert.ok(namesAgree('OFF', 'OFF'));
  assert.ok(namesAgree('ANYTHING', ''), 'an empty slot cannot disagree');
  assert.equal(namesAgree('BRAVO', 'stage_dj_booth_charlie'), false);
  assert.equal(namesAgree('DELTTA', 'stage_dj_booth_delta'), false, 'a typo must not be waved through');
});

test('isColumnKeyed tells a per-artist layer from a static backplate', () => {
  assert.ok(isColumnKeyed(layer('DJ', ['OFF', 'a_alpha', 'b_bravo', 'c_charlie'])));
  assert.equal(isColumnKeyed(layer('PLATE', ['p_01', 'p_01', 'p_01', 'p_01'])), false);
  assert.equal(isColumnKeyed(layer('WING', ['OFF'])), false, 'too few clips to judge');
});

test('buildDjButtons targets the group column, not the bare layer clip', () => {
  const { buttons, report } = buildDjButtons(composition(), slots(3));
  assert.equal(report.layer, 'TC/PB NAME SOURCE');
  assert.equal(report.group, 'TC A/B');
  // group index 1 in layergroups -> /composition/groups/2/...
  assert.equal(buttons[0].address, '/composition/groups/2/columns/1/connect');
  assert.equal(buttons[2].address, '/composition/groups/2/columns/3/connect');
  assert.deepEqual(buttons.map(b => b.label), ['OFF', 'ALPHA', 'BRAVO']);
  assert.equal(report.synced, 3);
});

test('the OFF clip gets its own icon and colour', () => {
  const { buttons } = buildDjButtons(composition(), slots(3));
  assert.equal(buttons[0].icon, '✕');
  assert.equal(buttons[0].color, '#ff4757');
  assert.equal(buttons[1].icon, '♪');
});

test('falls back to the layer clip when the layer is not in a group', () => {
  const comp = composition();
  comp.layergroups = [];
  const { buttons, report } = buildDjButtons(comp, slots(2));
  assert.equal(report.group, null);
  // name layer is at index 4 -> 1-based 5
  assert.equal(buttons[0].address, '/composition/layers/5/clips/1/connect');
});

test('swapped columns are reported instead of silently copied', () => {
  // The name plate says BRAVO at column 3, but the DJ layer plays charlie there.
  const comp = composition({
    names: ['OFF', 'ALPHA', 'BRAVO', 'CHARLIE'],
    dj: ['OFF', 'booth_alpha', 'booth_charlie', 'booth_bravo'],
    extra: ['plate', 'plate', 'plate', 'plate'],
    wing: ['OFF', '', '', ''],
  });
  const { report } = buildDjButtons(comp, slots(4));
  assert.equal(report.mismatches.length, 2);
  assert.deepEqual(report.mismatches.map(m => m.column), [3, 4]);
  assert.equal(report.mismatches[0].expected, 'BRAVO');
  assert.match(report.mismatches[0].actual, /charlie/);
  assert.equal(report.mismatches[0].layer, 'TC/PB DJ');
});

test('a static backplate never raises a mismatch', () => {
  const comp = composition({
    names: ['OFF', 'ALPHA', 'BRAVO'],
    dj: ['OFF', 'booth_alpha', 'booth_bravo'],
    extra: ['plate_01', 'plate_01', 'plate_01'],
  });
  assert.deepEqual(buildDjButtons(comp, slots(3)).report.mismatches, [],
    'a layer that plays the same clip everywhere says nothing about artists');
});

test('an empty slot on a sibling layer is not a disagreement', () => {
  const comp = composition({
    names: ['OFF', 'ALPHA', 'BRAVO'],
    dj: ['OFF', 'booth_alpha', 'booth_bravo'],
    wing: ['OFF', '', ''],
  });
  assert.deepEqual(buildDjButtons(comp, slots(3)).report.mismatches, []);
});

test('slots past the named clips are cleared instead of keeping a stale name', () => {
  // First sync fills three slots...
  const first = buildDjButtons(composition({ names: ['OFF', 'ALPHA', 'BRAVO'] }), slots(3));
  assert.deepEqual(first.buttons.map(b => b.label), ['OFF', 'ALPHA', 'BRAVO']);
  // ...then the show loses a DJ. The old name must not linger on a button that
  // now fires an empty column.
  const second = buildDjButtons(composition({ names: ['OFF', 'ALPHA'] }), first.buttons);
  assert.deepEqual(second.buttons.map(b => b.label), ['OFF', 'ALPHA', '#3']);
  assert.equal(second.buttons[2].icon, '·');
  assert.equal(second.report.cleared, 1);
  assert.equal(second.report.synced, 2);
});

test('a hand-made button that was never synced survives a sync', () => {
  const custom = slots(3);
  custom[2] = { ...custom[2], label: 'LOGO OFF', address: '/composition/layers/9/clips/1/connect', icon: '⊘' };
  const { buttons, report } = buildDjButtons(composition({ names: ['OFF', 'ALPHA'] }), custom);
  assert.equal(buttons[2].label, 'LOGO OFF', 'a custom button is not collateral damage');
  assert.equal(buttons[2].address, '/composition/layers/9/clips/1/connect');
  assert.equal(report.cleared, 0);
});

test('more buttons than named clips leaves the extras as placeholders', () => {
  const { buttons, report } = buildDjButtons(composition({ names: ['OFF', 'ALPHA'] }), slots(6));
  assert.deepEqual(buttons.map(b => b.label), ['OFF', 'ALPHA', '#3', '#4', '#5', '#6']);
  assert.equal(report.synced, 2);
  assert.equal(report.slots, 6);
});

test('a composition with no name layer is refused, not half-applied', () => {
  const comp = composition();
  comp.layers = comp.layers.filter(l => !l.name.value.includes('NAME'));
  assert.throws(() => buildDjButtons(comp, slots(3)), /No layer with NAME/);
});

test('findGroup resolves sibling layers through their ids', () => {
  const comp = composition();
  const nameLayer = comp.layers.find(l => l.name.value.includes('NAME'));
  const g = findGroup(comp, nameLayer);
  assert.equal(g.index, 1);
  assert.deepEqual(g.members.map(l => l.name.value),
    ['TC/PB EXTRA', 'TC/PB DJ', 'TC/PB WING', 'TC/PB NAME SOURCE']);
});

test('crossCheck reports every disagreeing layer for a column', () => {
  const nameLayer = layer('NAME', ['OFF', 'ALPHA'], 1);
  const a = layer('DJ A', ['OFF', 'booth_charlie'], 2);
  const b = layer('DJ B', ['OFF', 'booth_bravo'], 3);
  const problems = crossCheck({ nameLayer, members: [nameLayer, a, b], columns: 2 });
  // both siblings are static two-clip layers, so nothing is column-keyed yet
  assert.deepEqual(problems, []);

  const a3 = layer('DJ A', ['OFF', 'booth_charlie', 'pult_x', 'pult_y'], 2);
  const n3 = layer('NAME', ['OFF', 'ALPHA', 'X', 'Y'], 1);
  const found = crossCheck({ nameLayer: n3, members: [n3, a3], columns: 4 });
  assert.equal(found.length, 1);
  assert.equal(found[0].column, 2);
});
