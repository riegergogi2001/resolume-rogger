'use strict';
// The smallest window the performance surface fits in without anything
// shrinking, wrapping or being cut off.
//
// Nothing on the surface adapts: every control keeps one size, one font and
// one set of decoration at every window size, because a button that renames,
// shrinks or drops its glyph under your thumb mid-show is worse than one that
// needs a bigger window. The cost of that choice is a hard floor on the window
// size, and this is it.
//
// Measured with tools/measure-min-window.js and asserted by
// test/ui/min-window.spec.mjs, so a longer label cannot quietly break the
// layout: if the natural minimum grows past these numbers, that test fails and
// the numbers get raised on purpose.
//
// For reference, the target device (ASUS ROG Ally X) is 1920x1080.
module.exports = {
  MIN_WIDTH: 1704,
  MIN_HEIGHT: 1035,
  // What `npm start` opens for development — above the floor, below the Ally X.
  DEV_WIDTH: 1760,
  DEV_HEIGHT: 1040,
};
