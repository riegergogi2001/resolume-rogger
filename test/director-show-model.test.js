'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// show-model.js is an ES module (shared with the Electron renderer), loaded
// dynamically here since the rest of the test suite is CommonJS.
let showModel;
before(async () => {
  showModel = await import(pathToFileURL(path.join(__dirname, '../src/renderer/js/director/show-model.js')).href);
});

// Synthetic composition resembling the real rig: 4 hero layers, a text
// banner, a logo, an FX layer with a representative clip mix, and every
// flavor of protected layer (timecode, timer, LFV route).
function comp({ wrapNames = true } = {}) {
  const n = (v) => (wrapNames ? { value: v } : v);
  const heroLayer = (label, clipLabel) => ({
    name: n(label),
    clips: [{ name: n(clipLabel) }],
  });
  return {
    layers: [
      heroLayer('VIDEO 1', 'GeneraXYZ_07'),
      heroLayer('VIDEO 2', 'GeneraXYZ_07'),
      heroLayer('VIDEO 3', 'GeneraXYZ_07'),
      heroLayer('VIDEO 4', 'GeneraXYZ_07'),
      { name: n('BANNER MAIN'), clips: [] },
      { name: n('LOGO DJ'), clips: [] },
      { name: n('INPUT'), clips: [{ name: n('Whatever') }] },
      {
        name: n('FX 1'),
        clips: [
          { name: n('Blank') },
          { name: n('GeneraXYZ_07') },
          { name: n('FLASH MASTER') },
          { name: n('FLASH MASTER') },
          { name: n('INVERT') },
          { name: n('PIXELATE') },
          { name: n('FE STR') },
          { name: n('SUCK IT!') },
          { name: n('SLICE STROBE') },
        ],
      },
      { name: n('TC/PB DJ'), clips: [{ name: n('Something') }] },
      { name: n('DJ TIMER'), clips: [{ name: n('Something') }] },
      { name: n('LFV ROUTE'), clips: [{ name: n('Something') }] },
    ],
  };
}

test('classifyClip: role heuristics', () => {
  assert.equal(showModel.classifyClip('FLASH MASTER'), 'flash');
  assert.equal(showModel.classifyClip('SLICE STROBE'), 'strobe');
  assert.equal(showModel.classifyClip('INVERT'), 'camerafx');
  assert.equal(showModel.classifyClip('PIXELATE'), 'camerafx');
  assert.equal(showModel.classifyClip('FE STR'), 'camerafx');
  assert.equal(showModel.classifyClip('SUCK IT!'), 'impact');
  assert.equal(showModel.classifyClip('Blank'), 'transition');
  assert.equal(showModel.classifyClip('GeneraXYZ_07'), 'hero');
  assert.equal(showModel.classifyClip(null), 'unknown');
  assert.equal(showModel.classifyClip(''), 'unknown');
  assert.equal(showModel.classifyClip('random name'), 'unknown');
});

test('classifyLayer: protected detection for every default protected pattern', () => {
  const protectedNames = ['TC/PB DJ', 'DJ TIMER', 'LFV ROUTE', 'INPUT', 'TC MASTER', 'AUDIO IN', 'AB SYNC', 'SYNC OUT'];
  for (const name of protectedNames) {
    assert.equal(showModel.classifyLayer(name).protected, true, `${name} should be protected`);
  }
  assert.equal(showModel.classifyLayer('VIDEO 1').protected, false);
});

test('classifyLayer: custom extraProtected pattern protects extra layers', () => {
  assert.equal(showModel.classifyLayer('KILLSWITCH', []).protected, false);
  assert.equal(showModel.classifyLayer('KILLSWITCH', ['KILLSWITCH']).protected, true);
  assert.equal(showModel.classifyLayer('killswitch', ['KILLSWITCH']).protected, true, 'case-insensitive');
});

test('classifyLayer: role heuristics', () => {
  assert.equal(showModel.classifyLayer('VIDEO 1').role, 'hero');
  assert.equal(showModel.classifyLayer('BANNER MAIN').role, 'text');
  assert.equal(showModel.classifyLayer('LOGO DJ').role, 'logo');
  assert.equal(showModel.classifyLayer('FX 1').role, 'camerafx');
  assert.equal(showModel.classifyLayer('BG LOOP').role, 'hero', 'VIDEO/LOOP wins before BG in the given order');
  assert.equal(showModel.classifyLayer('ATMO PAD').role, 'atmosphere');
  assert.equal(showModel.classifyLayer('PART CLOUD').role, 'particles');
  assert.equal(showModel.classifyLayer('???').role, 'unknown');
});

