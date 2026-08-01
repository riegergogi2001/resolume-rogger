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

test('defaults mirror the autoVJ template: cue-clip flash bank + comp-FX bump bank', () => {
  const cfg = store.defaults();
  assert.ok(cfg.fxButtons.slice(0, 7).every(b => b.mode === 'hold'), 'flash bank is momentary');
  assert.equal(cfg.fxButtons[7].mode, 'toggle', 'slice strobe latches');
  assert.ok(cfg.fxButtons.slice(0, 8).every(b => b.address.startsWith('/composition/layers/12/clips/')),
    'flash bank fires FX-rack cue clips');
  assert.ok(cfg.fxButtons.slice(9).every(b => b.address.startsWith('/composition/video/effects/')),
    'bump bank drives composition-level FX (slot 8 is the hidden spare)');
  const bound = cfg.fxButtons.map(b => b.gamepadButton).filter(p => p >= 0);
  assert.equal(new Set(bound).size, bound.length, 'no gamepad button bound twice');
});

test('default faders are master, layers 1-4, logo and the FX time strips', () => {
  const faders = store.defaults().faders;
  assert.deepEqual(faders.map(f => f.label),
    ['MASTER', 'LAYER 1', 'LAYER 2', 'LAYER 3', 'LAYER 4', 'LOGO', 'PUSH TIME', 'STR SPD']);
  assert.equal(faders[5].address, '/composition/layers/9/master');
  assert.ok(faders.every(f => !f.address.includes('crossfader')));
});

test('new comp FX are on the surface: BOOM INV bump + DISTORT util toggle', () => {
  const cfg = store.defaults();
  const boomInv = cfg.fxButtons2.find(b => b.label === 'BOOM INV');
  assert.equal(boomInv.address, '/composition/video/effects/boomer/effect/invert');
  const distort = cfg.utilButtons.find(b => b.label === 'DISTORT');
  assert.equal(distort.address, '/composition/video/effects/distortion/bypassed');
  assert.equal(distort.value, 0, 'press enables (bypassed=0)');
  assert.equal(distort.offValue, 1, 'off re-bypasses');
  assert.ok(cfg.sticks.ls.x.address.includes('/effect/positionx'), 'stick params use /effect/ segment');
  assert.ok(cfg.sticks.rs.y.address.includes('/effect/scale'));
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

test('load() unions agent rules by id and keeps saved tweaks', () => {
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({
    agent: { feedBeatClock: true, rules: [{ id: 'drop', cooldownMs: 4000 }] },
  }));
  const cfg = store.load(file);
  assert.deepEqual(cfg.agent.rules.map(r => r.id),
    ['drop', 'dropstrobe', 'climax', 'build', 'fakebuild', 'breakdown',
      'vocal', 'vocalend', 'bump', 'kickpush', 'phrasecol', 'steady']);
  assert.equal(cfg.agent.riders.length, 3, 'layer opacity riders present');
  assert.equal(cfg.agent.riders[0].address, '/composition/layers/2/master');
  assert.equal(cfg.agent.rules[0].cooldownMs, 4000, 'saved cooldown kept');
  assert.ok(cfg.agent.rules[0].macro[0].address.includes('/clips/3/connect'), 'default macro kept');
  assert.ok(cfg.agent.rules[0].variants.length >= 2, 'drop cue keeps its variants');
  assert.equal(cfg.agent.feedBeatClock, true);
});

test('save() creates parent directories', () => {
  const file = path.join(dir, 'nested', 'deep', 'config.json');
  store.save(file, store.defaults());
  assert.ok(fs.existsSync(file));
});
