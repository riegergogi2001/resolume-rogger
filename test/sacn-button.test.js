'use strict';
// Native sACN button: editor fields -> the address/values the button runtime uses.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const store = require('../src/main/config-store.js');
const { applySacn, sacnAddress, sendAllDefaults } = require('../src/renderer/js/sacn-button.js');
const { parse } = require('../src/main/dmx-out.js');

const sacnBtn = over => ({ ...store.defaults().fxButtons[0], output: 'sacn', mode: 'hold', value: 255,
  sacn: { universe: 8, channel: 3, defaultValue: 0, host: '', iface: '' }, ...over });

test('defaults carry an OSC output and sACN fields; old configs gain them', () => {
  const b = store.defaults().fxButtons[0];
  assert.equal(b.output, 'osc');
  assert.deepEqual(b.sacn, { universe: 1, channel: 1, defaultValue: 0, host: '', iface: '' });
  const merged = store.merge?.({ fxButtons: [{ label: 'OLD' }] }) ?? null;
  if (merged) assert.equal(merged.fxButtons[0].sacn.channel, 1);
});

test('applySacn derives address and values; dmx-out reads them back', () => {
  const b = applySacn(sacnBtn({ value: 300, sacn: { universe: 8, channel: 3, defaultValue: 12, host: '', iface: '' } }));
  assert.equal(b.type, 'int');
  assert.equal(b.value, 255, 'clamped');
  assert.equal(b.releaseValue, 12); assert.equal(b.offValue, 12);
  const t = parse(b.address);
  assert.equal(t.proto, 'sacn'); assert.equal(t.universe, 8); assert.equal(t.channel, 3); assert.equal(t.def, 12);
  assert.equal(t.host, '239.255.0.8');
});

test('tap is never kept for a DMX button; OSC extras are cleared', () => {
  const b = applySacn(sacnBtn({ mode: 'tap', extraAddresses: ['/x'], macro: [{ address: '/y' }], ramp: { enabled: true } }));
  assert.equal(b.mode, 'hold');
  assert.deepEqual(b.extraAddresses, []); assert.deepEqual(b.macro, []);
  assert.equal(b.ramp.enabled, false);
});

test('unicast / interface options and range clamps', () => {
  const t = parse(sacnAddress({ universe: 0, channel: 999, defaultValue: -5, host: '10.0.0.9', iface: '10.0.0.2' }));
  assert.equal(t.universe, 1); assert.equal(t.channel, 512); assert.equal(t.def, 0);
  assert.equal(t.host, '10.0.0.9'); assert.equal(t.iface, '10.0.0.2');
});

test('OSC buttons are untouched; startup sends each sACN default', () => {
  const osc = store.defaults().fxButtons[1];
  assert.deepEqual(applySacn(structuredClone(osc)), osc);
  const sent = [];
  const cfg = { fxButtons: [applySacn(sacnBtn({ sacn: { universe: 8, channel: 3, defaultValue: 7, host: '', iface: '' } })), osc] };
  sendAllDefaults(cfg, { sendTyped: (a, args) => sent.push([a, args[0].value]) });
  assert.equal(sent.length, 1); assert.match(sent[0][0], /^sacn:\/\/8\/3\?/); assert.equal(sent[0][1], 7);
});
