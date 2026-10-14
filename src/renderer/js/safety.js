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

export function safetyAddress(s) {
  return sacnAddress({ universe: s.universe, channel: s.channel, defaultValue: s.safeValue, host: s.host, iface: s.iface });
}

export function newSafety(existing = []) {
  let n = existing.length + 1;
  while (existing.some(s => s.label === `SAFETY ${n}`)) n += 1;
  return {
    id: `safety-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    label: `SAFETY ${n}`,
    universe: 1, channel: 1, armedValue: 255, safeValue: 0,
    host: '', iface: '', mode: 'toggle',
    gamepadButton: -1, gamepadModifier: -1,
  };
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
  rogger.sendTyped(safetyAddress(s), [{ type: 'i', value: on ? s.armedValue : s.safeValue }]);
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

// Launch: every safety SAFE (armed set is empty after a restart anyway).
export function sendAllSafe(cfg, rogger) {
  for (const s of cfg.safeties ?? []) send(s, false, rogger);
}

// Before a safety is edited or deleted: disarm it on its OLD channel.
export function retire(id, cfg, rogger) {
  if (armed.has(id)) setArmed(id, false, cfg, rogger);
  else { const s = (cfg.safeties ?? []).find(x => x.id === id); if (s) send(s, false, rogger); }
}
