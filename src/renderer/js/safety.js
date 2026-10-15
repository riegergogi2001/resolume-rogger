// Safety switches and panic for the DMX (sACN) buttons. A safety is a DMX
// channel of its own (the machine's arm channel): SAFE value at launch, on
// disarm, on panic and on quit; ARMED value while armed. An sACN button that
// names a safety (btn.sacn.safety) cannot fire while that safety is SAFE, and
// disarming forces it back to its default at once.
// Armed state lives only in memory: every launch starts SAFE.
import { sacnAddress, sendDefault } from './sacn-button.js';

const FX_KINDS = ['fxButtons', 'fxButtons2', 'fxButtons3', 'utilButtons'];
const armed = new Set();
const listeners = new Set();
const forceOffs = new Map(); // button key -> () => void, registered by fx-grid

export function safetyAddress(s, universe = s.universe, channel = s.channel) {
  return sacnAddress({ universe, channel, defaultValue: s.safeValue, host: s.host, iface: s.iface, priority: s.priority });
}

// Every arm channel of a safety bank: the main one plus each valid "u/ch" in extra.
export function safetyChannels(s) {
  const out = [[Number(s.universe), Number(s.channel)]];
  for (const line of s.extra ?? []) {
    const m = /^\s*(\d+)\s*[/.:]\s*(\d+)\s*$/.exec(String(line));
    if (m && Number(m[1]) >= 1 && Number(m[2]) >= 1 && Number(m[2]) <= 512) out.push([Number(m[1]), Number(m[2])]);
  }
  return out;
}

export function newSafety(existing = []) {
  let n = existing.length + 1;
  while (existing.some(s => s.label === `SAFETY ${n}`)) n += 1;
  return {
    id: `safety-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    label: `SAFETY ${n}`,
    universe: 1, channel: 1, armedValue: 255, safeValue: 0,
    priority: 100, extra: [], host: '', iface: '', mode: 'toggle',
    twoHand: false, armHoldMs: 1000,
    gamepadButton: -1, gamepadModifier: -1,
  };
}

// sACN preview mode (memory only, every launch LIVE): packets carry the
// Preview_Data flag, so visualisers show them and fixtures ignore them.
let preview = false;
export const previewOn = () => preview;
export async function setPreview(on, rogger) {
  preview = !!(await rogger.dmxSetPreview?.(!!on) ?? on);
  notify();
  return preview;
}

export const isArmed = id => armed.has(id);
export const armedIds = () => [...armed];
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const notify = () => { for (const fn of listeners) fn(); };

// fx-grid registers one per sACN-capable button; called on disarm / panic.
export function registerForceOff(key, fn) { forceOffs.set(key, fn); return () => forceOffs.delete(key); }

function buttons(cfg) {
  const out = [];
  for (const k of FX_KINDS) (cfg[k] ?? []).forEach((b, i) => out.push({ key: `${k}:${i}`, b }));
  return out;
}

// True when a press of this button must be refused.
export function blocked(btn) {
  return btn?.output === 'sacn' && !!btn.sacn?.safety && !armed.has(btn.sacn.safety);
}

function send(s, on, rogger) {
  for (const [u, ch] of safetyChannels(s)) {
    rogger.sendTyped(safetyAddress(s, u, ch), [{ type: 'i', value: on ? s.armedValue : s.safeValue }]);
  }
}

export function setArmed(id, on, cfg, rogger) {
  const s = (cfg.safeties ?? []).find(x => x.id === id);
  if (!s) return;
  if (on) armed.add(id); else armed.delete(id);
  send(s, on, rogger);
  if (!on) {
    for (const { key, b } of buttons(cfg)) {
      if (b.output === 'sacn' && b.sacn?.safety === id) {
        forceOffs.get(key)?.();
        sendDefault(b, rogger);
      }
    }
  }
  notify();
}

// Two-hand check at the moment of arming: both bound pad buttons still down.
export function bothHeld(s, pads = globalThis.navigator?.getGamepads?.() ?? []) {
  for (const gp of pads) {
    if (gp?.buttons?.[s.gamepadButton]?.pressed && gp.buttons[s.gamepadModifier]?.pressed) return true;
  }
  return false;
}

export function toggle(id, cfg, rogger) { setArmed(id, !armed.has(id), cfg, rogger); }

// Everything SAFE and every sACN button back to its default.
export function panic(cfg, rogger) {
  armed.clear();
  for (const s of cfg.safeties ?? []) send(s, false, rogger);
  for (const { key, b } of buttons(cfg)) {
    if (b.output !== 'sacn') continue;
    forceOffs.get(key)?.();
    sendDefault(b, rogger);
  }
  notify();
}

// Every DMX address the config uses (buttons + every channel of every safety),
// so the main process can close streams nothing needs any more.
export function activeAddresses(cfg) {
  const out = [];
  for (const { b } of buttons(cfg)) if (b.output === 'sacn' && b.address) out.push(b.address);
  for (const s of cfg.safeties ?? []) for (const [u, ch] of safetyChannels(s)) out.push(safetyAddress(s, u, ch));
  return out;
}

// Launch: every safety SAFE (armed set is empty after a restart anyway).
export function sendAllSafe(cfg, rogger) {
  for (const s of cfg.safeties ?? []) send(s, false, rogger);
}

// Before a safety is edited or deleted: disarm it on its OLD channel.
export function retire(id, cfg, rogger) {
  if (armed.has(id)) setArmed(id, false, cfg, rogger);
  else { const s = (cfg.safeties ?? []).find(x => x.id === id); if (s) send(s, false, rogger); }
}
