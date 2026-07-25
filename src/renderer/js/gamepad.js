// Xbox-style controller support (ROG Ally X built-in gamepad).
// Polls the Gamepad API each frame and drives FX button handles on
// press/release, so controller and touch share identical behavior.
// LT/RT can act as analog triggers: pressed depth maps onto a float param.
import { rogger } from './bridge.js';
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

const ANALOG_TRIGGERS = [['lt', 6], ['rt', 7]];
const STICK_AXES = [['ls', 0, 1], ['rs', 2, 3]];
const STICK_DEADZONE = 0.08;

export function startGamepad(handles) {
  let prev = [];
  const trigState = { lt: { engaged: false, last: null }, rt: { engaged: false, last: null } };
  const stickLast = {};
  let activePad = null;
  let lastRumbleAt = 0;

  // moderate magnitudes — feedback, not a massage chair
  function rumble(strong, weak, ms) {
    const act = activePad?.vibrationActuator;
    if (!act?.playEffect) return;
    act.playEffect('dual-rumble', {
      duration: ms, strongMagnitude: strong, weakMagnitude: weak,
    }).catch(() => {});
  }

  function axisValue(btn) {
    if (btn == null) return 0;
    if (typeof btn === 'object') return btn.value ?? (btn.pressed ? 1 : 0);
    return Number(btn) || 0;
  }

  function tick() {
    requestAnimationFrame(tick);
    const pad = pads().find(p => p && p.buttons?.length);
    if (!pad) { prev = []; activePad = null; return; }
    activePad = pad;
    const haptics = state.get()?.haptics ?? {};
    const tcfg = state.get()?.triggers ?? {};
    const analogIdx = new Set(ANALOG_TRIGGERS.filter(([k]) => tcfg[k]?.enabled).map(([, i]) => i));

    // analog triggers: depth -> value, snap back on release
    for (const [key, idx] of ANALOG_TRIGGERS) {
      const t = tcfg[key];
      if (!t?.enabled) continue;
      const v = Math.min(1, axisValue(pad.buttons[idx]));
      const st = trigState[key];
      const engaged = v > 0.03;
      if (engaged && !st.engaged) {
        st.engaged = true;
        if (t.engageAddress) {
          rogger.sendTyped(t.engageAddress, [{ type: 'i', value: Math.trunc(t.engageValue ?? 1) }]);
        }
      }
      if (engaged && t.analogAddress) {
        const out = t.from + (t.to - t.from) * v;
        if (out !== st.last) {
          st.last = out;
          rogger.sendTyped(t.analogAddress, [{ type: 'f', value: out }]);
        }
      }
      // strobe stomp feedback: depth-scaled pulses while RT is engaged
      if (key === 'rt' && engaged && haptics.enabled && haptics.strobe) {
        const now = performance.now();
        if (now - lastRumbleAt > 130) {
          lastRumbleAt = now;
          rumble(v * 0.7, v * 0.4, 110);
        }
      }
      if (!engaged && st.engaged) {
        st.engaged = false;
        st.last = null;
        if (t.analogAddress) {
          rogger.sendTyped(t.analogAddress, [{ type: 'f', value: t.releaseValue ?? t.from }]);
        }
        if (t.engageAddress) {
          rogger.sendTyped(t.engageAddress, [{ type: 'i', value: Math.trunc(t.engageReleaseValue ?? 0) }]);
        }
      }
    }

    // stick axes: deflection drives a param, spring-back re-centers it
    const scfg = state.get()?.sticks ?? {};
    for (const [key, xi, yi] of STICK_AXES) {
      const s = scfg[key];
      if (!s?.enabled) continue;
      for (const [axIdx, a] of [[xi, s.x], [yi, s.y]]) {
        if (!a?.address) continue;
        let v = pad.axes?.[axIdx] ?? 0;
        if (Math.abs(v) < STICK_DEADZONE) v = 0;
        const id = key + axIdx;
        if (v === 0) {
          if (stickLast[id] !== undefined) {
            rogger.sendTyped(a.address, [{ type: 'f', value: a.center }]);
            stickLast[id] = undefined;
          }
          continue;
        }
        const out = Math.min(1, Math.max(0, a.center + v * a.scale));
        if (out !== stickLast[id]) {
          stickLast[id] = out;
          rogger.sendTyped(a.address, [{ type: 'f', value: out }]);
        }
      }
    }

    const curr = pad.buttons.map(btn =>
      typeof btn === 'object' ? (btn.pressed || btn.value > 0.5) : btn > 0.5);
    for (let bi = 0; bi < curr.length; bi++) {
      if (analogIdx.has(bi)) continue; // analog triggers never act as buttons
      const down = curr[bi];
      if (down === (prev[bi] ?? false)) continue;
      if (down && learnCb) { learnCb(bi); continue; } // learn consumes the press
      const cfgAll = state.get();
      let gi = -1;
      let base = 0;
      for (const kind of ['fxButtons', 'fxButtons2', 'fxButtons3', 'utilButtons']) {
        const arr = cfgAll[kind] ?? [];
        const idx = arr.findIndex(c => c.gamepadButton === bi);
        if (idx !== -1) { gi = base + idx; break; }
        base += arr.length;
      }
      if (gi === -1 || !handles[gi]) continue;
      if (down) {
        handles[gi].press();
        if (haptics.enabled && haptics.press) rumble(0.15, 0.4, 50);
      } else {
        handles[gi].release();
      }
    }
    prev = curr;
  }
  tick();
}
