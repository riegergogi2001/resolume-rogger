'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MIN_WIDTH, MIN_HEIGHT, fitZoom, fitFloor } = require('../src/window-size.js');

test('fitZoom is 1 when the display holds the floor (Ally X at 100% scaling)', () => {
  assert.equal(fitZoom(1920, 1080), 1);
  assert.equal(fitZoom(MIN_WIDTH, MIN_HEIGHT), 1, 'exactly the floor still fits');
  assert.equal(fitZoom(3840, 2160), 1, 'never zooms in on a big display');
});

test('fitZoom shrinks the surface to the tighter axis when the display is smaller', () => {
  // Ally X at the Windows default 150% scaling: 1920x1080 reports as 1280x720 DIP.
  const z = fitZoom(1280, 720);
  assert.ok(z < 1);
  assert.ok(Math.abs(z - 720 / MIN_HEIGHT) < 1e-4, 'height is the binding axis');
  assert.ok(MIN_WIDTH * z <= 1280 + 0.5 && MIN_HEIGHT * z <= 720 + 0.5, 'the floor fits after zoom');
  // 125% scaling: 1536x864 DIP.
  const z125 = fitZoom(1536, 864);
  assert.ok(Math.abs(z125 - 864 / MIN_HEIGHT) < 1e-4);
  // Width can also be the binding axis.
  const zw = fitZoom(1000, 2000);
  assert.ok(Math.abs(zw - 1000 / MIN_WIDTH) < 1e-4);
});

test('fitZoom falls back to 1 on junk display metrics', () => {
  for (const [w, h] of [[0, 0], [-1, 720], [NaN, 720], [undefined, undefined], ['1280', 720]]) {
    assert.equal(fitZoom(w, h), 1, `${w}x${h}`);
  }
});

test('fitFloor is the declared floor scaled by the zoom, never above the display', () => {
  assert.deepEqual(fitFloor(1), { minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT });
  const z = fitZoom(1280, 720);
  const f = fitFloor(z);
  assert.ok(f.minWidth <= 1280 && f.minHeight <= 720, `${f.minWidth}x${f.minHeight} must fit 1280x720`);
  assert.ok(Number.isInteger(f.minWidth) && Number.isInteger(f.minHeight), 'window bounds are whole DIPs');
});
