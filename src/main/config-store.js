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
    extraAddress: '',       // optional second target mirrored on every send
    repeat: { enabled: false, intervalMs: 250, sync: false }, // sync = follow tapped beat
    ramp: { enabled: false, from: 0, to: 1, durationMs: 1500 }, // hold: sweep value while pressed
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
    address: `/composition/layers/${i + 1}/master`,
    extraAddress: '',       // optional second target fed the same value
    extraAddresses: [],     // any further targets fed the same value
    min: 0, max: 1, defaultValue: 1,
    invert: false,
    sensitivity: 1,
    orientation: 'v',       // v = vertical column, h = horizontal strip
    beatSync: { enabled: false, bpmAt1: 300, auto: false }, // ♪/auto: value = bpm / bpmAt1
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
    rgb: null,              // [r,g,b] 0..1 — routes through the active color target
    isOff: false,           // target-mode OFF button (fires the target's offSteps)
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
    beat: { source: 'tap' }, // 'tap' = manual, 'auto' = follow Resolume's BPM
    // Analog gamepad triggers: pressed depth maps onto a float param
    // (from -> to), release snaps back; optional engage/disengage message.
    triggers: {
      lt: {
        enabled: true, label: 'LT · MASTER DUCK',
        engageAddress: '', engageValue: 1, engageReleaseValue: 0,
        analogAddress: '/composition/master', from: 1, to: 0, releaseValue: 1,
      },
      rt: {
        enabled: false, label: 'RT',
        engageAddress: '', engageValue: 1, engageReleaseValue: 0,
        analogAddress: '', from: 0, to: 1, releaseValue: 0,
      },
    },
    // Controller haptics: press ticks + trigger-depth strobe pulse.
    haptics: { enabled: true, press: true, strobe: true },
    // Analog stick axes: deflection maps onto a float param around `center`
    // (out = center + axis * scale, clamped 0..1); spring-back re-centers.
    sticks: {
      ls: {
        enabled: true, label: 'LS · PAN',
        x: { address: '/composition/video/effects/transform/effect/positionx', center: 0.5, scale: 0.03 },
        y: { address: '/composition/video/effects/transform/effect/positiony', center: 0.5, scale: -0.03 },
      },
      rs: {
        enabled: false, label: 'RS',
        x: { address: '', center: 0.5, scale: 0.05 },
        y: { address: '', center: 0.5, scale: -0.05 },
      },
    },
    // fxButtons 0-7 = FLASH bank (momentary hold), 8-15 = BUMP bank (one-shot).
    // gamepadButton defaults: face+shoulder buttons drive flash, D-pad/sticks/menu drive bump.
    fxButtons: [
      fxButton(0, { label: 'FLASH L1', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/layers/1/master', value: 1, releaseValue: 0, gamepadButton: 0 }),
      fxButton(1, { label: 'FLASH L2', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/layers/2/master', value: 1, releaseValue: 0, gamepadButton: 1 }),
      fxButton(2, { label: 'FLASH L3', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/layers/3/master', value: 1, releaseValue: 0, gamepadButton: 2 }),
      fxButton(3, { label: 'FLASH L4', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/layers/4/master', value: 1, releaseValue: 0, gamepadButton: 3 }),
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
    // Second page: same schema, no controller bindings by default.
    fxButtons2: Array.from({ length: 16 }, (_, i) =>
      fxButton(i, { id: `fx2-${i + 1}`, label: `2·FX ${i + 1}`, gamepadButton: -1 })),
    // Third page: dense 24-slot clip-select grid (e.g. DJ intro name straps).
    fxButtons3: Array.from({ length: 24 }, (_, i) =>
      fxButton(i, { id: `fx3-${i + 1}`, label: `3·FX ${i + 1}`, gamepadButton: -1 })),
    // Page-1 utility quad: four small buttons sharing one bump slot.
    utilButtons: Array.from({ length: 4 }, (_, i) =>
      fxButton(i, { id: `util${i + 1}`, label: `U${i + 1}`, mode: 'toggle', gamepadButton: -1 })),
    faders: [
      fader(0, { label: 'MASTER', color: ACCENTS.green, address: '/composition/master' }),
      fader(1, { label: 'LAYER 1', address: '/composition/layers/1/master' }),
      fader(2, { label: 'LAYER 2', address: '/composition/layers/2/master' }),
      fader(3, { label: 'LAYER 3', address: '/composition/layers/3/master' }),
      fader(4, { label: 'LAYER 4', address: '/composition/layers/4/master' }),
      fader(5, { label: 'LOGO', color: ACCENTS.white, address: '/composition/layers/5/master' }),
      fader(6, { label: 'AUX 1', color: ACCENTS.amber, address: '/composition/layers/6/master', orientation: 'h', beatSync: { enabled: true, bpmAt1: 300, auto: true } }),
      fader(7, { label: 'AUX 2', color: ACCENTS.amber, address: '/composition/layers/7/master', orientation: 'h' }),
    ],
    // Page-2 group faders: horizontal strips for layer-group masters.
    groupFaders: Array.from({ length: 6 }, (_, i) =>
      fader(i, { id: `gfader${i + 1}`, label: `GRP ${i + 1}`, orientation: 'h',
        address: `/composition/groups/${i + 1}/master` })),
    colorButtons: Array.from({ length: 10 }, (_, i) => colorButton(i)),
    // Switchable color-picker destinations (the 3 squares at the row's end).
    colorTargets: {
      active: 'bg',
      items: [
        {
          id: 'bg', label: 'BG', swatch: '#2ee66b',
          colorBases: ['/composition/groups/1/video/effects/colorize/effect/color'],
          onSteps: [{ address: '/composition/groups/1/video/effects/colorize/bypassed', values: [0] }],
          offSteps: [{ address: '/composition/groups/1/video/effects/colorize/bypassed', values: [1] }],
        },
        {
          id: 'logo', label: 'LOGO', swatch: '#eaeef5',
          colorBases: [
            '/composition/layers/8/video/effects/outlinehaze/effect/color',
            '/composition/layers/9/video/effects/outlinehaze/effect/color',
          ],
          onSteps: [],
          offSteps: [
            { address: '/composition/layers/8/video/effects/outlinehaze/bypassed', values: [1] },
            { address: '/composition/layers/9/video/effects/outlinehaze/bypassed', values: [1] },
          ],
        },
        {
          id: 'flash', label: 'FLASH', swatch: '#ffd93d',
          colorBases: [
            '/composition/layers/12/clips/3/video/effects/flashmaster/effect/color1',
            '/composition/layers/12/clips/4/video/effects/flashmaster/effect/color1',
            '/composition/layers/12/clips/7/video/effects/flashmaster/effect/color1',
          ],
          onSteps: [],
          offSteps: [],
        },
        // ColorMorph composition FX: two live colors (Color 1 + Color 3).
        {
          id: 'morph1', label: 'MORPH 1', swatch: '#ff3b30',
          colorBases: ['/composition/video/effects/colormorph/effect/color1'],
          onSteps: [{ address: '/composition/video/effects/colormorph/bypassed', values: [0] }],
          offSteps: [{ address: '/composition/video/effects/colormorph/bypassed', values: [1] }],
        },
        {
          id: 'morph2', label: 'MORPH 2', swatch: '#ff3df0',
          colorBases: ['/composition/video/effects/colormorph/effect/color3'],
          onSteps: [{ address: '/composition/video/effects/colormorph/bypassed', values: [0] }],
          offSteps: [{ address: '/composition/video/effects/colormorph/bypassed', values: [1] }],
        },
      ],
    },
    // ColorMorph extras driven by the COLORS page (speed slider + on/off).
    colorMorph: {
      speedAddress: '/composition/video/effects/colormorph/effect/speed',
      bypassAddress: '/composition/video/effects/colormorph/bypassed',
    },
    // AI Visual Director: decides WHAT (intents); the executor resolves HOW
    // through the semantic show model. Boots in suggest mode, disarmed.
    director: {
      mode: 'suggest',          // 'suggest' shows intents only; 'auto' executes
      // operator-extendable protected layer name patterns (case-insensitive)
      protectedPatterns: ['^TC', 'TC/PB', 'TIMER', 'LFV', 'SYNC', '^AB\\b', 'AUDIO', 'INPUT', 'ROUTE'],
      // confidence tiers: >=act full speed; >=cautious low/medium impact only;
      // >=hold force HoldCurrentVisual; below hold notify the operator
      confidence: { act: 0.8, cautious: 0.55, hold: 0.35 },
      supervisorBackoffMs: 30000, // manual touch pauses autopilot this long
      rebuildIntervalMs: 60000,   // composition re-inspection cadence
    },
    // AI VJ agent (audio sidecar → /rogger/agent/* events → cue macros).
    // ARM lives page-local only: the agent always boots disarmed.
    agent: {
      feedBeatClock: false,
      // Cues fire on sidecar events; `variants` rotate per fire so repeats
      // vary the look like a live VJ instead of hammering one clip.
      rules: [
        {
          id: 'drop', label: 'DROP HIT', event: 'drop', enabled: true,
          cooldownMs: 8000, pulseMs: 600,
          macro: [{ address: '/composition/layers/12/clips/3/connect', values: [1] }],
          variants: [
            [{ address: '/composition/layers/12/clips/3/connect', values: [1] }], // FLASH MASTER
            [{ address: '/composition/layers/12/clips/8/connect', values: [1] }], // SUCK IT!
            [{ address: '/composition/layers/12/clips/4/connect', values: [1] }], // FLASH MASTER 2
          ],
        },
        {
          id: 'build', label: 'BUILD STROBE', event: 'buildstart', enabled: true,
          cooldownMs: 12000, pulseMs: 4000,
          macro: [{ address: '/composition/layers/12/clips/9/connect', values: [1] }],
        },
        {
          id: 'fakebuild', label: 'FAKE TEASE', event: 'fakebuild', enabled: true,
          cooldownMs: 15000, pulseMs: 800,
          macro: [{ address: '/composition/layers/12/clips/7/connect', values: [1] }], // FE STR
        },
        {
          id: 'breakdown', label: 'BREAK CALM', event: 'breakdown', enabled: true,
          cooldownMs: 12000, pulseMs: 0,
          macro: [{ address: '/composition/video/effects/colormorph/bypassed', values: [1] }],
        },
        {
          id: 'vocal', label: 'VOCAL AQUARELLA', event: 'vocalstart', enabled: true,
          cooldownMs: 10000, pulseMs: 0,
          macro: [{ address: '/composition/groups/1/video/effects/acuarela/bypassed', values: [0] }],
        },
        {
          id: 'vocalend', label: 'VOCAL OUT', event: 'vocalend', enabled: true,
          cooldownMs: 1000, pulseMs: 0,
          macro: [{ address: '/composition/groups/1/video/effects/acuarela/bypassed', values: [1] }],
        },
        {
          id: 'bump', label: 'BAR BUMP', event: 'downbeat', enabled: true,
          cooldownMs: 7000, pulseMs: 300,
          macro: [{ address: '/composition/video/effects/pusher/effect/push!', values: [1] }],
          variants: [
            [{ address: '/composition/video/effects/pusher/effect/push!', values: [1] }],
            [{ address: '/composition/video/effects/pusher2/effect/push!', values: [1] }],
          ],
        },
        {
          id: 'steady', label: 'STEADY RESET', event: 'steady', enabled: false,
          cooldownMs: 20000, pulseMs: 0,
          macro: [{ address: '/composition/groups/1/video/effects/acuarela/bypassed', values: [1] }],
        },
      ],
    },
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

// Saved items merge by id onto the defaults, so configs saved before a new
// entry existed (ColorMorph targets, agent rules) don't erase it.
function mergeById(defaultsArr, patchArr) {
  return defaultsArr.map(d => {
    const saved = Array.isArray(patchArr) ? patchArr.find(x => x?.id === d.id) : null;
    return saved ? deepMerge(d, saved) : d;
  });
}

function mergeColorTargets(base, patch) {
  if (!isPlainObject(patch)) return base;
  const items = mergeById(base.items, patch.items);
  const active = items.some(x => x.id === patch.active) ? patch.active : base.active;
  return { active, items };
}

function mergeAgent(base, patch) {
  if (!isPlainObject(patch)) return base;
  return { ...deepMerge(base, patch), rules: mergeById(base.rules, patch.rules) };
}

function mergeConfig(base, patch) {
  return {
    ...base,
    version: base.version,
    network: deepMerge(base.network, isPlainObject(patch.network) ? patch.network : {}),
    ui: deepMerge(base.ui, isPlainObject(patch.ui) ? patch.ui : {}),
    triggers: deepMerge(base.triggers, isPlainObject(patch.triggers) ? patch.triggers : {}),
    colorTargets: mergeColorTargets(base.colorTargets, patch.colorTargets),
    colorMorph: deepMerge(base.colorMorph, isPlainObject(patch.colorMorph) ? patch.colorMorph : {}),
    agent: mergeAgent(base.agent, patch.agent),
    director: deepMerge(base.director, isPlainObject(patch.director) ? patch.director : {}),
    sticks: deepMerge(base.sticks, isPlainObject(patch.sticks) ? patch.sticks : {}),
    haptics: deepMerge(base.haptics, isPlainObject(patch.haptics) ? patch.haptics : {}),
    beat: deepMerge(base.beat, isPlainObject(patch.beat) ? patch.beat : {}),
    fxButtons: mergeControls(base.fxButtons, patch.fxButtons),
    fxButtons2: mergeControls(base.fxButtons2, patch.fxButtons2),
    fxButtons3: mergeControls(base.fxButtons3, patch.fxButtons3),
    utilButtons: mergeControls(base.utilButtons, patch.utilButtons),
    faders: mergeControls(base.faders, patch.faders),
    groupFaders: mergeControls(base.groupFaders, patch.groupFaders),
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
