'use strict';
// Resolume never echoes a colour back (verified twice against Arena 7.26 with
// its OSC output on), so the surface remembers what it last sent per target
// and lights the matching preset from that. This is the store behind it.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modUrl = pathToFileURL(path.join(__dirname, '..', 'src/renderer/js/color-memory.js')).href;

let mem;
test.before(async () => { mem = await import(modUrl); });
beforeEach(() => { if (mem) mem.reset(); });

test('a target starts with nothing remembered', () => {
  assert.equal(mem.getColor('bg'), null);
});

test('remembers a colour per target, independently', () => {
  mem.setColor('bg', [1, 0, 0]);
  mem.setColor('logo', [0, 0, 1]);
  assert.deepEqual(mem.getColor('bg'), [1, 0, 0]);
  assert.deepEqual(mem.getColor('logo'), [0, 0, 1]);
  assert.equal(mem.getColor('flash'), null, 'an untouched target stays empty');
});

test('the last colour on a target wins', () => {
  mem.setColor('bg', [1, 0, 0]);
  mem.setColor('bg', [0, 1, 0]);
  assert.deepEqual(mem.getColor('bg'), [0, 1, 0]);
});

test('clearing forgets one target and leaves the others', () => {
  mem.setColor('bg', [1, 0, 0]);
  mem.setColor('logo', [0, 0, 1]);
  mem.clearColor('bg');
  assert.equal(mem.getColor('bg'), null);
  assert.deepEqual(mem.getColor('logo'), [0, 0, 1]);
});

test('subscribers hear real changes and nothing else', () => {
  const seen = [];
  const off = mem.subscribe((id, rgb) => seen.push([id, rgb]));
  mem.setColor('bg', [1, 0, 0]);
  mem.setColor('bg', [1, 0, 0]);          // same colour again
  mem.setColor('bg', [0, 1, 0]);
  mem.clearColor('bg');
  mem.clearColor('bg');                   // already gone
  off();
  mem.setColor('bg', [0, 0, 1]);          // after unsubscribing
  assert.deepEqual(seen, [
    ['bg', [1, 0, 0]],
    ['bg', [0, 1, 0]],
    ['bg', null],
  ]);
});

test('junk is ignored rather than remembered', () => {
  for (const bad of [null, undefined, [1, 0], 'red', [1, 0, NaN], [1, 0, 'x']]) {
    mem.setColor('bg', bad);
    assert.equal(mem.getColor('bg'), null, JSON.stringify(bad));
  }
  mem.setColor('', [1, 0, 0]);
  assert.equal(mem.getColor(''), null, 'a target needs an id');
});

test('extra channels past rgb are dropped', () => {
  mem.setColor('bg', [1, 0, 0, 0.5]);
  assert.deepEqual(mem.getColor('bg'), [1, 0, 0]);
});
