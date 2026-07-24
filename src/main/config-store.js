'use strict';
// Config persistence: defaults, tolerant load (merge/repair), atomic save.
const fs = require('node:fs');
const path = require('node:path');

const ACCENTS = {
  cyan: '#00e0ff', amber: '#ffb400', red: '#ff4757', green: '#2ee66b',
  purple: '#b46bff', orange: '#ff7a1a', white: '#eaeef5', blue: '#3aa0ff',
  magenta: '#ff3df0', yellow: '#ffd93d',
};

function fxButton(i, over = {}) {
  return {
    id: `fx${i + 1}`,
    label: `FX ${i + 1}`,
    icon: '◆',
    color: ACCENTS.cyan,
    mode: 'tap',            // tap | toggle | hold
    type: 'int',            // command | int | float
    address: `/composition/columns/${i + 1}/connect`,
    value: 1,
    offValue: 0,            // toggle off
    releaseValue: 0,        // hold release
    releaseAddress: '',     // hold release target; empty = same as address
    repeat: { enabled: false, intervalMs: 250 },
    macro: [],              // [{address, values:[...]}] — sent in order instead of single message
    gamepadButton: -1,      // standard-mapping gamepad button index, -1 = unbound
    ...over,
  };
}

function fader(i, over = {}) {
  return {
    id: `fader${i + 1}`,
    label: `F${i + 1}`,
    color: ACCENTS.cyan,
    address: `/composition/layers/${i + 1}/video/opacity`,
    min: 0, max: 1, defaultValue: 1,
    invert: false,
    sensitivity: 1,
    ...over,
  };
}

function colorButton(i, over = {}) {
  const swatches = ['#ff3b30', '#ff7a1a', '#ffd93d', '#2ee66b', '#00e0ff',
    '#3aa0ff', '#b46bff', '#ff3df0', '#eaeef5', '#8e9299'];
  return {
    id: `color${i + 1}`,
    label: `C${i + 1}`,
    color: swatches[i % swatches.length],
    address: `/composition/layers/5/clips/${i + 1}/connect`,
    args: [1],
    macro: [],              // [{address, values:[...]}] — sent in order instead of single message
    ...over,
  };
}

function defaults() {
  return {
    version: 1,
    network: {
      targetIp: '192.168.1.100',
      targetPort: 7000,
      listenPort: 7001,
      autoConnect: true,
      autoReconnect: true,
    },
    ui: { theme: 'dark' },
    // fxButtons 0-7 = FLASH bank (momentary hold), 8-15 = BUMP bank (one-shot).
    // gamepadButton defaults: face+shoulder buttons drive flash, D-pad/sticks/menu drive bump.
    fxButtons: [
      fxButton(0, { label: 'FLASH L1', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/layers/1/video/opacity', value: 1, releaseValue: 0, gamepadButton: 0 }),
      fxButton(1, { label: 'FLASH L2', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/layers/2/video/opacity', value: 1, releaseValue: 0, gamepadButton: 1 }),
      fxButton(2, { label: 'FLASH L3', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/layers/3/video/opacity', value: 1, releaseValue: 0, gamepadButton: 2 }),
      fxButton(3, { label: 'FLASH L4', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/layers/4/video/opacity', value: 1, releaseValue: 0, gamepadButton: 3 }),
      fxButton(4, { label: 'SOLO L1', icon: '◉', color: ACCENTS.purple, mode: 'hold', address: '/composition/layers/1/solo', value: 1, releaseValue: 0, gamepadButton: 4 }),
      fxButton(5, { label: 'SOLO L2', icon: '◉', color: ACCENTS.purple, mode: 'hold', address: '/composition/layers/2/solo', value: 1, releaseValue: 0, gamepadButton: 5 }),
      fxButton(6, { label: 'SOLO L3', icon: '◉', color: ACCENTS.purple, mode: 'hold', address: '/composition/layers/3/solo', value: 1, releaseValue: 0, gamepadButton: 6 }),
      fxButton(7, { label: 'SOLO L4', icon: '◉', color: ACCENTS.purple, mode: 'hold', address: '/composition/layers/4/solo', value: 1, releaseValue: 0, gamepadButton: 7 }),
      fxButton(8, { label: 'COL 1', icon: '▶', gamepadButton: 12, address: '/composition/columns/1/connect' }),
      fxButton(9, { label: 'COL 2', icon: '▶', gamepadButton: 13, address: '/composition/columns/2/connect' }),
      fxButton(10, { label: 'COL 3', icon: '▶', gamepadButton: 14, address: '/composition/columns/3/connect' }),
      fxButton(11, { label: 'COL 4', icon: '▶', gamepadButton: 15, address: '/composition/columns/4/connect' }),
      fxButton(12, { label: 'COL 5', icon: '▶', gamepadButton: 10, address: '/composition/columns/5/connect' }),
      fxButton(13, { label: 'COL 6', icon: '▶', gamepadButton: 11, address: '/composition/columns/6/connect' }),
      fxButton(14, { label: 'COL 7', icon: '▶', gamepadButton: 8, address: '/composition/columns/7/connect' }),
      fxButton(15, { label: 'COL 8', icon: '▶', gamepadButton: 9, address: '/composition/columns/8/connect' }),
    ],
    faders: [
      fader(0, { label: 'MASTER', color: ACCENTS.green, address: '/composition/master' }),
      fader(1, { label: 'LAYER 1', address: '/composition/layers/1/video/opacity' }),
      fader(2, { label: 'LAYER 2', address: '/composition/layers/2/video/opacity' }),
      fader(3, { label: 'LAYER 3', address: '/composition/layers/3/video/opacity' }),
      fader(4, { label: 'LAYER 4', address: '/composition/layers/4/video/opacity' }),
      fader(5, { label: 'LOGO', color: ACCENTS.white, address: '/composition/layers/5/video/opacity' }),
    ],
    colorButtons: Array.from({ length: 10 }, (_, i) => colorButton(i)),
  };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = isPlainObject(base?.[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

// Control arrays keep the default length: extras dropped, gaps filled item-wise.
function mergeControls(defaultsArr, patchArr) {
  if (!Array.isArray(patchArr)) return defaultsArr;
  return defaultsArr.map((d, i) => (isPlainObject(patchArr[i]) ? deepMerge(d, patchArr[i]) : d));
}

function mergeConfig(base, patch) {
  return {
    ...base,
    version: base.version,
    network: deepMerge(base.network, isPlainObject(patch.network) ? patch.network : {}),
    ui: deepMerge(base.ui, isPlainObject(patch.ui) ? patch.ui : {}),
    fxButtons: mergeControls(base.fxButtons, patch.fxButtons),
    faders: mergeControls(base.faders, patch.faders),
    colorButtons: mergeControls(base.colorButtons, patch.colorButtons),
  };
}

function load(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return defaults();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('config root must be an object');
  } catch {
    try { fs.renameSync(filePath, filePath + '.bad'); } catch { /* keep going with defaults */ }
    return defaults();
  }
  return mergeConfig(defaults(), parsed);
}

function save(filePath, config) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, filePath);
}

module.exports = { defaults, load, save, ACCENTS };
