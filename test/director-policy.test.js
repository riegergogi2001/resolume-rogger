'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let policy;
before(async () => {
  policy = await import(
    pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'js', 'director', 'policy.js')).href
  );
});

function baseMusic(overrides = {}) {
  return {
    bpm: 128,
    confidence: 0.9,
    beatInBar: 1,
    bar: 40,
    phrasePos: 4,
    phraseLen: 16,
    section: 'sustain',
    msInSection: 5000,
    lastEvent: null,
    metrics: { energy: 0.5, tension: 0.5, bass: 0.5, density: 0.5, vocal: 0.2 },
    prediction: null,
    ...overrides,
  };
}

function fakeVisual(overrides = {}) {
  return {
    heat: () => 0,
    cost: () => 0,
    deckDwellMs: () => 0,
    fatigue: () => 0,
    tension: 0,
    ...overrides,
  };
}

function fakeShow(overrides = {}) {
  return { hasRole: () => true, ...overrides };
}

test('drop with cheap flash triggers TriggerFlash at high impact', () => {
  const music = baseMusic({ lastEvent: 'drop', section: 'drop' });
  const visual = fakeVisual({ cost: (cat) => (cat === 'flash' ? 0.2 : 0.9) });
  const intent = policy.decide(music, visual, fakeShow());
  assert.equal(intent.type, 'TriggerFlash');
  assert.equal(intent.impact, 'high');
  assert.ok(intent.confidence > 0.5);
});

test('drop with expensive flash and impact falls back to IncreaseEnergy', () => {
  const music = baseMusic({ lastEvent: 'drop' });
  const visual = fakeVisual({ cost: () => 0.95 });
  const intent = policy.decide(music, visual, fakeShow());
  assert.equal(intent.type, 'IncreaseEnergy');
});

test('drop with no flash/impact roles falls back to IncreaseEnergy', () => {
  const music = baseMusic({ lastEvent: 'drop' });
  const visual = fakeVisual({ cost: () => 0.1 });
  const show = fakeShow({ hasRole: () => false });
  const intent = policy.decide(music, visual, show);
  assert.equal(intent.type, 'IncreaseEnergy');
});

test('fakebuild event holds rather than firing', () => {
  const music = baseMusic({ lastEvent: 'fakebuild', section: 'build' });
  const intent = policy.decide(music, fakeVisual(), fakeShow());
  assert.equal(intent.type, 'HoldCurrentVisual');
  assert.match(intent.reasoning, /fakebuild|tension/i);
});

test('breakdown event reduces density at medium impact', () => {
  const music = baseMusic({ lastEvent: 'breakdown', section: 'breakdown' });
  const intent = policy.decide(music, fakeVisual(), fakeShow());
  assert.equal(intent.type, 'ReduceDensity');
  assert.equal(intent.impact, 'medium');
});

test('imminent high-confidence drop prediction suppresses strobe even in a hot build', () => {
  const music = baseMusic({
    section: 'build',
    phrasePos: 14,
    phraseLen: 16,
    metrics: { energy: 0.8, tension: 0.9, bass: 0.7, density: 0.6, vocal: 0.1 },
    prediction: { event: 'drop', beatsUntil: 4, confidence: 0.8 },
  });
  const visual = fakeVisual({
    cost: () => 0.1,
    heat: (cat) => (cat === 'transition' ? 0.05 : 0),
  });
  const intent = policy.decide(music, visual, fakeShow());
  assert.notEqual(intent.type, 'TriggerStrobe');
  assert.notEqual(intent.type, 'TriggerImpactFX');
  assert.equal(intent.type, 'PrepareNextClip');
});

test('imminent drop prediction with a hot transition holds instead of preparing again', () => {
  const music = baseMusic({
    section: 'build',
    phrasePos: 14,
    phraseLen: 16,
    metrics: { energy: 0.8, tension: 0.9, bass: 0.7, density: 0.6, vocal: 0.1 },
    prediction: { event: 'drop', beatsUntil: 2, confidence: 0.7 },
  });
  const visual = fakeVisual({ heat: (cat) => (cat === 'transition' ? 0.5 : 0) });
  const intent = policy.decide(music, visual, fakeShow());
  assert.equal(intent.type, 'HoldCurrentVisual');
  assert.match(intent.reasoning, /predicted drop/i);
});

test('build at phrase end with hot tension and cheap strobe triggers TriggerStrobe', () => {
  const music = baseMusic({
    section: 'build',
    phrasePos: 14,
    phraseLen: 16,
    metrics: { energy: 0.8, tension: 0.75, bass: 0.6, density: 0.6, vocal: 0.1 },
    prediction: null,
  });
  const visual = fakeVisual({ cost: (cat) => (cat === 'strobe' ? 0.2 : 0.9) });
  const intent = policy.decide(music, visual, fakeShow());
  assert.equal(intent.type, 'TriggerStrobe');
  assert.equal(intent.impact, 'high');
});

test('build early in phrase with visuals lagging music increases energy', () => {
  const music = baseMusic({
    section: 'build',
    phrasePos: 2,
    phraseLen: 16,
    metrics: { energy: 0.6, tension: 0.5, bass: 0.5, density: 0.4, vocal: 0.1 },
  });
  const visual = fakeVisual({ tension: 0.1 });
  const intent = policy.decide(music, visual, fakeShow());
  assert.equal(intent.type, 'IncreaseEnergy');
});

