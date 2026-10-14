'use strict';
// Safety switches: start SAFE, interlock blocks linked sACN buttons, disarm
// forces them to default, panic clears everything, retire disarms the old channel.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/main/config-store.js');
const safety = require('../src/renderer/js/safety.js');
const { applySacn } = require('../src/renderer/js/sacn-button.js');
const { parse } = require('../src/main/dmx-out.js');

function setup() {
  const cfg = store.defaults();
  cfg.safeties = [store.safety(0, { id: 'arm1', label: 'CO2 ARM', universe: 8, channel: 1, armedValue: 200, safeValue: 5 })];
  cfg.fxButtons[0] = applySacn({ ...cfg.fxButtons[0], output: 'sacn', mode: 'toggle', value: 255,
    sacn: { ...cfg.fxButtons[0].sacn, universe: 8, channel: 3, defaultValue: 0, safety: 'arm1' } });
  cfg.fxButtons[1] = applySacn({ ...cfg.fxButtons[1], output: 'sacn', mode: 'hold', value: 255,
    sacn: { ...cfg.fxButtons[1].sacn, universe: 8, channel: 4, defaultValue: 0, safety: '' } });
  const sent = [];
  const rogger = { sendTyped: (a, args) => sent.push([parse(a), args[0].value]) };
  return { cfg, sent, rogger };
}
const last = (sent, ch) => sent.filter(([t]) => t.channel === ch).at(-1)?.[1];

test('a safety must be armed for its buttons; others are free', () => {
  const { cfg, sent, rogger } = setup();
  safety.panic(cfg, rogger);
  assert.equal(safety.blocked(cfg.fxButtons[0]), true);
  assert.equal(safety.blocked(cfg.fxButtons[1]), false, 'no safety named');
  assert.equal(safety.blocked(store.defaults().fxButtons[2]), false, 'OSC button');
  safety.setArmed('arm1', true, cfg, rogger);
  assert.equal(last(sent, 1), 200, 'armed value on the safety channel');
  assert.equal(safety.blocked(cfg.fxButtons[0]), false);
});

test('disarm forces linked buttons off and sends SAFE', () => {
  const { cfg, sent, rogger } = setup();
  let forced = 0;
  const off = safety.registerForceOff('fxButtons:0', () => { forced += 1; });
  safety.setArmed('arm1', true, cfg, rogger);
  safety.setArmed('arm1', false, cfg, rogger);
  assert.equal(forced, 1);
  assert.equal(last(sent, 1), 5, 'SAFE value');
  assert.equal(last(sent, 3), 0, 'linked button back to its default');
  assert.equal(last(sent, 4), undefined, 'unlinked button untouched');
  off();
});

test('panic: every safety SAFE, every sACN button at default', () => {
  const { cfg, sent, rogger } = setup();
  safety.setArmed('arm1', true, cfg, rogger);
  safety.panic(cfg, rogger);
  assert.deepEqual(safety.armedIds(), []);
  assert.equal(last(sent, 1), 5); assert.equal(last(sent, 3), 0); assert.equal(last(sent, 4), 0);
});

test('launch and retire send SAFE on the given channel; newSafety ids are unique', () => {
  const { cfg, sent, rogger } = setup();
  safety.sendAllSafe(cfg, rogger);
  assert.equal(last(sent, 1), 5);
  safety.setArmed('arm1', true, cfg, rogger);
  safety.retire('arm1', cfg, rogger);
  assert.equal(safety.isArmed('arm1'), false);
  const a = safety.newSafety([]); const b = safety.newSafety([a]);
  assert.notEqual(a.id, b.id); assert.equal(b.label, 'SAFETY 2');
});

test('old configs gain safeties and panic; saved safeties survive a load', () => {
  const m = store.merge({ safeties: [{ id: 'x', label: 'ARM', channel: 9 }] });
  assert.equal(m.safeties[0].channel, 9); assert.equal(m.safeties[0].armedValue, 255);
  assert.equal(store.merge({}).panicButtons[0].id, 'panic');
  assert.deepEqual(store.merge({}).safeties, []);
});

test('two-hand: both bound pad buttons must be down', () => {
  const s = store.safety(0, { twoHand: true, gamepadButton: 8, gamepadModifier: 9 });
  const pad = held => [{ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.includes(i) })) }];
  assert.equal(s.armHoldMs, 1000);
  assert.equal(safety.bothHeld(s, pad([8, 9])), true);
  assert.equal(safety.bothHeld(s, pad([8])), false);
  assert.equal(safety.bothHeld(s, pad([9])), false);
  assert.equal(safety.bothHeld(s, [null]), false);
});
