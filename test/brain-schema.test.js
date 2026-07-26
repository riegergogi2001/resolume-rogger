'use strict';
// The model contract: every reply is validated before it can touch the show.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(
  path.join(__dirname, '..', 'src', 'renderer', 'js', 'director', 'brain-schema.js')).href;

test('parseDecision: valid reply becomes an intent + extras', async () => {
  const { parseDecision } = await import(modUrl);
  const d = parseDecision({
    intent: 'TriggerFlash', confidence: 0.85, impact: 'low', reason: 'drop hit',
    color: { r: 1, g: 0.2, b: 0 }, morph: true, morphSpeed: 0.4,
  });
  assert.equal(d.intent.type, 'TriggerFlash');
  assert.equal(d.intent.confidence, 0.85);
  assert.equal(d.intent.impact, 'low');
  assert.ok(d.intent.reasoning.includes('drop hit'));
  assert.deepEqual(d.extras.color, { r: 1, g: 0.2, b: 0 });
  assert.equal(d.extras.morph, true);
  assert.equal(d.extras.morphSpeed, 0.4);
});

test('parseDecision: unknown intent is rejected outright', async () => {
  const { parseDecision } = await import(modUrl);
  assert.equal(parseDecision({ intent: 'LaunchFireworks', confidence: 1 }), null);
  assert.equal(parseDecision(null), null);
  assert.equal(parseDecision('strobe please'), null);
});

test('parseDecision: values are clamped and defaulted', async () => {
  const { parseDecision } = await import(modUrl);
  const d = parseDecision({ intent: 'TriggerStrobe', confidence: 7, color: { r: 2, g: -1, b: 0.5 } });
  assert.equal(d.intent.confidence, 1);
  assert.equal(d.intent.impact, 'high', 'default impact from intent type');
  assert.deepEqual(d.extras.color, { r: 1, g: 0, b: 0.5 });
  assert.equal(d.extras.morph, null);
  const d2 = parseDecision({ intent: 'HoldCurrentVisual', color: { r: 'red' } });
  assert.equal(d2.extras.color, null, 'non-numeric color dropped');
  assert.equal(d2.intent.confidence, 0.6, 'missing confidence defaults');
  const d3 = parseDecision({ intent: 'HoldCurrentVisual', morphSpeed: null,
    color: { r: null, g: null, b: null }, confidence: '0.75' });
  assert.equal(d3.extras.morphSpeed, null, 'null morphSpeed must not become 0');
  assert.equal(d3.extras.color, null, 'null channels must not become black');
  assert.equal(d3.intent.confidence, 0.75, 'quoted numbers accepted');
});

test('parseLook: verdict shape', async () => {
  const { parseLook } = await import(modUrl);
  const l = parseLook({ looksGood: false, score: 0.2, issues: ['too dark'], suggestion: 'raise master' });
  assert.equal(l.ok, false);
  assert.equal(l.score, 0.2);
  assert.ok(l.notes.includes('too dark') && l.notes.includes('raise master'));
  assert.equal(parseLook({ score: 1 }), null, 'looksGood is required');
});

test('prompts: menu and JSON-only instruction present, state stays compact', async () => {
  const { decisionSystemPrompt, decisionUserPrompt, BRAIN_INTENTS } = await import(modUrl);
  const sys = decisionSystemPrompt();
  for (const intent of BRAIN_INTENTS) assert.ok(sys.includes(intent), `menu lists ${intent}`);
  assert.ok(/ONLY one JSON object/i.test(sys));
  const user = decisionUserPrompt({
    music: { bpm: 128.2, section: 'drop', msInSection: 4200, bar: 33, phrasePos: 0, phraseLen: 16, metrics: { energy: 0.9 } },
    visual: { tension: 0.4, heats: { strobe: 1 }, fatigue: 0.1 },
    roles: ['flash', 'strobe'], lastLook: null, recent: ['TriggerFlash'],
  });
  const parsed = JSON.parse(user);
  assert.equal(parsed.bpm, 128);
  assert.equal(parsed.section, 'drop');
  assert.ok(user.length < 800, `state prompt stays small (${user.length})`);
});
