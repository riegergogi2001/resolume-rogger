'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePayload, markHealthy, compareVersions, isValidVersion, normaliseState,
} = require('../src/payload-resolve.js');

const BUNDLED = '2.0.0';
const fresh = { active: null, attempts: 0, quarantine: [], lastCheck: 0 };

test('compareVersions orders releases and prereleases', () => {
  assert.ok(compareVersions('2.1.0', '2.0.9') > 0);
  assert.ok(compareVersions('2.0.0', '2.0.1') < 0);
  assert.ok(compareVersions('10.0.0', '9.9.9') > 0, 'numeric, not lexicographic');
  assert.equal(compareVersions('2.0.0', 'v2.0.0'), 0, 'a leading v is ignored');
  assert.ok(compareVersions('2.1.0', '2.1.0-rc.1') > 0, 'release beats its prerelease');
  assert.ok(compareVersions('2.1.0-rc.2', '2.1.0-rc.1') > 0);
  assert.equal(compareVersions('nonsense', '2.0.0'), 0, 'unparseable never wins');
});

test('isValidVersion accepts our tags and rejects junk', () => {
  for (const ok of ['2.0.0', 'v2.0.0', '2.10.3-rc.1']) assert.ok(isValidVersion(ok), ok);
  for (const bad of ['2.0', 'latest', '', null, undefined, '2.0.0.1', '../2.0.0']) {
    assert.equal(isValidVersion(bad), false, String(bad));
  }
});

test('no installed payloads -> the bundled tree boots', () => {
  const r = resolvePayload({ bundledVersion: BUNDLED, installed: [], state: fresh });
  assert.equal(r.source, 'bundled');
  assert.equal(r.version, BUNDLED);
  assert.equal(r.dir, null);
  assert.equal(r.state.attempts, 0);
});

test('a newer payload wins and its first attempt is counted', () => {
  const r = resolvePayload({
    bundledVersion: BUNDLED,
    installed: [{ version: '2.1.0', dir: '/p/2.1.0' }],
    state: fresh,
  });
  assert.equal(r.source, 'ota');
  assert.equal(r.version, '2.1.0');
  assert.equal(r.dir, '/p/2.1.0');
  assert.equal(r.state.active, '2.1.0');
  assert.equal(r.state.attempts, 1, 'the bootstrap counts this boot before loading');
});

test('the highest version wins, not the most recently written', () => {
  const r = resolvePayload({
    bundledVersion: BUNDLED,
    installed: [
      { version: '2.1.0', dir: '/p/2.1.0' },
      { version: '2.10.0', dir: '/p/2.10.0' },
      { version: '2.2.0', dir: '/p/2.2.0' },
    ],
    state: fresh,
  });
  assert.equal(r.version, '2.10.0');
});

test('a payload at or below the bundled version is ignored', () => {
  const r = resolvePayload({
    bundledVersion: BUNDLED,
    installed: [{ version: '1.18.0', dir: '/p/1.18.0' }, { version: '2.0.0', dir: '/p/2.0.0' }],
    state: fresh,
  });
  assert.equal(r.source, 'bundled', 'a fresher exe supersedes stale OTA payloads');
});

test('a payload that never came up healthy is quarantined on the third try', () => {
  const installed = [{ version: '2.1.0', dir: '/p/2.1.0' }];

  const first = resolvePayload({ bundledVersion: BUNDLED, installed, state: fresh });
  assert.equal(first.state.attempts, 1);

  // it crashed: attempts was never zeroed
  const second = resolvePayload({ bundledVersion: BUNDLED, installed, state: first.state });
  assert.equal(second.source, 'ota', 'one crash still earns a retry');
  assert.equal(second.state.attempts, 2);

  const third = resolvePayload({ bundledVersion: BUNDLED, installed, state: second.state });
  assert.equal(third.source, 'bundled', 'two failed boots and it is out');
  assert.deepEqual(third.quarantined, ['2.1.0']);
  assert.ok(third.state.quarantine.includes('2.1.0'));
  assert.equal(third.state.active, null);
});

test('quarantine falls back to the next best payload, not straight to bundled', () => {
  const installed = [
    { version: '2.1.0', dir: '/p/2.1.0' },
    { version: '2.2.0', dir: '/p/2.2.0' },
  ];
  let state = fresh;
  state = resolvePayload({ bundledVersion: BUNDLED, installed, state }).state; // 2.2.0, attempt 1
  state = resolvePayload({ bundledVersion: BUNDLED, installed, state }).state; // 2.2.0, attempt 2
  const r = resolvePayload({ bundledVersion: BUNDLED, installed, state });
  assert.equal(r.source, 'ota');
  assert.equal(r.version, '2.1.0', 'drop to the previous payload before the bundled one');
  assert.deepEqual(r.quarantined, ['2.2.0']);
});

test('every payload quarantined -> bundled', () => {
  const installed = [{ version: '2.1.0', dir: '/p/2.1.0' }];
  const r = resolvePayload({
    bundledVersion: BUNDLED,
    installed,
    state: { ...fresh, quarantine: ['2.1.0'] },
  });
  assert.equal(r.source, 'bundled');
});

test('a healthy boot resets the counter, so later boots never age out', () => {
  const installed = [{ version: '2.1.0', dir: '/p/2.1.0' }];
  let state = resolvePayload({ bundledVersion: BUNDLED, installed, state: fresh }).state;
  for (let i = 0; i < 20; i += 1) {
    state = markHealthy(state);
    const r = resolvePayload({ bundledVersion: BUNDLED, installed, state });
    assert.equal(r.source, 'ota', `boot ${i} still runs the payload`);
    assert.equal(r.state.attempts, 1);
    state = r.state;
  }
});

test('safe mode forces the bundled tree and clears the attempt counter', () => {
  const r = resolvePayload({
    bundledVersion: BUNDLED,
    installed: [{ version: '2.1.0', dir: '/p/2.1.0' }],
    state: { active: '2.1.0', attempts: 1, quarantine: [] },
    safeMode: true,
  });
  assert.equal(r.source, 'bundled');
  assert.equal(r.state.active, null);
  assert.equal(r.state.attempts, 0);
  assert.deepEqual(r.state.quarantine, [], 'safe mode must not blacklist a payload');
});

test('malformed payload entries and state cannot crash the resolver', () => {
  const r = resolvePayload({
    bundledVersion: BUNDLED,
    installed: [
      null, {}, { version: 'latest', dir: '/p/latest' }, { version: '2.1.0' },
      { version: '2.1.0', dir: '/p/2.1.0' },
    ],
    state: { active: 42, attempts: -3, quarantine: 'nope' },
  });
  assert.equal(r.source, 'ota');
  assert.equal(r.version, '2.1.0');
  assert.equal(r.state.attempts, 1);
});

test('normaliseState scrubs anything a hand-edited state file might contain', () => {
  const s = normaliseState({ active: '../evil', attempts: 'x', quarantine: [1, '2.1.0'], lastCheck: 'soon' });
  assert.deepEqual(s, { active: null, attempts: 0, quarantine: ['2.1.0'], lastCheck: 0 });
  assert.deepEqual(normaliseState(undefined), { active: null, attempts: 0, quarantine: [], lastCheck: 0 });
});
