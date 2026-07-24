// Renderer-side config cache with pub/sub and debounced persistence.
import { rogger } from './bridge.js';

let config = null;
const subs = new Set();
let saveTimer = null;

export async function init() {
  config = await rogger.getConfig();
  return config;
}

export function get() {
  return config;
}

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function notify() {
  for (const fn of subs) fn(config);
}

export function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => rogger.saveConfig(config), 300);
}

// kind: 'fxButtons' | 'faders' | 'colorButtons'
export function replaceControl(kind, index, next) {
  config[kind][index] = next;
  notify();
  persist();
}

export function updateNetwork(patch) {
  Object.assign(config.network, patch);
  notify();
  persist();
}

// Replace the whole config (already persisted by the main process).
export function setAll(next) {
  config = next;
  notify();
}
