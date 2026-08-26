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
    gamepadModifier: -1,    // pad button that must be held for this binding; -1 = none
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
    // Over-the-air payload updates from GitHub releases. Checking is automatic
    // on launch; downloading and restarting are always an explicit tap, so an
    // update can never interrupt a show on its own.
    updates: {
      autoCheck: true,
      repo: 'riegergogi2001/resolume-rogger',
    },
    // 'tap' = manual taps, 'auto' = follow Resolume's BPM, 'mic' = BPM page
    // mic/line-in analyser (src/renderer/js/bpm/).
    beat: {
      source: 'tap',
      micDeviceId: '',        // '' = system default input
      micAutoStart: false,    // auto-start mic capture on boot
      micSendTempo: false,    // "Send Tempo to Resolume" toggle on the BPM page
    },
    // Analog gamepad triggers: pressed depth maps onto a float param
    // (from -> to), release snaps back; optional engage/disengage message.
    triggers: {
      lt: {
        enabled: true, label: 'LT · MASTER DUCK',
        engageAddress: '', engageValue: 1, engageReleaseValue: 0,
        analogAddress: '/composition/master', from: 1, to: 0, releaseValue: 1,
      },
      rt: {
        enabled: true, label: 'RT · INVERT STOMP',
        engageAddress: '/composition/layers/12/clips/5/connect', engageValue: 1, engageReleaseValue: 0,
        analogAddress: '/composition/layers/12/master', from: 0, to: 1, releaseValue: 1,
      },
    },
    // Controller haptics: press ticks + trigger-depth strobe pulse.
    haptics: { enabled: true, press: true, strobe: true },
    // Analog stick axes: deflection maps onto a float param around `center`
    // (out = center + axis * scale, clamped 0..1); spring-back re-centers.
    sticks: {
      ls: {
        enabled: true, label: 'LS · PAN',
        x: { address: '/composition/video/effects/transform/positionx', center: 0.5, scale: 0.03 },
        y: { address: '/composition/video/effects/transform/positiony', center: 0.5, scale: -0.03 },
      },
      rs: {
        enabled: true, label: 'RS · ZOOM/ROT',
        x: { address: '/composition/video/effects/transform/rotationz', center: 0.5, scale: 0.05 },
        y: { address: '/composition/video/effects/transform/scale', center: 0.1, scale: -0.05 },
      },
    },
    // Defaults mirror the autoVJ template composition: layer 12 = FX rack
    // cue clips, comp-level BOOMER/PUSHER/Distortion, group 1 = content FX.
    // fxButtons 0-7 = FLASH bank (cue clips), 8-15 = BUMP bank (comp FX).
    // Pad layout (the 2026-08-22 layout, restored in 2.2.5 — the 2.2.1–2.2.3
    // combo layout did not work out on stage): A/B/X/Y = PUSH WHT / FLASH M /
    // FLASH M2 / INVERT, LB = SUCK IT!, RB = PIXELATE, RS-click = PUSH BLK,
    // D-pad = SLICE STR + BOOM BLUR/EXPO/EDGE, LT master duck, RT INVERT
    // stomp. No combos ship by default; the operator adds their own with
    // Gamepad Learn (hold a modifier + press). LS-click stays free.
    fxButtons: [
      fxButton(0, { label: 'GENERA', icon: '⚡', color: ACCENTS.green, mode: 'hold', address: '/composition/layers/12/clips/2/connect' }),
      fxButton(1, { label: 'FLASH M', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', address: '/composition/layers/12/clips/3/connect', gamepadButton: 1 }),
      fxButton(2, { label: 'FLASH M2', icon: '⚡', color: ACCENTS.yellow, mode: 'hold', address: '/composition/layers/12/clips/4/connect', gamepadButton: 2 }),
      fxButton(3, { label: 'INVERT', icon: '⚡', color: ACCENTS.red, mode: 'hold', address: '/composition/layers/12/clips/5/connect', gamepadButton: 3 }),
      fxButton(4, { label: 'PIXELATE', icon: '⚡', color: ACCENTS.cyan, mode: 'hold', address: '/composition/layers/12/clips/6/connect', gamepadButton: 5 }),
      fxButton(5, { label: 'FE STR', icon: '⚡', color: ACCENTS.orange, mode: 'hold', address: '/composition/layers/12/clips/7/connect' }),
      fxButton(6, { label: 'SUCK IT!', icon: '⚡', color: ACCENTS.magenta, mode: 'hold', address: '/composition/layers/12/clips/8/connect', gamepadButton: 4 }),
      fxButton(7, { label: 'SLICE STR', icon: '⚡', color: ACCENTS.purple, mode: 'toggle', address: '/composition/layers/12/clips/9/connect', gamepadButton: 12 }),
      // slot 8 hides behind the utility quad in the banks layout — keep it
      // a harmless spare so nothing important becomes unreachable
      fxButton(8, { label: 'SPARE', icon: '·', color: '#3a3f47', mode: 'hold', address: '/composition/layers/12/clear' }),
      fxButton(9, { label: 'BOOM ALL', icon: '☄', color: ACCENTS.orange, mode: 'hold', address: '/composition/video/effects/boomer/effect/blur', repeat: { enabled: true, intervalMs: 200, sync: true },
        macro: ['blur', 'exposure', 'edge', 'blow'].map(p => ({ address: `/composition/video/effects/boomer/effect/${p}`, values: [1] })) }),
      fxButton(10, { label: 'BOOM BLUR', icon: '☄', color: ACCENTS.cyan, mode: 'hold', address: '/composition/video/effects/boomer/effect/blur', repeat: { enabled: true, intervalMs: 200, sync: true }, gamepadButton: 13 }),
      fxButton(11, { label: 'BOOM EXPO', icon: '☄', color: ACCENTS.yellow, mode: 'hold', address: '/composition/video/effects/boomer/effect/exposure', repeat: { enabled: true, intervalMs: 200, sync: true }, gamepadButton: 14 }),
      fxButton(12, { label: 'BOOM EDGE', icon: '☄', color: ACCENTS.green, mode: 'hold', address: '/composition/video/effects/boomer/effect/edge', repeat: { enabled: true, intervalMs: 200, sync: true }, gamepadButton: 15 }),
      fxButton(13, { label: 'BOOM BLOW', icon: '☄', color: ACCENTS.orange, mode: 'hold', address: '/composition/video/effects/boomer/effect/blow', repeat: { enabled: true, intervalMs: 200, sync: true } }),
      fxButton(14, { label: 'PUSH WHT', icon: '☄', color: ACCENTS.white, mode: 'hold', address: '/composition/video/effects/pusher/effect/push!', repeat: { enabled: true, intervalMs: 200, sync: true }, gamepadButton: 0 }),
      fxButton(15, { label: 'PUSH BLK', icon: '☄', color: '#8e9299', mode: 'hold', address: '/composition/video/effects/pusher2/effect/push!', repeat: { enabled: true, intervalMs: 200, sync: true }, gamepadButton: 11 }),
    ],
    // Second page: group-1 content FX (opacity ramps) + clears + resets.
    fxButtons2: [
      fxButton(0, { id: 'fx2-1', label: 'EDGE FX', icon: '◐', mode: 'hold', type: 'float', address: '/composition/groups/1/video/effects/edgedetection/opacity', ramp: { enabled: true, from: 0, to: 1, durationMs: 2000 } }),
      fxButton(1, { id: 'fx2-2', label: 'ACUARELA', icon: '◐', color: ACCENTS.green, mode: 'hold', type: 'float', address: '/composition/groups/1/video/effects/acuarela/opacity', ramp: { enabled: true, from: 0, to: 1, durationMs: 2000 } }),
      fxButton(2, { id: 'fx2-3', label: 'BLOOM', icon: '◐', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/groups/1/video/effects/bloom/opacity', ramp: { enabled: true, from: 0, to: 1, durationMs: 2000 } }),
      fxButton(3, { id: 'fx2-4', label: 'GOO', icon: '◐', color: ACCENTS.purple, mode: 'hold', type: 'float', address: '/composition/groups/1/video/effects/goo/opacity', ramp: { enabled: true, from: 0, to: 1, durationMs: 2000 } }),
      fxButton(4, { id: 'fx2-5', label: 'INF ZOOM', icon: '◐', color: ACCENTS.orange, mode: 'hold', type: 'float', address: '/composition/groups/1/video/effects/infinitezoom/opacity', ramp: { enabled: true, from: 0, to: 1, durationMs: 2000 } }),
      fxButton(5, { id: 'fx2-6', label: 'METASHAPE', icon: '◐', color: ACCENTS.blue, mode: 'hold', type: 'float', address: '/composition/groups/1/video/effects/metashape/opacity', ramp: { enabled: true, from: 0, to: 1, durationMs: 2000 } }),
      fxButton(6, { id: 'fx2-7', label: 'GLITCH', icon: '◐', color: ACCENTS.magenta, mode: 'hold', type: 'float', address: '/composition/groups/1/video/effects/shiftglitch/opacity', ramp: { enabled: true, from: 0, to: 1, durationMs: 2000 } }),
      fxButton(7, { id: 'fx2-8', label: 'HUE SPIN', icon: '◐', color: ACCENTS.yellow, mode: 'hold', type: 'float', address: '/composition/groups/1/video/effects/huerotate/effect/huerotate', releaseValue: 0.57, ramp: { enabled: true, from: 0, to: 1, durationMs: 2000 } }),
      fxButton(8, { id: 'fx2-9', label: 'CLR FX', icon: '✕', color: ACCENTS.red, mode: 'hold', address: '/composition/layers/12/clear' }),
      fxButton(9, { id: 'fx2-10', label: 'CLR LOGO', icon: '✕', color: ACCENTS.red, mode: 'hold', address: '/composition/layers/9/clear' }),
      fxButton(10, { id: 'fx2-11', label: 'BOOM INV', icon: '☄', color: ACCENTS.white, mode: 'hold', address: '/composition/video/effects/boomer/effect/invert', repeat: { enabled: true, intervalMs: 250, sync: true } }),
      fxButton(11, { id: 'fx2-12', label: 'PUSH X2', icon: '☄', color: ACCENTS.white, mode: 'hold', address: '/composition/video/effects/pusher/effect/push!', repeat: { enabled: true, intervalMs: 250, sync: true },
        macro: [{ address: '/composition/video/effects/pusher/effect/push!', values: [1] }, { address: '/composition/video/effects/pusher2/effect/push!', values: [1] }] }),
      fxButton(12, { id: 'fx2-13', label: 'LOGO ALT', icon: '▩', color: ACCENTS.blue, mode: 'hold', address: '/composition/layers/8/clips/17/connect' }),
      fxButton(13, { id: 'fx2-14', label: 'HUE RST', icon: '↻', color: ACCENTS.yellow, type: 'float', address: '/composition/groups/1/video/effects/huerotate/effect/huerotate', value: 0.57 }),
      fxButton(14, { id: 'fx2-15', label: 'ZOOM RST', icon: '◎', color: ACCENTS.orange, mode: 'hold', address: '/composition/groups/1/video/effects/infinitezoom/effect/reset' }),
      fxButton(15, { id: 'fx2-16', label: 'ACUA RST', icon: '◎', color: ACCENTS.green, mode: 'hold', address: '/composition/groups/1/video/effects/acuarela/effect/reset' }),
    ],
    // Third page: dense 24-slot grid on group 5 (timecode/playback columns);
    // "Sync from Resolume" rewrites labels from the live composition.
    fxButtons3: Array.from({ length: 24 }, (_, i) => {
      const colors = [ACCENTS.yellow, ACCENTS.green, ACCENTS.purple, ACCENTS.orange, ACCENTS.blue, ACCENTS.magenta, ACCENTS.white, ACCENTS.cyan];
      if (i === 0) return fxButton(0, { id: 'fx3-1', label: 'OFF', icon: '✕', color: ACCENTS.red, mode: 'hold', address: '/composition/groups/5/columns/1/connect' });
      if (i === 22) return fxButton(22, { id: 'fx3-23', label: 'LOGO ON', color: ACCENTS.white, mode: 'hold', address: '/composition/layers/9/clips/2/connect',
        macro: [{ address: '/composition/layers/9/clips/2/connect', values: [1] }, { address: '/composition/layers/8/clear', values: [1] }] });
      if (i === 23) return fxButton(23, { id: 'fx3-24', label: 'LOGO OFF', icon: '✕', color: ACCENTS.red, mode: 'hold', address: '/composition/layers/9/clear',
        macro: [{ address: '/composition/layers/8/clear', values: [1] }, { address: '/composition/layers/9/clear', values: [1] }] });
      return fxButton(i, { id: `fx3-${i + 1}`, label: `TC ${i + 1}`, icon: '♪', color: colors[i % colors.length], mode: 'hold', address: `/composition/groups/5/columns/${i + 1}/connect` });
    }),
    // Page-1 utility quad: toggles for the always-on look switches.
    utilButtons: [
      fxButton(0, { id: 'util1', label: 'KEEP GREYS', icon: '◐', color: ACCENTS.white, mode: 'toggle', address: '/composition/groups/1/video/effects/colorize/effect/greyskeep' }),
      fxButton(1, { id: 'util2', label: 'HAZE', icon: '✦', color: ACCENTS.green, mode: 'toggle', address: '/composition/layers/8/video/effects/outlinehaze/bypassed', value: 0, offValue: 1, extraAddress: '/composition/layers/9/video/effects/outlinehaze/bypassed' }),
      fxButton(2, { id: 'util3', label: 'DISTORT', icon: '◈', color: ACCENTS.orange, mode: 'toggle', address: '/composition/video/effects/distortion/bypassed', value: 0, offValue: 1 }),
      fxButton(3, { id: 'util4', label: 'AUTO VJ', icon: '↻', color: ACCENTS.green, mode: 'toggle', address: '/composition/layers/1/autopilot/target', value: 3 }),
      // SLICE STROBE (layer 12 clip 9). Verified against Resolume 7.26:
      // strobemode is a choice (0 = Random, 1 = Slice Order); the rest are
      // booleans. Resolume keeps the hyphens in slice-o-rama and spells
      // Symettric its own way — both are its names, not typos here.
      fxButton(4, { id: 'util5', label: 'SLICE ORDER', icon: '⇄', color: ACCENTS.cyan,
        mode: 'toggle', type: 'int', value: 1, offValue: 0,
        address: '/composition/layers/12/clips/9/video/effects/slicestrobe/effect/strobemode' }),
      fxButton(5, { id: 'util6', label: 'EDGE STR', icon: '◨', color: ACCENTS.yellow,
        mode: 'toggle', type: 'int', value: 1, offValue: 0,
        address: '/composition/layers/12/clips/9/video/effects/slicestrobe/effect/edgestrobe' }),
      fxButton(6, { id: 'util7', label: 'SYMMETRIC', icon: '⋈', color: ACCENTS.green,
        mode: 'toggle', type: 'int', value: 1, offValue: 0,
        address: '/composition/layers/12/clips/9/video/effects/slicestrobe/effect/symettric' }),
      fxButton(7, { id: 'util8', label: 'S-O-RAMA', icon: '◧', color: ACCENTS.purple,
        mode: 'toggle', type: 'int', value: 1, offValue: 0,
        address: '/composition/layers/12/clips/9/video/effects/slicestrobe/effect/slice-o-rama' }),
      fxButton(8, { id: 'util9', label: 'VIS STR', icon: '◉', color: ACCENTS.orange,
        mode: 'toggle', type: 'int', value: 1, offValue: 0,
        address: '/composition/layers/12/clips/9/video/effects/slicestrobe/effect/visualstrobe' }),
    ],
    faders: [
      fader(0, { label: 'MASTER', color: ACCENTS.green, address: '/composition/master' }),
      fader(1, { label: 'LAYER 1', address: '/composition/layers/1/master' }),
      fader(2, { label: 'LAYER 2', address: '/composition/layers/2/master' }),
      fader(3, { label: 'LAYER 3', address: '/composition/layers/3/master' }),
      fader(4, { label: 'LAYER 4', address: '/composition/layers/4/master' }),
      fader(5, { label: 'LOGO', color: ACCENTS.white, address: '/composition/layers/9/master' }),
      fader(6, { label: 'PUSH TIME', color: ACCENTS.amber, address: '/composition/video/effects/pusher/effect/fadeouttime',
        extraAddress: '/composition/video/effects/pusher2/effect/fadeouttime', defaultValue: 0.37, orientation: 'h' }),
      fader(7, { label: 'STR SPD', color: ACCENTS.purple, address: '/composition/layers/12/clips/3/video/effects/flashmaster/effect/strobespeed',
        extraAddresses: [
          '/composition/layers/12/clips/4/video/effects/flashmaster/effect/strobespeed',
          '/composition/layers/12/clips/7/video/effects/flashmaster/effect/strobespeed',
          '/composition/layers/12/clips/9/video/effects/slicestrobe/effect/speed',
        ], defaultValue: 0.31, orientation: 'h', beatSync: { enabled: true, bpmAt1: 300, auto: true } }),
    ],
    // Page-2 group faders: horizontal strips for layer-group masters.
    groupFaders: [
      fader(0, { id: 'gfader1', label: 'BG GRP', color: ACCENTS.green, orientation: 'h', address: '/composition/groups/1/master' }),
      fader(1, { id: 'gfader2', label: 'BANNER', color: ACCENTS.amber, orientation: 'h', address: '/composition/groups/2/master' }),
      fader(2, { id: 'gfader3', label: 'LOGOS', color: ACCENTS.white, orientation: 'h', address: '/composition/groups/3/master' }),
      fader(3, { id: 'gfader4', label: 'FX RACK', color: ACCENTS.purple, orientation: 'h', address: '/composition/groups/4/master' }),
      fader(4, { id: 'gfader5', label: 'TC GRP', orientation: 'h', address: '/composition/groups/5/master' }),
      fader(5, { id: 'gfader6', label: 'TIMES', color: '#8e9299', orientation: 'h', address: '/composition/groups/6/master' }),
    ],
    // Named palette routed through the active color target (rgb mode);
    // args carries the legacy red-channel scalar for single-address targets.
    colorButtons: [
      ['RED', '#ff0000', [1, 0, 0]],
      ['ORANGE', '#ff6600', [1, 0.4, 0]],
      ['YELLOW', '#ffd900', [1, 0.85, 0]],
      ['GREEN', '#00ff26', [0, 1, 0.15]],
      ['CYAN', '#00e5ff', [0, 0.9, 1]],
      ['BLUE', '#1a4dff', [0.1, 0.3, 1]],
      ['PURPLE', '#8c26ff', [0.55, 0.15, 1]],
      ['MAGENTA', '#ff1ad9', [1, 0.1, 0.85]],
      ['WHITE', '#ffffff', [1, 1, 1]],
      // These route through whichever colour target is active (see
      // color-row.js), so they deliberately carry no address of their own.
      // They used to hardcode the BG colorize red channel with args set to the
      // red component — a fossil from before targets existed. Nothing ever
      // sent it, but the editor showed it, which made every preset look like
      // it pointed somewhere it did not.
    ].map(([label, color, rgb], i) => colorButton(i, {
      label, color, rgb, address: '', args: [],
    })).concat([
      colorButton(9, { label: 'OFF', color: '#3a3f47', isOff: true, address: '', args: [] }),
    ]),
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
        // Every colour on all three logo layers (LOGO DJ = 8, LOGO MAIN = 9,
        // LOGO OPT1 = 10), linked: Colorize is what actually tints the logos,
        // OutlineHaze is the optional glow the HAZE toggle switches on. Before
        // 2.2.0 the target only reached the haze, which is bypassed by
        // default, so a pick changed nothing on the screens and the Colorize
        // colours could drift apart; layer 10 joined once the comp got its
        // own Colorize + OutlineHaze (26autoV_SZIN_0826).
        {
          id: 'logo', label: 'LOGO', swatch: '#eaeef5',
          colorBases: [
            '/composition/layers/8/video/effects/colorize/effect/color',
            '/composition/layers/9/video/effects/colorize/effect/color',
            '/composition/layers/10/video/effects/colorize/effect/color',
            '/composition/layers/8/video/effects/outlinehaze/effect/color',
            '/composition/layers/9/video/effects/outlinehaze/effect/color',
            '/composition/layers/10/video/effects/outlinehaze/effect/color',
          ],
          onSteps: [
            { address: '/composition/layers/8/video/effects/colorize/bypassed', values: [0] },
            { address: '/composition/layers/9/video/effects/colorize/bypassed', values: [0] },
            { address: '/composition/layers/10/video/effects/colorize/bypassed', values: [0] },
          ],
          offSteps: [
            { address: '/composition/layers/8/video/effects/colorize/bypassed', values: [1] },
            { address: '/composition/layers/9/video/effects/colorize/bypassed', values: [1] },
            { address: '/composition/layers/10/video/effects/colorize/bypassed', values: [1] },
            { address: '/composition/layers/8/video/effects/outlinehaze/bypassed', values: [1] },
            { address: '/composition/layers/9/video/effects/outlinehaze/bypassed', values: [1] },
            { address: '/composition/layers/10/video/effects/outlinehaze/bypassed', values: [1] },
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
/**
 * Merge a control array from a config onto the defaults, by index.
 *
 * @param {boolean} [grow] allow the config to hold MORE controls than the
 *   defaults. Off for the fixed banks — their grids have a set number of slots
 *   and silently rendering a 17th button into an 8-slot bank helps nobody. On
 *   for the utility strip, which is a row that simply gets longer, so a button
 *   can be added there by hand without touching any code. Extra entries are
 *   merged onto the last default so they still carry every field the renderer
 *   expects.
 */
function mergeControls(defaultsArr, patchArr, grow = false) {
  if (!Array.isArray(patchArr)) return defaultsArr;
  const merged = defaultsArr.map((d, i) => (isPlainObject(patchArr[i]) ? deepMerge(d, patchArr[i]) : d));
  if (!grow) return merged;
  const template = defaultsArr[defaultsArr.length - 1];
  if (!template) return merged;
  for (let i = defaultsArr.length; i < patchArr.length; i += 1) {
    if (isPlainObject(patchArr[i])) merged.push(deepMerge(template, patchArr[i]));
  }
  return merged;
}

// Earlier wirings of the built-in targets, exactly as older app versions
// saved them. A saved target that still matches one of these was never
// touched by the operator, so it follows the shipped default; anything else
// is theirs and is left alone. Only the wiring is compared — label and
// swatch are cosmetic and always kept.
const LEGACY_TARGET_WIRINGS = {
  logo: [
    // 2.2.0 – 2.2.5: layers 8 + 9 only (LOGO OPT1 had no colour effect yet).
    {
      colorBases: [
        '/composition/layers/8/video/effects/colorize/effect/color',
        '/composition/layers/9/video/effects/colorize/effect/color',
        '/composition/layers/8/video/effects/outlinehaze/effect/color',
        '/composition/layers/9/video/effects/outlinehaze/effect/color',
      ],
      onSteps: [
        { address: '/composition/layers/8/video/effects/colorize/bypassed', values: [0] },
        { address: '/composition/layers/9/video/effects/colorize/bypassed', values: [0] },
      ],
      offSteps: [
        { address: '/composition/layers/8/video/effects/colorize/bypassed', values: [1] },
        { address: '/composition/layers/9/video/effects/colorize/bypassed', values: [1] },
        { address: '/composition/layers/8/video/effects/outlinehaze/bypassed', values: [1] },
        { address: '/composition/layers/9/video/effects/outlinehaze/bypassed', values: [1] },
      ],
    },
    // before 2.2.0: haze only.
    {
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
  ],
};

function wiringKey(t) {
  const step = s => `${s?.address ?? ''}=${Array.isArray(s?.values) ? s.values.join(',') : ''}`;
  return JSON.stringify({
    bases: Array.isArray(t?.colorBases) ? t.colorBases : [],
    on: (Array.isArray(t?.onSteps) ? t.onSteps : []).map(step),
    off: (Array.isArray(t?.offSteps) ? t.offSteps : []).map(step),
  });
}

function withoutLegacyWiring(saved) {
  const legacy = LEGACY_TARGET_WIRINGS[saved.id];
  if (!legacy || !legacy.some(w => wiringKey(w) === wiringKey(saved))) return saved;
  const { colorBases, onSteps, offSteps, ...rest } = saved;
  return rest; // the default of that id fills the wiring back in
}

// A target the operator adds by hand starts blank: the editor opens on an
// empty form, not on a copy of another target's addresses.
function blankTarget() {
  return { id: '', label: '', swatch: '#8e9299', colorBases: [], onSteps: [], offSteps: [] };
}

// The saved list is the list. Built-ins the operator deleted in the editor
// stay deleted, the ones they kept are filled in from the default of that
// id (so a field added later is never missing), and hand-added ones are
// kept as they are. Earlier versions unioned the defaults back in on every
// load, which made deleting MORPH 1 / MORPH 2 impossible — they returned on
// the next launch. A missing or empty list means the defaults: the picker
// always needs somewhere to send.
function mergeColorTargets(base, patch) {
  if (!isPlainObject(patch) || !Array.isArray(patch.items)) return base;
  const byId = new Map(base.items.map(d => [d.id, d]));
  const items = [];
  const seen = new Set();
  for (const saved of patch.items) {
    if (!isPlainObject(saved) || !saved.id || seen.has(saved.id)) continue;
    seen.add(saved.id);
    const def = byId.get(saved.id);
    items.push(def ? deepMerge(def, withoutLegacyWiring(saved)) : deepMerge(blankTarget(), saved));
  }
  if (!items.length) return base;
  const active = items.some(x => x.id === patch.active) ? patch.active : items[0].id;
  return { active, items };
}

function mergeConfig(base, patch) {
  if (!isPlainObject(patch)) patch = {};
  return {
    ...base,
    version: base.version,
    network: deepMerge(base.network, isPlainObject(patch.network) ? patch.network : {}),
    ui: deepMerge(base.ui, isPlainObject(patch.ui) ? patch.ui : {}),
    updates: deepMerge(base.updates, isPlainObject(patch.updates) ? patch.updates : {}),
    triggers: deepMerge(base.triggers, isPlainObject(patch.triggers) ? patch.triggers : {}),
    colorTargets: mergeColorTargets(base.colorTargets, patch.colorTargets),
    colorMorph: deepMerge(base.colorMorph, isPlainObject(patch.colorMorph) ? patch.colorMorph : {}),
    sticks: deepMerge(base.sticks, isPlainObject(patch.sticks) ? patch.sticks : {}),
    haptics: deepMerge(base.haptics, isPlainObject(patch.haptics) ? patch.haptics : {}),
    beat: deepMerge(base.beat, isPlainObject(patch.beat) ? patch.beat : {}),
    fxButtons: mergeControls(base.fxButtons, patch.fxButtons),
    fxButtons2: mergeControls(base.fxButtons2, patch.fxButtons2),
    fxButtons3: mergeControls(base.fxButtons3, patch.fxButtons3),
    utilButtons: mergeControls(base.utilButtons, patch.utilButtons, true),
    faders: mergeControls(base.faders, patch.faders),
    groupFaders: mergeControls(base.groupFaders, patch.groupFaders),
    colorButtons: mergeControls(base.colorButtons, patch.colorButtons),
  };
}

// Tolerant merge of an arbitrary (possibly partial or foreign) config object
// onto fresh defaults — used by config:import so a hand-edited or old-version
// file can't corrupt or crash the app. Never throws: non-object / garbage
// input just yields the defaults untouched.
function merge(parsed) {
  return mergeConfig(defaults(), parsed);
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

module.exports = { defaults, load, save, merge, ACCENTS };
