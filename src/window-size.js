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
// The floor is in CSS pixels. Electron sizes windows in device-independent
// pixels, and those are only the panel's pixels at 100% Windows scaling: the
// target device (ASUS ROG Ally X, 7" 1920x1080) ships at 150%, so its whole
// screen is 1280x720 DIP — smaller than the floor. fitZoom() closes that gap:
// the page is zoomed out until the floor fits the display, which on the Ally
// lands within a few percent of 1 CSS px = 1 panel px, i.e. what the layout
// was drawn for. It also covers the 1280x720 panel mode Armoury Crate offers.
const MIN_WIDTH = 1704;
const MIN_HEIGHT = 1035;

// Page zoom that lets the floor fit a display of the given DIP size. 1 when it
// already fits (the surface is never zoomed in); 1 on junk metrics, so a bad
// reading can never blow the layout up or shrink it to nothing.
function fitZoom(displayWidth, displayHeight) {
  if (!Number.isFinite(displayWidth) || !Number.isFinite(displayHeight)) return 1;
  if (displayWidth <= 0 || displayHeight <= 0) return 1;
  const z = Math.min(1, displayWidth / MIN_WIDTH, displayHeight / MIN_HEIGHT);
  // Truncate, don't round: the zoomed floor must never exceed the display.
  return Math.floor(z * 10000) / 10000;
}

// The floor expressed in window DIPs for a given zoom — what minWidth/minHeight
// have to be so the window can still not be squeezed below the surface, yet is
// allowed to exist on the display at all.
function fitFloor(zoom) {
  return {
    minWidth: Math.floor(MIN_WIDTH * zoom),
    minHeight: Math.floor(MIN_HEIGHT * zoom),
  };
}

module.exports = {
  MIN_WIDTH,
  MIN_HEIGHT,
  // What `npm start` opens for development — above the floor, below the Ally X.
  DEV_WIDTH: 1760,
  DEV_HEIGHT: 1040,
  fitZoom,
  fitFloor,
};
