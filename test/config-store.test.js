'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/main/config-store.js');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rogger-cfg-'));
});

test('defaults() has full control sets and network defaults', () => {
  const cfg = store.defaults();
  assert.equal(cfg.version, 1);
  assert.equal(cfg.fxButtons.length, 16);
  assert.equal(cfg.fxButtons2.length, 16);
  assert.equal(cfg.fxButtons3.length, 24);
  assert.equal(cfg.faders.length, 8);
  assert.equal(cfg.colorButtons.length, 10);
  assert.equal(cfg.network.targetPort, 7000);
  assert.equal(cfg.network.listenPort, 7001);
  assert.equal(cfg.ui.theme, 'dark');
  for (const b of cfg.fxButtons) {
    assert.ok(b.address.startsWith('/'), 'fx button has an OSC address');
    assert.ok(['tap', 'toggle', 'hold'].includes(b.mode));
    assert.equal(typeof b.releaseAddress, 'string');
  }
  for (const f of cfg.faders) {
    assert.ok(f.max > f.min);
    assert.ok(f.defaultValue >= f.min && f.defaultValue <= f.max);
  }
});

test('defaults split into 8 flash (hold) and 8 bump (tap) buttons with unique gamepad bindings', () => {
  const cfg = store.defaults();
  assert.ok(cfg.fxButtons.slice(0, 8).every(b => b.mode === 'hold'), 'flash bank is momentary');
  assert.ok(cfg.fxButtons.slice(8).every(b => b.mode === 'tap'), 'bump bank is one-shot');
  const pads = cfg.fxButtons.map(b => b.gamepadButton);
  assert.ok(pads.every(p => Number.isInteger(p) && p >= 0 && p <= 15));
  assert.equal(new Set(pads).size, 16, 'every controller button bound exactly once');
});

test('default faders are master, layers 1-4, logo and two aux (no crossfader)', () => {
  const faders = store.defaults().faders;
  assert.deepEqual(faders.map(f => f.label),
    ['MASTER', 'LAYER 1', 'LAYER 2', 'LAYER 3', 'LAYER 4', 'LOGO', 'AUX 1', 'AUX 2']);
  assert.equal(faders[5].address, '/composition/layers/5/master');
  assert.ok(faders.every(f => !f.address.includes('crossfader')));
});

test('default bump bank is columns 1-8 (tempo lives in the topbar)', () => {
  const fx = store.defaults().fxButtons;
  assert.equal(fx[14].address, '/composition/columns/7/connect');
  assert.equal(fx[15].address, '/composition/columns/8/connect');
});

test('defaults() returns fresh objects each call', () => {
  const a = store.defaults();
  const b = store.defaults();
  a.fxButtons[0].label = 'MUTATED';
  assert.notEqual(b.fxButtons[0].label, 'MUTATED');
});

test('load() of a missing file returns defaults', () => {
  const cfg = store.load(path.join(dir, 'config.json'));
  assert.equal(cfg.fxButtons.length, 16);
});

test('save() then load() round-trips edits', () => {
  const file = path.join(dir, 'config.json');
  const cfg = store.defaults();
  cfg.network.targetIp = '10.0.0.99';
  cfg.fxButtons[3].label = 'STROBE';
  store.save(file, cfg);
  const loaded = store.load(file);
  assert.equal(loaded.network.targetIp, '10.0.0.99');
  assert.equal(loaded.fxButtons[3].label, 'STROBE');
});

test('load() of corrupt JSON backs up the bad file and returns defaults', () => {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{ not json !!!');
  const cfg = store.load(file);
  assert.equal(cfg.fxButtons.length, 16);
  assert.ok(fs.existsSync(file + '.bad'), 'corrupt file backed up');
});

test('load() deep-merges partial configs over defaults and repairs array lengths', () => {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    network: { targetIp: '192.168.9.9' },
    fxButtons: [{ id: 'fx1', label: 'CUSTOM' }],
  }));
  const cfg = store.load(file);
  assert.equal(cfg.network.targetIp, '192.168.9.9');
  assert.equal(cfg.network.targetPort, 7000, 'missing keys filled from defaults');
  assert.equal(cfg.fxButtons.length, 16, 'array repaired to 16');
  assert.equal(cfg.fxButtons[0].label, 'CUSTOM', 'override preserved');
  assert.ok(cfg.fxButtons[0].address.startsWith('/'), 'missing fields filled in merged entry');
});

test('load() unions colorTargets by id so configs saved before morph targets keep them', () => {
  const file = path.join(dir, 'config.json');
  // a config saved when only bg/logo/flash existed, with a customized bg
  fs.writeFileSync(file, JSON.stringify({
    colorTargets: {
      active: 'logo',
      items: [
        { id: 'bg', swatch: '#123456' },
        { id: 'logo' },
        { id: 'flash' },
      ],
    },
  }));
  const cfg = store.load(file);
  const ids = cfg.colorTargets.items.map(x => x.id);
  assert.deepEqual(ids, ['bg', 'logo', 'flash', 'morph1', 'morph2'], 'new targets survive old saves');
  assert.equal(cfg.colorTargets.active, 'logo', 'saved active target kept');
  assert.equal(cfg.colorTargets.items[0].swatch, '#123456', 'saved customization kept');
  assert.ok(cfg.colorTargets.items[3].colorBases[0].includes('colormorph/effect/color1'));
  assert.ok(cfg.colorTargets.items[4].colorBases[0].includes('colormorph/effect/color3'));
  assert.equal(cfg.colorMorph.speedAddress, '/composition/video/effects/colormorph/effect/speed');
});

test('save() creates parent directories', () => {
  const file = path.join(dir, 'nested', 'deep', 'config.json');
  store.save(file, store.defaults());
  assert.ok(fs.existsSync(file));
});