test('buildShowModel: clips on protected layers never appear in clipsByRole', () => {
  const model = showModel.buildShowModel(comp());
  for (const [role, entries] of Object.entries(model.clipsByRole)) {
    for (const entry of entries) {
      const layer = model.layers[entry.layerIndex - 1];
      assert.equal(layer.protected, false, `clip "${entry.name}" (role ${role}) leaked from protected layer "${layer.name}"`);
    }
  }
  // explicit spot checks: the protected layers' clips are gone entirely
  const allClipNames = Object.values(model.clipsByRole).flat().map((c) => c.name);
  assert.ok(!allClipNames.includes('Something'), 'clips named "Something" only live on protected layers');
});

test('buildShowModel: protectedLayers lists every protected layer name', () => {
  const model = showModel.buildShowModel(comp());
  assert.deepEqual(model.protectedLayers, ['INPUT', 'TC/PB DJ', 'DJ TIMER', 'LFV ROUTE']);
  assert.equal(model.stats.protectedCount, 4);
});

test('buildShowModel: hasRole reflects only non-protected clips/layers', () => {
  const model = showModel.buildShowModel(comp());
  assert.equal(model.hasRole('strobe'), true, 'SLICE STROBE lives on the non-protected FX 1 layer');
  assert.equal(model.hasRole('particles'), false, 'no particle clips or layers in this comp');
  assert.equal(model.hasRole('hero'), true);
  assert.equal(model.hasRole('flash'), true);
  assert.equal(model.hasRole('camerafx'), true);
  assert.equal(model.hasRole('impact'), true);
});

test('buildShowModel: layer/clip indices are 1-based and stable', () => {
  const model = showModel.buildShowModel(comp());
  assert.equal(model.layers[0].index, 1);
  assert.equal(model.layers[0].name, 'VIDEO 1');
  const fxLayer = model.layers.find((l) => l.name === 'FX 1');
  assert.equal(fxLayer.clips[0].index, 1);
  assert.equal(fxLayer.clips[0].name, 'Blank');
  assert.equal(fxLayer.clips.length, 9);
});

test('buildShowModel: stats counts are correct', () => {
  const model = showModel.buildShowModel(comp());
  const totalClips = model.layers.reduce((sum, l) => sum + l.clips.length, 0);
  assert.equal(model.stats.layers, 11);
  assert.equal(model.stats.clips, totalClips);
  const classifiedManually = model.layers
    .flatMap((l) => l.clips)
    .filter((c) => c.role !== 'unknown').length;
  assert.equal(model.stats.classified, classifiedManually);
  assert.ok(model.stats.classified > 0 && model.stats.classified <= model.stats.clips);
});

test('buildShowModel: names given as plain strings (not {value}) also work', () => {
  const model = showModel.buildShowModel(comp({ wrapNames: false }));
  assert.equal(model.layers[0].name, 'VIDEO 1');
  assert.equal(model.layers[0].role, 'hero');
  assert.equal(model.protectedLayers.includes('INPUT'), true);
  assert.equal(model.hasRole('strobe'), true);
});

test('buildShowModel: tolerates empty/missing composition without throwing', () => {
  assert.doesNotThrow(() => showModel.buildShowModel({}));
  assert.doesNotThrow(() => showModel.buildShowModel({ layers: null }));
  assert.doesNotThrow(() => showModel.buildShowModel(undefined));
  assert.doesNotThrow(() => showModel.buildShowModel(null));

  for (const input of [{}, { layers: null }, undefined, null]) {
    const model = showModel.buildShowModel(input);
    assert.deepEqual(model.layers, []);
    assert.deepEqual(model.protectedLayers, []);
    assert.deepEqual(model.clipsByRole, {});
    assert.equal(model.hasRole('hero'), false);
    assert.deepEqual(model.stats, { layers: 0, protectedCount: 0, clips: 0, classified: 0 });
  }
});

test('buildShowModel: tolerates layers/clips with missing or null names', () => {
  const model = showModel.buildShowModel({
    layers: [
      {},
      { name: null, clips: [{}, { name: null }, { name: {} }] },
      { name: { value: null } },
    ],
  });
  assert.equal(model.layers.length, 3);
  assert.ok(model.layers.every((l) => l.name === ''));
  assert.equal(model.layers[1].clips.length, 3);
  assert.ok(model.layers[1].clips.every((c) => c.name === '' && c.role === 'unknown'));
});
