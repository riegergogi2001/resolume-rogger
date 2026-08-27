'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { planRecall, coveredBy, isRecallTarget, hexToRgb01, chipOrder } = require('../src/renderer/js/color-recall.js');
const store = require('../src/main/config-store.js');

const items = () => store.defaults().colorTargets.items;
const all = () => items().find(t => t.id === 'all');

test('the shipped ALL is a recall trigger covering BG, LOGO and FLASH — not MORPH, not itself', () => {
  assert.ok(isRecallTarget(all()));
  assert.deepEqual(items().filter(t => coveredBy(all(), t)).map(t => t.id), ['bg', 'logo', 'flash']);
  assert.ok(isRecallTarget({ id: 'x', recall: true }), 'a hand-made target can be flagged');
  assert.ok(isRecallTarget({ id: 'all' }), 'an ALL from an older config counts without the flag');
});

test('a recall sends each covered target its ON steps and its OWN colour, remembered or swatch', () => {
  const memory = { logo: [0.2, 0.4, 0.6] }; // LOGO was picked; BG and FLASH never were
  const { msgs, colours } = planRecall(items(), all(), id => memory[id] ?? null);
  const bg = items().find(t => t.id === 'bg');
  const logo = items().find(t => t.id === 'logo');
  assert.deepEqual(colours, [['bg', hexToRgb01(bg.swatch)], ['logo', [0.2, 0.4, 0.6]], ['flash', hexToRgb01('#ffd93d')]]);
  const first = msgs[0];
  assert.deepEqual(first, { address: bg.onSteps[0].address, values: [0] }, 'ON step first, so the colour lands on a live effect');
  const logoRed = msgs.find(m => m.address === `${logo.colorBases[0]}/red`);
  assert.deepEqual(logoRed.args, [{ type: 'f', value: 0.2 }]);
  const expected = ['bg', 'logo', 'flash'].reduce((n, id) => {
    const t = items().find(x => x.id === id);
    return n + t.onSteps.length + 3 * t.colorBases.length;
  }, 0);
  assert.equal(msgs.length, expected, 'exactly ON steps + r/g/b per base, nothing else');
  assert.ok(!msgs.some(m => m.address.includes('colormorph')), 'MORPH untouched');
});

test('hexToRgb01', () => {
  assert.deepEqual(hexToRgb01('#ffffff'), [1, 1, 1]);
  assert.deepEqual(hexToRgb01('#000'), [0, 0, 0]);
  assert.deepEqual(hexToRgb01('nonsense'), [1, 1, 1], 'junk falls back to white (the swatch default) rather than throwing');
});

test('chipOrder puts the recall trigger first and keeps every index pointing at the config', () => {
  const cfg = items();
  const order = chipOrder(cfg);
  assert.deepEqual(order.map(e => e.item.id), ['all', 'bg', 'logo', 'flash', 'morph1', 'morph2']);
  // The index is what the editor opens, so it must still address the config
  // array, not the position on screen.
  for (const { item, index } of order) assert.equal(cfg[index].id, item.id);
  assert.deepEqual(chipOrder([]).map(e => e.item.id), [], 'an empty list is not a special case');
  assert.deepEqual(chipOrder(undefined), [], 'nor is a missing one');
  const noRecall = cfg.filter(t => !isRecallTarget(t));
  assert.deepEqual(chipOrder(noRecall).map(e => e.item.id), noRecall.map(t => t.id),
    'without a recall target the config order stands');
});
