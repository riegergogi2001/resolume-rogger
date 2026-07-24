// Xbox-style controller support (ROG Ally X built-in gamepad).
// Polls the Gamepad API each frame and drives FX button handles on
// press/release, so controller and touch share identical behavior.
import * as state from './state.js';

// Standard-mapping button indices.
export const BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT',
  'VIEW', 'MENU', 'LS', 'RS', 'D-UP', 'D-DN', 'D-LT', 'D-RT'];

let learnCb = null;
export function armGamepadLearn(cb) { learnCb = cb; }
export function disarmGamepadLearn() { learnCb = null; }

function pads() {
  if (window.__gamepadOverride !== undefined && window.__gamepadOverride !== null) {
    return [window.__gamepadOverride]; // test hook
  }
  return navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
}

export function startGamepad(handles) {
  let prev = [];
  function tick() {
    requestAnimationFrame(tick);
    const pad = pads().find(p => p && p.buttons?.length);
    if (!pad) { prev = []; return; }
    const curr = pad.buttons.map(btn =>
      typeof btn === 'object' ? (btn.pressed || btn.value > 0.5) : btn > 0.5);
    for (let bi = 0; bi < curr.length; bi++) {
      const down = curr[bi];
      if (down === (prev[bi] ?? false)) continue;
      if (down && learnCb) { learnCb(bi); continue; } // learn consumes the press
      const fx = state.get().fxButtons.findIndex(c => c.gamepadButton === bi);
      if (fx === -1 || !handles[fx]) continue;
      if (down) handles[fx].press();
      else handles[fx].release();
    }
    prev = curr;
  }
  tick();
}
