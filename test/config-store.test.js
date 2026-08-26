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
  // A pad button may carry a plain binding and combos with different
  // modifiers; the (button, modifier) pair is what must be unique.
  const bound = cfg.fxButtons.filter(b => b.gamepadButton >= 0).map(b => `${b.gamepadButton}/${b.gamepadModifier ?? -1}`);
  assert.equal(new Set(bound).size, bound.length, 'no (button, modifier) pair bound twice');
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
  // Resolume 7.26+ composition Transform has no /effect/ segment (verified
  // live via Art-Net + REST readback); the legacy .../transform/effect/<p>
  // form is still covered as a fan-out target in tools/dmx_map.py.
  assert.equal(cfg.sticks.ls.x.address, '/composition/video/effects/transform/positionx');
  assert.equal(cfg.sticks.rs.y.address, '/composition/video/effects/transform/scale');
  assert.ok(!cfg.sticks.ls.x.address.includes('/effect/'), 'stick params must not use the legacy /effect/ segment');
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

const LOGO_COLORIZE_8 = '/composition/layers/8/video/effects/colorize/effect/color';
const LOGO_COLORIZE_9 = '/composition/layers/9/video/effects/colorize/effect/color';
const LOGO_HAZE_8 = '/composition/layers/8/video/effects/outlinehaze/effect/color';
const LOGO_HAZE_9 = '/composition/layers/9/video/effects/outlinehaze/effect/color';
const LOGO_COLORIZE_10 = '/composition/layers/10/video/effects/colorize/effect/color';
const LOGO_HAZE_10 = '/composition/layers/10/video/effects/outlinehaze/effect/color';

test('a saved colorTargets list is authoritative: a deleted built-in stays deleted', () => {
  const file = path.join(dir, 'config.json');
  // The operator removed both MORPH targets in the editor and the app saved
  // the list without them. They must not come back on the next launch.
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
  assert.deepEqual(ids, ['bg', 'logo', 'flash'], 'nothing the operator removed is resurrected');
  assert.equal(cfg.colorTargets.active, 'logo', 'saved active target kept');
  assert.equal(cfg.colorTargets.items[0].swatch, '#123456', 'saved customization kept');
  assert.equal(cfg.colorTargets.items[0].label, 'BG', 'missing fields filled from the default of that id');
  assert.ok(cfg.colorTargets.items[0].colorBases[0].includes('groups/1/video/effects/colorize'));
  assert.equal(cfg.colorMorph.speedAddress, '/composition/video/effects/colormorph/effect/speed');
});

test('a config with no colorTargets section, or an empty list, gets the defaults', () => {
  const none = store.merge({ network: { targetIp: '1.2.3.4' } });
  assert.deepEqual(none.colorTargets, store.defaults().colorTargets);
  const empty = store.merge({ colorTargets: { active: 'bg', items: [] } });
  assert.deepEqual(empty.colorTargets, store.defaults().colorTargets, 'the picker always has somewhere to send');
});

test('a saved active id that no longer exists falls back to the first saved target', () => {
  const merged = store.merge({ colorTargets: { active: 'morph1', items: [{ id: 'flash' }, { id: 'bg' }] } });
  assert.equal(merged.colorTargets.active, 'flash');
});

