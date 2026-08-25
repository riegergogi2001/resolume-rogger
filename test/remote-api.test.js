'use strict';
// parseRemote is pure — no DOM, no config — so it's tested directly here.
// startRemoteApi (the effectful wiring) is covered by the Playwright UI spec
// (test/ui/editor-settings.spec.mjs), same split as gamepad-resolve.js vs
// gamepad.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(path.join(__dirname, '..', 'src/renderer/js/remote-api.js')).href;

let parseRemote;
test.before(async () => {
  ({ parseRemote } = await import(modUrl));
});

test('/rogger/fx/{page}/{index} with int 1 -> press on the right kind/index', () => {
  assert.deepEqual(parseRemote('/rogger/fx/1/2', [{ type: 'i', value: 1 }]),
    { type: 'fx', kind: 'fxButtons', index: 1, down: true });
  assert.deepEqual(parseRemote('/rogger/fx/2/1', [{ type: 'i', value: 1 }]),
    { type: 'fx', kind: 'fxButtons2', index: 0, down: true });
  assert.deepEqual(parseRemote('/rogger/fx/3/24', [{ type: 'i', value: 1 }]),
    { type: 'fx', kind: 'fxButtons3', index: 23, down: true });
});

test('/rogger/fx/... with int 0 -> release', () => {
  assert.deepEqual(parseRemote('/rogger/fx/1/2', [{ type: 'i', value: 0 }]),
    { type: 'fx', kind: 'fxButtons', index: 1, down: false });
});

test('/rogger/fx/... with no arg -> down: undefined (press + release later)', () => {
  const r = parseRemote('/rogger/fx/1/2', []);
  assert.equal(r.type, 'fx');
  assert.equal(r.kind, 'fxButtons');
  assert.equal(r.index, 1);
  assert.equal(r.down, undefined);
  assert.deepEqual(parseRemote('/rogger/fx/1/2', undefined),
    { type: 'fx', kind: 'fxButtons', index: 1, down: undefined });
});

test('/rogger/fx/... out-of-range int value is ignored', () => {
  assert.equal(parseRemote('/rogger/fx/1/2', [{ type: 'i', value: 2 }]), null);
  assert.equal(parseRemote('/rogger/fx/1/2', [{ type: 'i', value: -1 }]), null);
});

test('/rogger/fx/{page} rejects an out-of-range page and a zero index', () => {
  assert.equal(parseRemote('/rogger/fx/4/1', [{ type: 'i', value: 1 }]), null);
  assert.equal(parseRemote('/rogger/fx/0/1', [{ type: 'i', value: 1 }]), null);
  assert.equal(parseRemote('/rogger/fx/1/0', [{ type: 'i', value: 1 }]), null);
});

test('/rogger/util/{index}', () => {
  assert.deepEqual(parseRemote('/rogger/util/3', [{ type: 'i', value: 1 }]),
    { type: 'fx', kind: 'utilButtons', index: 2, down: true });
  assert.deepEqual(parseRemote('/rogger/util/3', []),
    { type: 'fx', kind: 'utilButtons', index: 2, down: undefined });
});

test('/rogger/fader/{index} f -> fader value', () => {
  assert.deepEqual(parseRemote('/rogger/fader/1', [{ type: 'f', value: 0.5 }]),
    { type: 'fader', kind: 'faders', index: 0, value: 0.5 });
});

test('/rogger/gfader/{index} f -> groupFaders value', () => {
  assert.deepEqual(parseRemote('/rogger/gfader/6', [{ type: 'f', value: 1 }]),
    { type: 'fader', kind: 'groupFaders', index: 5, value: 1 });
});

test('/rogger/fader out-of-range value ignored', () => {
  assert.equal(parseRemote('/rogger/fader/1', [{ type: 'f', value: 1.5 }]), null);
  assert.equal(parseRemote('/rogger/fader/1', [{ type: 'f', value: -0.1 }]), null);
  assert.equal(parseRemote('/rogger/fader/1', []), null);
});

test('/rogger/color/{index}', () => {
  assert.deepEqual(parseRemote('/rogger/color/5', []), { type: 'color', index: 4 });
  assert.equal(parseRemote('/rogger/color/0', []), null);
});

test('/rogger/page {n}', () => {
  assert.deepEqual(parseRemote('/rogger/page', [{ type: 'i', value: 2 }]), { type: 'page', n: 2 });
  assert.equal(parseRemote('/rogger/page', []), null, 'missing arg is ignored');
});

test('/rogger/tap and /rogger/resync take no args', () => {
  assert.deepEqual(parseRemote('/rogger/tap', []), { type: 'tap' });
  assert.deepEqual(parseRemote('/rogger/resync', []), { type: 'resync' });
});

test('unknown /rogger/... address returns null', () => {
  assert.equal(parseRemote('/rogger/nope', [{ type: 'i', value: 1 }]), null);
  assert.equal(parseRemote('/rogger/fx/1', [{ type: 'i', value: 1 }]), null, 'missing index segment');
});

test('addresses outside the /rogger/ namespace are ignored', () => {
  assert.equal(parseRemote('/composition/master', [{ type: 'f', value: 0.5 }]), null);
});

test('bad input never throws', () => {
  assert.equal(parseRemote(null, null), null);
  assert.equal(parseRemote(undefined, undefined), null);
  assert.equal(parseRemote(42, []), null);
  // no usable numeric arg -> same as "no arg" (press + release later), never throws
  assert.doesNotThrow(() => parseRemote('/rogger/fx/1/2', 'not-an-array'));
  assert.equal(parseRemote('/rogger/fader/1', [{ type: 'i', value: 'nope' }]), null);
});

test('NaN and out-of-range page numbers never reach the surface', () => {
  assert.equal(parseRemote('/rogger/fader/1', [{ type: 'f', value: NaN }]), null, 'NaN fader');
  assert.equal(parseRemote('/rogger/gfader/1', [{ type: 'f', value: NaN }]), null, 'NaN group fader');
  assert.equal(parseRemote('/rogger/page', [{ type: 'f', value: NaN }]), null, 'NaN page');
  assert.equal(parseRemote('/rogger/page', [{ type: 'i', value: 0 }]), null, 'page 0 would blank every page');
  assert.equal(parseRemote('/rogger/page', [{ type: 'i', value: -2 }]), null);
  assert.equal(parseRemote('/rogger/page', [{ type: 'f', value: 1.5 }]), null, 'fractional page');
  assert.deepEqual(parseRemote('/rogger/page', [{ type: 'f', value: 2 }]), { type: 'page', n: 2 }, 'a float 2.0 still works');
});
