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
    repeat: { enabled: false, intervalMs: 250 },
    macro: [],              // [{address, values:[...]}] — sent in order instead of single message
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
    fxButtons: [
      fxButton(0, { label: 'COL 1' }), fxButton(1, { label: 'COL 2' }),
      fxButton(2, { label: 'COL 3' }), fxButton(3, { label: 'COL 4' }),
      fxButton(4, { label: 'TAP', icon: '⏱', color: ACCENTS.amber, type: 'command', address: '/composition/tempocontroller/tempotap' }),
      fxButton(5, { label: 'RESYNC', icon: '↻', color: ACCENTS.amber, type: 'command', address: '/composition/tempocontroller/resync' }),
      fxButton(6, { label: 'L1 SOLO', icon: '◉', color: ACCENTS.purple, mode: 'toggle', address: '/composition/layers/1/solo' }),
      fxButton(7, { label: 'L1 BYP', icon: '⊘', color: ACCENTS.purple, mode: 'toggle', address: '/composition/layers/1/bypassed' }),
      fxButton(8, { label: 'CLR L1', icon: '✕', color: ACCENTS.red, address: '/composition/layers/1/clear' }),
      fxButton(9, { label: 'CLR L2', icon: '✕', color: ACCENTS.red, address: '/composition/layers/2/clear' }),
      fxButton(10, { label: 'CLR L3', icon: '✕', color: ACCENTS.red, address: '/composition/layers/3/clear' }),
      fxButton(11, { label: 'CLR L4', icon: '✕', color: ACCENTS.red, address: '/composition/layers/4/clear' }),
      fxButton(12, { label: 'CLR ALL', icon: '⏻', color: ACCENTS.red, address: '/composition/disconnectall' }),
      fxButton(13, { label: 'MASTER 0', icon: '▼', color: ACCENTS.orange, type: 'float', address: '/composition/master', value: 0 }),
      fxButton(14, { label: 'MASTER 1', icon: '▲', color: ACCENTS.green, type: 'float', address: '/composition/master', value: 1 }),
      fxButton(15, { label: 'FLASH L4', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/layers/4/video/opacity', value: 1, releaseValue: 0 }),
    ],
    faders: [
      fader(0, { label: 'MASTER', color: ACCENTS.green, address: '/composition/master' }),
      fader(1, { label: 'LAYER 1', address: '/composition/layers/1/video/opacity' }),
      fader(2, { label: 'LAYER 2', address: '/composition/layers/2/video/opacity' }),
      fader(3, { label: 'LAYER 3', address: '/composition/layers/3/video/opacity' }),
      fader(4, { label: 'SPEED', color: ACCENTS.amber, address: '/composition/speed', defaultValue: 0.5 }),
      fader(5, { label: 'XFADE', color: ACCENTS.magenta, address: '/composition/crossfader/phase', defaultValue: 0 }),
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
