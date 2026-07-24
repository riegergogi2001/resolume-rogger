# ROGGER

A professional touchscreen OSC performance controller, optimized for the
ASUS ROG Ally X (Windows 11, 7" 1920x1080 multitouch, landscape). ROGGER is
not a Resolume mirror — it is a customizable live surface in the spirit of
grandMA3 / Luminex / Stream Deck hardware that drives Resolume Arena/Avenue or
any OSC-compatible software over Wi-Fi.

## Features

- **16 FX trigger buttons in two banks** — 8 **FLASH** (momentary: on while
  held, off on release, flashes while pressed) and 8 **BUMP** (one-shot
  triggers). Every button remains fully editable: tap/toggle/hold modes,
  auto-repeat, icon, label, color, OSC address, int/float/command value type,
  multi-message macros.
- **Built-in controller support** — every FX button can be bound to the ROG
  Ally X's Xbox-style gamepad buttons (badge shown on the tile). Defaults:
  A/B/X/Y/LB/RB/LT/RT fire FLASH 1–8, D-pad/LS/RS/VIEW/MENU fire BUMP 1–8.
  Rebind in the editor with the button grid or **Gamepad Learn** (press a
  controller button to bind). Controller presses light the on-screen button.
- **6 multitouch faders** — smooth 60 fps float sends, min/max range, default
  value (double-tap to reset), invert, sensitivity (1 = absolute touch,
  <1 = fine relative control). Fader 5 defaults to the **LOGO** layer
  (layer 4 opacity). All faders and buttons track independent fingers.
- **Bidirectional feedback** — with Resolume's OSC output enabled, moving a
  fader inside Resolume moves the matching ROGGER fader (touch always wins
  while your finger is on it; no echo loops).
- **10 color preset buttons** — one tap fires an assigned OSC command
  (defaults target clips on layer 5, the usual "color solids" layer).
- **Connection status lamp** — OFFLINE / READY (sending blind) / LIVE (heard
  traffic back in the last 5 s). UDP has no handshake; the lamp never lies.
- **Settings** — target IP/port, listen port, auto connect, auto reconnect,
  test connection, save. Dark theme always.
- **Button editor** — toggle EDIT, tap any control. Includes a curated
  Resolume 7 OSC command library and **OSC Learn**: arm it, wiggle a control
  in Resolume, and the address lands in the field with one tap.

## Resolume setup

1. Resolume → Preferences → OSC: enable **OSC Input**, port **7000**.
2. For OSC Learn, fader feedback and the LIVE lamp, also enable
   **OSC Output**, target = your Ally's IP, port **7001**.
3. In ROGGER settings, set the target IP to the Resolume machine's IP.
   Both devices must be on the same network.

## Development (any OS)

```bash
npm install
npm test          # codec / config / engine unit + integration tests
npm start         # run the app under Electron
node test/serve.js  # then open http://127.0.0.1:5199 — browser mode with mock OSC
```

## Building the Windows exe

```bash
npm run dist:win  # emits dist/ROGGER-<version>.exe (portable, unsigned)
```

Works from macOS/Linux/Windows. Copy the exe to the Ally and run it — it is
fully standalone. Windows SmartScreen will warn on first run (unsigned);
choose "More info → Run anyway".

## Configuration

Stored as JSON at `%APPDATA%/ROGGER/config.json` (packaged) or
`./config.dev.json` (development). Corrupt files are backed up as
`config.json.bad` and regenerated. Delete the file to restore defaults.

## Architecture

- `src/main/osc.js` — dependency-free OSC 1.0 codec (i/f/s, bundles).
- `src/main/osc-engine.js` — UDP send/receive, learn mode, status, reconnect.
- `src/main/config-store.js` — defaults, tolerant merge, atomic save.
- `src/main/main.js` + `src/preload.js` — Electron shell and the only bridge
  between UI and network.
- `src/renderer/` — zero-dependency vanilla JS/CSS surface; runs in a plain
  browser via a mock bridge for testing.

Design and plan documents live in `docs/superpowers/`.