test('the LOGO target drives every colour on all three logo layers, linked', () => {
  const logo = store.defaults().colorTargets.items.find(t => t.id === 'logo');
  // Colorize is what actually tints the logos on LOGO DJ (8), LOGO MAIN (9)
  // and LOGO OPT1 (10); OutlineHaze is the optional glow the HAZE toggle
  // switches on. One pick must land on all six so the logos never drift apart.
  assert.deepEqual(logo.colorBases, [LOGO_COLORIZE_8, LOGO_COLORIZE_9, LOGO_COLORIZE_10, LOGO_HAZE_8, LOGO_HAZE_9, LOGO_HAZE_10]);
  const bypassSteps = steps => steps.map(s => `${s.address}=${s.values.join(',')}`);
  assert.deepEqual(bypassSteps(logo.onSteps), [
    '/composition/layers/8/video/effects/colorize/bypassed=0',
    '/composition/layers/9/video/effects/colorize/bypassed=0',
    '/composition/layers/10/video/effects/colorize/bypassed=0',
  ], 'picking a colour switches Colorize on for all three logos');
  assert.deepEqual(bypassSteps(logo.offSteps), [
    '/composition/layers/8/video/effects/colorize/bypassed=1',
    '/composition/layers/9/video/effects/colorize/bypassed=1',
    '/composition/layers/10/video/effects/colorize/bypassed=1',
    '/composition/layers/8/video/effects/outlinehaze/bypassed=1',
    '/composition/layers/9/video/effects/outlinehaze/bypassed=1',
    '/composition/layers/10/video/effects/outlinehaze/bypassed=1',
  ], 'OFF returns all three logos to their own colours and drops the haze');
});

test('the page-2 content pushers fade back on release; every other ramp snaps', () => {
  const cfg = store.defaults();
  const pushers = cfg.fxButtons2.filter(b => b.ramp?.enabled);
  assert.deepEqual(pushers.map(b => b.label), ['EDGE FX', 'ACUARELA', 'BLOOM', 'GOO', 'INF ZOOM', 'METASHAPE', 'GLITCH', 'HUE SPIN']);
  assert.ok(pushers.every(b => b.ramp.releaseMs === 1000), 'a 1 s fade back instead of a snap');
  for (const kind of ['fxButtons', 'fxButtons3', 'utilButtons']) {
    assert.ok(cfg[kind].every(b => (b.ramp?.releaseMs ?? 0) === 0), `${kind}: snap back (0)`);
  }
  // A config saved before the field existed: the default's fade fills in.
  const merged = store.merge({ fxButtons2: [null, { label: 'ACUARELA', ramp: { enabled: true, from: 0, to: 1, durationMs: 2000 } }] });
  assert.equal(merged.fxButtons2[1].ramp.releaseMs, 1000);
});

test('the HAZE toggle switches OutlineHaze on all three logo layers', () => {
  const haze = store.defaults().utilButtons.find(b => b.label === 'HAZE');
  const all = [haze.address, haze.extraAddress, ...haze.extraAddresses];
  assert.deepEqual(all, [8, 9, 10].map(n => `/composition/layers/${n}/video/effects/outlinehaze/bypassed`));
  assert.equal(haze.mode, 'toggle');
  assert.deepEqual([haze.value, haze.offValue], [0, 1], 'on = un-bypass, off = bypass');
  // A 2.2.5 config saved HAZE without the new field: the default fills it in.
  const merged = store.merge({ utilButtons: [null, { label: 'HAZE', address: haze.address, extraAddress: haze.extraAddress }] });
  assert.deepEqual(merged.utilButtons[1].extraAddresses, haze.extraAddresses, 'layer 10 joins the saved HAZE on load');
});

test('an untouched 2.2.0–2.2.5 LOGO target (layers 8 + 9) is upgraded to include LOGO OPT1 on load', () => {
  // Exactly what every config saved by 2.2.0 – 2.2.5 holds for LOGO.
  const bypass = (n, fx, v) => ({ address: `/composition/layers/${n}/video/effects/${fx}/bypassed`, values: [v] });
  const saved = {
    id: 'logo', label: 'LOGO', swatch: '#eaeef5',
    colorBases: [LOGO_COLORIZE_8, LOGO_COLORIZE_9, LOGO_HAZE_8, LOGO_HAZE_9],
    onSteps: [bypass(8, 'colorize', 0), bypass(9, 'colorize', 0)],
    offSteps: [bypass(8, 'colorize', 1), bypass(9, 'colorize', 1), bypass(8, 'outlinehaze', 1), bypass(9, 'outlinehaze', 1)],
  };
  const fresh = store.defaults().colorTargets.items.find(t => t.id === 'logo');
  const upgraded = store.merge({ colorTargets: { active: 'logo', items: [{ ...saved, swatch: '#010203' }] } })
    .colorTargets.items[0];
  assert.deepEqual(upgraded.colorBases, fresh.colorBases, 'layer 10 joins without a reset');
  assert.deepEqual(upgraded.onSteps, fresh.onSteps);
  assert.deepEqual(upgraded.offSteps, fresh.offSteps);
  assert.equal(upgraded.swatch, '#010203', 'cosmetic customization survives');
  const custom = { ...saved, colorBases: [LOGO_COLORIZE_8] };
  const kept = store.merge({ colorTargets: { active: 'logo', items: [custom] } }).colorTargets.items[0];
  assert.deepEqual(kept.colorBases, [LOGO_COLORIZE_8], 'a wiring the operator changed is theirs');
});