test('build with visuals already tracking tension lets it breathe', () => {
  const music = baseMusic({
    section: 'build',
    phrasePos: 2,
    phraseLen: 16,
    metrics: { energy: 0.5, tension: 0.5, bass: 0.5, density: 0.4, vocal: 0.1 },
  });
  const visual = fakeVisual({ tension: 0.45 });
  const intent = policy.decide(music, visual, fakeShow());
  assert.equal(intent.type, 'HoldCurrentVisual');
});

test('long breakdown vocal moment with cheap camerafx triggers TriggerCameraFX', () => {
  const music = baseMusic({
    section: 'breakdown',
    msInSection: 12000,
    metrics: { energy: 0.2, tension: 0.2, bass: 0.1, density: 0.2, vocal: 0.8 },
  });
  const visual = fakeVisual({ cost: () => 0.1 });
  const intent = policy.decide(music, visual, fakeShow());
  assert.equal(intent.type, 'TriggerCameraFX');
});

test('long deck dwell at phrase start switches decks', () => {
  const music = baseMusic({ section: 'sustain', phrasePos: 0, phraseLen: 16 });
  const visual = fakeVisual({ deckDwellMs: () => 9 * 60 * 1000 });
  const intent = policy.decide(music, visual, fakeShow());
  assert.equal(intent.type, 'SwitchDeck');
});

test('fresh long phrase with stale clip heat prepares a transition', () => {
  const music = baseMusic({ section: 'sustain', phrasePos: 0, phraseLen: 32 });
  const visual = fakeVisual({ deckDwellMs: () => 60 * 1000, heat: (cat) => (cat === 'clip' ? 0.05 : 0) });
  const intent = policy.decide(music, visual, fakeShow());
  assert.equal(intent.type, 'PrepareTransition');
});

test('sustain with high audience fatigue reduces density', () => {
  const music = baseMusic({ section: 'sustain', phrasePos: 3, phraseLen: 16 });
  const visual = fakeVisual({ fatigue: () => 0.9 });
  const intent = policy.decide(music, visual, fakeShow());
  assert.equal(intent.type, 'ReduceDensity');
});

test('low confidence music holds', () => {
  const music = baseMusic({ confidence: 0.1 });
  const intent = policy.decide(music, fakeVisual(), fakeShow());
  assert.equal(intent.type, 'HoldCurrentVisual');
  assert.ok(intent.confidence <= 0.3);
});

test('missing bpm holds', () => {
  const music = baseMusic({ bpm: undefined });
  const intent = policy.decide(music, fakeVisual(), fakeShow());
  assert.equal(intent.type, 'HoldCurrentVisual');
});

test('null music holds', () => {
  const intent = policy.decide(null, fakeVisual(), fakeShow());
  assert.equal(intent.type, 'HoldCurrentVisual');
});

test('default idle section with nothing actionable holds', () => {
  const music = baseMusic({ section: 'idle' });
  const intent = policy.decide(music, fakeVisual(), fakeShow());
  assert.equal(intent.type, 'HoldCurrentVisual');
  assert.match(intent.reasoning, /nothing musically actionable/i);
});

test('fatigue discounts confidence of non-hold intents but never below 0.1', () => {
  const music = baseMusic({ lastEvent: 'breakdown', section: 'breakdown' });
  const calmVisual = fakeVisual({ fatigue: () => 0 });
  const tiredVisual = fakeVisual({ fatigue: () => 1 });
  const calm = policy.decide(music, calmVisual, fakeShow());
  const tired = policy.decide(music, tiredVisual, fakeShow());
  assert.ok(tired.confidence < calm.confidence);
  assert.ok(tired.confidence >= 0.1);
});

test('every decision across a spread of scenarios has a well-formed shape', () => {
  const scenarios = [
    baseMusic({ lastEvent: 'drop', section: 'drop' }),
    baseMusic({ lastEvent: 'fakebuild', section: 'build' }),
    baseMusic({ lastEvent: 'breakdown', section: 'breakdown' }),
    baseMusic({ section: 'build', phrasePos: 15, phraseLen: 16, metrics: { energy: 0.9, tension: 0.9, bass: 0.8, density: 0.7, vocal: 0.2 } }),
    baseMusic({ section: 'breakdown', msInSection: 20000, metrics: { energy: 0.1, tension: 0.1, bass: 0.1, density: 0.1, vocal: 0.9 } }),
    baseMusic({ section: 'sustain', phrasePos: 0, phraseLen: 32 }),
    baseMusic({ section: 'idle' }),
    baseMusic({ confidence: 0.05 }),
    baseMusic({ bpm: 0 }),
    baseMusic({
      section: 'build',
      prediction: { event: 'drop', beatsUntil: 1, confidence: 0.9 },
    }),
    null,
    baseMusic({ metrics: undefined, prediction: undefined, lastEvent: undefined }),
  ];
  for (const music of scenarios) {
    const intent = policy.decide(music, fakeVisual(), fakeShow());
    assert.ok(policy.INTENTS.includes(intent.type), `${intent.type} should be a known intent`);
    assert.equal(typeof intent.confidence, 'number');
    assert.ok(intent.confidence >= 0 && intent.confidence <= 1, 'confidence is within [0,1]');
    assert.equal(typeof intent.reasoning, 'string');
    assert.ok(intent.reasoning.length > 0, 'reasoning is a non-empty string');
    assert.ok(['none', 'low', 'medium', 'high'].includes(intent.impact), 'impact is a known level');
  }
});
