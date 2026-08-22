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

// One color target item (config.colorTargets.items[index]) — label, swatch,
// colorBases, onSteps/offSteps. Editor-driven, same shape as replaceControl.
export function replaceColorTarget(index, next) {
  config.colorTargets.items[index] = next;
  notify();
  persist();
}

export function updateNetwork(patch) {
  Object.assign(config.network, patch);
  notify();
  persist();
}

// Shallow-replace a top-level config section (triggers / sticks / haptics /
// ui / ...) — used by Settings tabs that edit a whole nested object at once.
export function updateSection(name, patch) {
  config[name] = { ...config[name], ...patch };
  notify();
  persist();
}

// Replace the whole config (already persisted by the main process).
export function setAll(next) {
  config = next;
  notify();
}

export function setColorTarget(id) {
  if (config.colorTargets) config.colorTargets.active = id;
  notify();
  persist();
}

// Full-surface re-render hook. state.js has no DOM knowledge itself, so
// app.js registers its boot-time renderer here at startup; anything that
// changes something a plain state.subscribe() can't reflect in place
// (fader orientation, hidden pages, an imported config) calls this instead
// of reaching into app.js directly (which would create an import cycle).
let rerenderHandler = null;
export function setRerenderHandler(fn) { rerenderHandler = fn; }
export function requestRerender() { rerenderHandler?.(); }