test('an untouched legacy LOGO target (haze only) is upgraded on load, a customized one is left alone', () => {
  // Exactly what every config saved before this change holds for LOGO.
  const legacy = {
    id: 'logo', label: 'LOGO', swatch: '#eaeef5',
    colorBases: [LOGO_HAZE_8, LOGO_HAZE_9],
    onSteps: [],
    offSteps: [
      { address: '/composition/layers/8/video/effects/outlinehaze/bypassed', values: [1] },
      { address: '/composition/layers/9/video/effects/outlinehaze/bypassed', values: [1] },
    ],
  };
  const fresh = store.defaults().colorTargets.items.find(t => t.id === 'logo');

  const upgraded = store.merge({ colorTargets: { active: 'bg', items: [{ ...legacy, swatch: '#abcdef' }] } })
    .colorTargets.items[0];
  assert.deepEqual(upgraded.colorBases, fresh.colorBases, 'wiring follows the shipped default');
  assert.deepEqual(upgraded.onSteps, fresh.onSteps);
  assert.deepEqual(upgraded.offSteps, fresh.offSteps);
  assert.equal(upgraded.swatch, '#abcdef', 'cosmetic customization survives the upgrade');

  const custom = { ...legacy, colorBases: [LOGO_HAZE_8] };
  const kept = store.merge({ colorTargets: { active: 'bg', items: [custom] } }).colorTargets.items[0];
  assert.deepEqual(kept.colorBases, [LOGO_HAZE_8], 'a target the operator rewired is not touched');
  assert.deepEqual(kept.offSteps, legacy.offSteps);
});

test('save() creates parent directories', () => {
  const file = path.join(dir, 'nested', 'deep', 'config.json');
  store.save(file, store.defaults());
  assert.ok(fs.existsSync(file));
});

// merge() backs config:import — it must never let a partial or foreign file
// crash or half-configure the app.
test('merge() of a partial patch fills the rest from defaults and preserves network', () => {
  const cfg = store.merge({ network: { targetIp: '10.1.1.1' }, fxButtons: [{ label: 'IMPORTED' }] });
  assert.equal(cfg.network.targetIp, '10.1.1.1');
  assert.equal(cfg.network.targetPort, 7000, 'untouched network fields keep their default');
  assert.equal(cfg.fxButtons.length, 16, 'array repaired to default length');
  assert.equal(cfg.fxButtons[0].label, 'IMPORTED');
  assert.ok(cfg.fxButtons[0].address.startsWith('/'), 'missing fields on the merged entry are filled in');
});

test('merge() of undefined/null/garbage returns plain defaults, never throws', () => {
  for (const garbage of [undefined, null, 'not json', 42, true, []]) {
    assert.doesNotThrow(() => store.merge(garbage));
    const cfg = store.merge(garbage);
    assert.equal(cfg.fxButtons.length, 16);
    assert.equal(cfg.network.targetPort, 7000);
  }
});

