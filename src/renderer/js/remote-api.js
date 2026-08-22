// Inbound OSC API: lets other gear (a Companion install, grandMA3 OSC out,
// another ROGGER, ...) press this instance's own buttons/faders by sending
// OSC to its listen port. `parseRemote` is pure (no DOM, no state, no
// imports beyond nothing) so it's unit-testable straight from node:test;
// `startRemoteApi` is the thin, effectful wiring that drives the same
// handles the touch UI and gamepad already use — nothing here ever sends a
// reply back to the caller.
import * as state from './state.js';
import { HANDLE_KINDS } from './gamepad-resolve.js';
import { rogger } from './bridge.js';

const FX_KIND_BY_PAGE = { 1: 'fxButtons', 2: 'fxButtons2', 3: 'fxButtons3' };

function firstNumericArg(args) {
  const a = args?.[0];
  return a && typeof a.value === 'number' ? a.value : undefined;
}

// address/args -> a small typed intent, or null if not a recognized/valid
// /rogger/... message. Never throws on malformed input.
export function parseRemote(address, args) {
  if (typeof address !== 'string' || !address.startsWith('/rogger/')) return null;
  let m;

  if ((m = /^\/rogger\/fx\/([1-3])\/(\d+)$/.exec(address))) {
    const index = Number(m[2]) - 1;
    if (!(index >= 0)) return null;
    const kind = FX_KIND_BY_PAGE[Number(m[1])];
    const v = firstNumericArg(args);
    if (v === undefined) return { type: 'fx', kind, index, down: undefined }; // press + release 120ms later
    if (v !== 0 && v !== 1) return null; // out of range
    return { type: 'fx', kind, index, down: v === 1 };
  }

  if ((m = /^\/rogger\/util\/(\d+)$/.exec(address))) {
    const index = Number(m[1]) - 1;
    if (!(index >= 0)) return null;
    const v = firstNumericArg(args);
    if (v === undefined) return { type: 'fx', kind: 'utilButtons', index, down: undefined };
    if (v !== 0 && v !== 1) return null;
    return { type: 'fx', kind: 'utilButtons', index, down: v === 1 };
  }

  if ((m = /^\/rogger\/fader\/(\d+)$/.exec(address))) {
    const index = Number(m[1]) - 1;
    if (!(index >= 0)) return null;
    const v = firstNumericArg(args);
    if (typeof v !== 'number' || v < 0 || v > 1) return null;
    return { type: 'fader', kind: 'faders', index, value: v };
  }

  if ((m = /^\/rogger\/gfader\/(\d+)$/.exec(address))) {
    const index = Number(m[1]) - 1;
    if (!(index >= 0)) return null;
    const v = firstNumericArg(args);
    if (typeof v !== 'number' || v < 0 || v > 1) return null;
    return { type: 'fader', kind: 'groupFaders', index, value: v };
  }

  if ((m = /^\/rogger\/color\/(\d+)$/.exec(address))) {
    const index = Number(m[1]) - 1;
    if (!(index >= 0)) return null;
    return { type: 'color', index };
  }

  if (address === '/rogger/page') {
    const v = firstNumericArg(args);
    if (typeof v !== 'number') return null;
    return { type: 'page', n: v };
  }

  if (address === '/rogger/tap') return { type: 'tap' };
  if (address === '/rogger/resync') return { type: 'resync' };

  return null;
}

// fxHandles is a flat array indexed by HANDLE_KINDS order (see fx-grid.js);
// map a (kind, index) pair back to that flat offset the same way fx-grid
// builds it.
function fxHandleIndex(kind, index) {
  let base = 0;
  for (const k of HANDLE_KINDS) {
    if (k === kind) return base + index;
    base += (state.get()?.[k] ?? []).length;
  }
  return -1;
}

export function startRemoteApi({ fxHandles, faderHandles, colorHandles, setPage, tap, resync }) {
  return rogger.onMessage(msg => {
    const parsed = parseRemote(msg.address, msg.args);
    if (!parsed) return;
    switch (parsed.type) {
      case 'fx': {
        const handle = fxHandles?.[fxHandleIndex(parsed.kind, parsed.index)];
        if (!handle) return;
        if (parsed.down === undefined) {
          handle.press();
          setTimeout(() => handle.release(), 120);
        } else if (parsed.down) {
          handle.press();
        } else {
          handle.release();
        }
        break;
      }
      case 'fader': {
        const arr = parsed.kind === 'groupFaders' ? faderHandles?.groupFaders : faderHandles?.faders;
        arr?.[parsed.index]?.set(parsed.value);
        break;
      }
      case 'color':
        colorHandles?.[parsed.index]?.press();
        break;
      case 'page':
        setPage?.(parsed.n - 1);
        break;
      case 'tap':
        tap?.();
        break;
      case 'resync':
        resync?.();
        break;
      default:
        break;
    }
  });
}
