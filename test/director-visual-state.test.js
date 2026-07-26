'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const modUrl = pathToFileURL(path.join(__dirname, '..', 'src/renderer/js/director/visual-state.js')).href;

test('heat decays by half after one half-life (strobe)', async () => {
  const { VisualState, HALF_LIFE_MS } = await import(modUrl);
  let t = 0;
  const vs = new VisualState(() => t);
  vs.noteAction('strobe');
  t += HALF_LIFE_MS.strobe;
  assert.ok(Math.abs(vs.heat('strobe') - 0.5) < 0.01);
});

test('repeated actions accumulate heat, capped at 2', async () => {
  const { VisualState } = await import(modUrl);
  let t = 0;
  const vs = new VisualState(() => t);
  vs.noteAction('strobe');
  vs.noteAction('strobe');
  vs.noteAction('strobe'); // raw sum would be 3, capped to 2
  assert.equal(vs.heat('strobe'), 2);
});

test('cost rises with heat and fatigue; cost is 0 with no history', async () => {
  const { VisualState } = await import(modUrl);
  let t = 0;

  const fresh = new VisualState(() => t);
  assert.equal(fresh.cost('strobe'), 0);

  const vs = new VisualState(() => t);
  vs.noteAction('strobe');
  const costAfterOne = vs.cost('strobe');
  assert.ok(costAfterOne > 0);

  for (let i = 0; i < 5; i++) vs.noteAction('flash'); // raises fatigue, not strobe heat
  const costAfterFatigue = vs.cost('strobe');
  assert.ok(costAfterFatigue > costAfterOne);
});

test('clipUseCount counts per id; deckDwellMs Infinity before any deckswitch, then measures elapsed', async () => {
  const { VisualState } = await import(modUrl);
  let t = 0;
  const vs = new VisualState(() => t);

  assert.equal(vs.clipUseCount('clipA'), 0);
  vs.noteAction('clip', { id: 'clipA' });
  vs.noteAction('clip', { id: 'clipB' });
  vs.noteAction('clip', { id: 'clipA' });
  assert.equal(vs.clipUseCount('clipA'), 2);
  assert.equal(vs.clipUseCount('clipB'), 1);

  assert.equal(vs.deckDwellMs(), Infinity);
  t += 5000;
  vs.noteAction('deckswitch');
  assert.equal(vs.deckDwellMs(), 0);
  t += 12345;
  assert.equal(vs.deckDwellMs(), 12345);
});

test('tension decays toward 0 with a 60s half-life', async () => {
  const { VisualState } = await import(modUrl);
  let t = 0;
  const vs = new VisualState(() => t);

  vs.setTension(1.5); // clamps to 1
  assert.equal(vs.tension, 1);

  vs.setTension(1.0);
  t += 60000;
  assert.ok(Math.abs(vs.tension - 0.5) < 0.01);

  vs.setTension(-1); // clamps to 0
  assert.equal(vs.tension, 0);
});

test('fatigue: 6 non-clip actions within a minute -> 0.5; clip actions do not count', async () => {
  const { VisualState } = await import(modUrl);
  let t = 0;
  const vs = new VisualState(() => t);

  for (let i = 0; i < 6; i++) {
    vs.noteAction('flash');
    t += 10000; // 6 actions spread across 50s, well within a minute
  }
  assert.ok(Math.abs(vs.fatigue() - 0.5) < 1e-9);

  vs.noteAction('clip', { id: 'x' });
  assert.ok(Math.abs(vs.fatigue() - 0.5) < 1e-9);
});

test('snapshot() returns a JSON-serializable object with all keys; recent capped at 20', async () => {
  const { VisualState, HALF_LIFE_MS } = await import(modUrl);
  let t = 0;
  const vs = new VisualState(() => t);

  for (let i = 0; i < 25; i++) {
    vs.noteAction('flash', { i });
    t += 1000;
  }

  const snap = vs.snapshot();
  assert.equal(typeof snap.heats, 'object');
  for (const category of Object.keys(HALF_LIFE_MS)) {
    assert.ok(category in snap.heats, `missing heat for ${category}`);
  }
  assert.equal(typeof snap.fatigue, 'number');
  assert.equal(typeof snap.tension, 'number');
  assert.equal(typeof snap.deckDwellMs, 'number');
  assert.equal(snap.recent.length, 20);
  assert.equal(snap.recent[19].category, 'flash');

  assert.doesNotThrow(() => JSON.stringify(snap));
});

test('pruning: entries older than 10 minutes do not contribute to heat', async () => {
  const { VisualState } = await import(modUrl);
  let t = 0;
  const vs = new VisualState(() => t);

  vs.noteAction('strobe');
  t += 11 * 60 * 1000;
  assert.ok(vs.heat('strobe') < 0.001);
});
