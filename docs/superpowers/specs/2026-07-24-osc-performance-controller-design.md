# ROGGER — OSC Performance Controller: Design

Date: 2026-07-24
Status: Approved for implementation (autonomous /goal session; spec supplied in full by user)

## Purpose

A professional touchscreen OSC performance controller for the ASUS ROG Ally X
(Windows 11, 7" 1920x1080 multitouch, landscape). It controls Resolume or any
OSC-compatible software over Wi-Fi. It is NOT a Resolume mirror — it is a
customizable live surface with assignable buttons and faders, styled after
grandMA3 / Luminex / Stream Deck hardware.

## Stack decision

**Electron + vanilla JS/HTML/CSS, zero runtime npm dependencies.**

- Dev machine is macOS, target is Windows: Electron is the only stack that can
  be fully developed and tested here and cross-packaged into a standalone
  unsigned Windows `.exe` (electron-builder `portable` target).
- OSC is UDP; Node's `dgram` in the main process handles send and receive
  (receive is required for OSC Learn and connection feedback).
- OSC 1.0 encode/decode is implemented by hand (~150 lines, pure functions,
  unit-testable) instead of pulling the `osc` package and its optional
  serialport chain. Zero runtime deps → fast startup, small surface.
- No UI framework, no bundler. Fixed-layout performance surface in CSS grid.
  Startup budget < 2s is trivially met.

Rejected: Tauri (Windows cross-compile from macOS is experimental — risks not
delivering the .exe pipeline), C#/WinUI (cannot build or test on macOS).

## Architecture

```
src/
  main/
    main.js          Electron entry: window, lifecycle, wiring
    osc.js           OSC 1.0 encode/decode (pure, no I/O)
    osc-engine.js    UDP sockets, send, receive, learn mode, status, test
    config-store.js  JSON config load/save (atomic), defaults, migration
    ipc.js           ipcMain handlers <-> engine/store
  preload.js         contextBridge: window.rogger API
  renderer/
    index.html
    css/  theme.css, layout.css, components.css
    js/   bridge.js (real or mock bridge), state.js, app.js,
          fx-grid.js, faders.js, color-row.js, topbar.js,
          settings.js, editor.js, osc-library.js
docs/superpowers/specs/   design + plan
test/                     node:test unit + integration tests
```

Module boundaries: `osc.js` is pure data <-> bytes. `osc-engine.js` owns
sockets and emits events; it never touches config persistence. `config-store.js`
owns the JSON file only. Renderer talks exclusively through the preload bridge;
`bridge.js` installs a mock when `window.rogger` is absent so the renderer runs
in a plain browser for UI testing (Playwright) and design work.

### Data flow

- Control touched → renderer builds OSC intent → `rogger.send(address, args)`
  → ipc → engine encodes + UDP send. Fire-and-forget, no round trip needed.
- Faders throttle sends to one per animation frame with change detection.
- Incoming UDP → engine decodes → status "receiving" + (if learn armed)
  `learn-message` event → editor fills address/value with one tap.

### Connection status (honest UDP semantics)

UDP is connectionless, so status is best-effort and truthful:
- **OFFLINE** (grey): no target configured / sockets closed.
- **READY** (amber): target configured, sending blind, nothing heard back.
- **LIVE** (green): a packet was received from the network in the last 5s
  (Resolume with OSC output enabled replies to queries; any inbound counts).
- **Test Connection** sends `/composition/name` query and reports whether a
  reply arrived within 1.5s, with clear wording either way.
- Auto reconnect = recreate sockets on error/interface change; auto connect =
  open sockets on launch.

## Configuration model

Single JSON at `app.getPath('userData')/config.json` (dev fallback:
`./config.dev.json`). Atomic write (tmp + rename). Shape:

```json
{
  "version": 1,
  "network": { "targetIp": "192.168.1.100", "targetPort": 7000,
               "listenPort": 7001, "autoConnect": true, "autoReconnect": true },
  "ui": { "theme": "dark" },
  "fxButtons": [ /* 16 */ ],
  "faders":    [ /* 6  */ ],
  "colorButtons": [ /* 10 */ ]
}
```

FX button: `{ id, label, icon, color, mode: "tap"|"toggle"|"hold",
type: "command"|"float"|"int", address, value, offValue, releaseValue,
repeat: {enabled, intervalMs}, macro: [{address, args}] }`.
Fader: `{ id, label, color, address, min, max, defaultValue, invert,
sensitivity }`. Color button: `{ id, label, color, address, args }` (or macro).

## Main screen (landscape 16:9)

- Top bar (slim): app name, target `ip:port`, status lamp (OFFLINE/READY/LIVE),
  EDIT toggle, settings gear. Gear/EDIT are the only small-ish controls and are
  still >= 48px.
- Left: 4x4 grid of 16 FX buttons (largest targets, >= 96px).
- Right: 6 vertical faders, full panel height, fat 64px+ touch tracks,
  value readout, double-tap resets to default.
- Bottom strip: 10 color preset buttons (swatch + label).
- All controls give instant visual feedback (<1 frame): pressed state, toggle
  latched state, hold flash animation, fader thumb glow.

Behavior per FX mode: **tap** sends on pointerdown; **toggle** alternates
value/offValue and latches visually; **hold** sends value on down and
releaseValue on up, flashing while held; **repeat** (optional, any mode)
resends every `intervalMs` while held. Macro sends each message in order.

Faders: pointer capture per-fader (true multitouch — several faders + buttons
at once), absolute tracking scaled by `sensitivity` (1 = 1:1; <1 = finer),
`invert` flips direction, output mapped to [min,max] as float.

## Settings page (overlay)

Target IP, port, listen port, auto connect, auto reconnect, Test Connection
(with result), Save, dark theme confirmation. Big inputs, on-screen friendly.

## Button editor

EDIT toggle on → tapping any control opens the editor overlay for it instead of
firing. Edits: label, icon (curated emoji/glyph set), color (palette), mode,
value type, OSC address, values (on/off/release), repeat, macro list.
Two assist features:
- **OSC command library**: curated Resolume 7 addresses (composition/layer/clip
  triggers, master/layer opacity, speed, crossfader, tempo tap/resync, column
  connect, effect params) + free-form custom address entry.
- **OSC Learn**: arm from the editor; first incoming OSC message fills address
  (and value) with one tap. Requires the target app's OSC output pointed at
  this device's listen port; the editor says so inline.

## Visual design

grandMA3/Luminex-inspired: near-black `#0a0b0d` base, panel `#131519`,
1px `#23262c` bevels, high-contrast type (Inter/system, uppercase labels,
tabular numerals for values), one accent per control from a fixed professional
palette, subtle 120ms ease-out transitions, pressed = brighten + inner glow.
No hover-dependent affordances (touch-first). No control under 48px; primary
controls >= 96px.

## Error handling

- Socket errors → status OFFLINE + non-blocking toast; auto-reconnect retries
  with backoff when enabled.
- Malformed inbound OSC → dropped silently (counted in a debug counter).
- Config read failure → back up bad file, regenerate defaults, toast.
- Renderer never throws on missing bridge (mock fallback).

## Testing

- `node --test`: osc.js encode/decode round-trips (int/float/string, padding,
  bundles), config-store defaults/merge/atomic write, engine send bytes
  asserted via a loopback `dgram` listener; learn event from injected packet.
- Playwright (browser + mock bridge): layout renders 16/6/10 controls, tap
  fires send with right address, toggle latches, fader drag emits values,
  editor round-trip edits config, settings save.
- Manual/packaging: `npm start` on macOS; `npm run dist:win` produces
  `ROGGER-portable.exe` (unsigned) via electron-builder.

## Out of scope now (future hooks kept cheap)

MIDI note/CC (schema fields reserved), bidirectional feedback beyond status
lamp, Art-Net/sACN, Companion, plugins, auto-update. The engine's receive path
and per-control schema are designed so these bolt on without rework.

## Success criteria

Feels like dedicated show hardware: every control responds within one frame,
OSC reaches Resolume reliably over Wi-Fi, setup (edit/learn/library) needs no
manual, app cold-starts < 2s, packages to a standalone Windows .exe.