test('merge() of an object with unrelated/foreign keys ignores them safely', () => {
  const cfg = store.merge({ someRandomThirdPartyExport: true, version: 999, network: null });
  assert.equal(cfg.version, 1, 'version is not attacker/foreign-file controlled');
  assert.equal(cfg.network.targetIp, '192.168.1.100', 'a null network section falls back to defaults');
  assert.equal(cfg.fxButtons.length, 16);
});

test('merge() round-trips an export()-shaped full config unchanged', () => {
  const exported = store.defaults();
  exported.network.targetIp = '10.9.9.9';
  exported.fxButtons[2].label = 'CUSTOM FLASH';
  const cfg = store.merge(JSON.parse(JSON.stringify(exported)));
  assert.equal(cfg.network.targetIp, '10.9.9.9');
  assert.equal(cfg.fxButtons[2].label, 'CUSTOM FLASH');
});

test('the utility strip can grow past the defaults, the fixed banks cannot', () => {
  // The strip is a row that simply gets longer, so a button added by hand must
  // survive a load. A bank has a set number of slots — a 17th button rendered
  // into an 8-slot grid helps nobody.
  const base = store.defaults();
  const patch = structuredClone(base);
  patch.utilButtons.push({ ...patch.utilButtons[0], id: 'util99', label: 'EXTRA', address: '/composition/master' });
  patch.fxButtons.push({ ...patch.fxButtons[0], id: 'fx99', label: 'OVERFLOW' });
  const merged = store.merge(patch);
  assert.equal(merged.utilButtons.length, base.utilButtons.length + 1);
  assert.equal(merged.utilButtons.at(-1).label, 'EXTRA');
  assert.equal(merged.utilButtons.at(-1).mode, patch.utilButtons[0].mode, 'inherits the shape of a real control');
  assert.equal(merged.fxButtons.length, base.fxButtons.length, 'banks stay their declared size');
});

test('a colour target added by hand survives a load', () => {
  const base = store.defaults();
  const patch = structuredClone(base);
  patch.colorTargets.items.push({
    id: 'boom', label: 'BOOM', swatch: '#ff7a1a',
    colorBases: ['/composition/video/effects/boomer/effect/colorizecolor'],
    onSteps: [], offSteps: [],
  });
  const merged = store.merge(patch);
  assert.equal(merged.colorTargets.items.length, base.colorTargets.items.length + 1);
  const added = merged.colorTargets.items.at(-1);
  assert.equal(added.label, 'BOOM');
  assert.deepEqual(added.colorBases, ['/composition/video/effects/boomer/effect/colorizecolor']);
});

test('a hand-added target with no wiring starts blank, not with a copy of another target\'s addresses', () => {
  const patch = structuredClone(store.defaults());
  patch.colorTargets.items.push({ id: 'blank', label: 'BLANK' });
  const added = store.merge(patch).colorTargets.items.at(-1);
  assert.deepEqual(added.colorBases, []);
  assert.deepEqual(added.onSteps, []);
  assert.deepEqual(added.offSteps, []);
  assert.equal(typeof added.swatch, 'string');
});

test('a stray duplicate target id is ignored, not allowed to hijack the real one', () => {
  const patch = structuredClone(store.defaults());
  patch.colorTargets.items.push({ id: 'bg', label: 'IMPOSTOR', colorBases: ['/nonsense'] });
  const merged = store.merge(patch);
  assert.equal(merged.colorTargets.items.length, 5, 'no sixth target appears');
  assert.equal(merged.colorTargets.items[0].label, 'BG', 'the first entry with that id wins');
  assert.ok(!merged.colorTargets.items[0].colorBases.includes('/nonsense'));
});

test('the colour presets carry no address of their own', () => {
  // They route through whichever target is active; an address here would only
  // lie to the editor about what the button does.
  for (const preset of store.defaults().colorButtons) {
    assert.equal(preset.address, '', preset.label);
    assert.deepEqual(preset.args, [], preset.label);
    assert.ok(Array.isArray(preset.rgb) || preset.isOff, `${preset.label} routes through a target`);
  }
});
