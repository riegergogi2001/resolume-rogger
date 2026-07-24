# ROGGER OSC Performance Controller — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Ship a touch-first Electron OSC performance controller (16 FX buttons, 6 faders, 10 color presets, settings, button editor, OSC learn) that packages into a standalone Windows portable `.exe`.

**Architecture:** Electron main process owns UDP/OSC (Node `dgram`) and JSON config persistence; a zero-dependency vanilla-JS renderer talks through one preload bridge (`window.rogger`). A mock bridge lets the renderer run in a plain browser for Playwright verification.

**Tech Stack:** Electron (latest stable), electron-builder (portable/nsis win targets), Node `node:test`, Playwright for UI verification. Zero runtime npm dependencies.

Spec: `docs/superpowers/specs/2026-07-24-osc-performance-controller-design.md`

## Global Constraints

- Zero runtime npm dependencies; devDependencies only (electron, electron-builder).
- Node >= 20 semantics; CommonJS in `src/main`, ES modules in renderer `<script type="module">`.
- All touch targets >= 48px; primary controls >= 96px; dark theme only, base `#0a0b0d`.
- Default network: targetPort 7000, listenPort 7001 (Resolume defaults), targetIp `192.168.1.100`.
- Cold start budget < 2s; fader sends throttled to one per animation frame.
- No network calls except user-configured OSC UDP.
- Commit after each green task; conventional-commit style messages.

---

### Task 1: Scaffold + plan commit

**Files:** Create `.gitignore`, rewrite `package.json`, delete stub `index.js`, commit docs.

- [x] `.gitignore`: `node_modules/`, `dist/`, `config.dev.json`, `.idea/`, `*.log`, `test-artifacts/`
- [x] `package.json`: name `rogger`, `"main": "src/main/main.js"`, scripts:
  `"start": "electron ."`, `"test": "node --test test/"`,
  `"dist:win": "electron-builder --win --x64"`, plus `build` config (Task 10 fills details).
- [x] `npm install --save-dev electron electron-builder`
- [x] Commit: `chore: scaffold electron project + design/plan docs`

### Task 2: OSC codec (`src/main/osc.js`, pure)

**Interfaces (Produces):**
- `encodeMessage(address: string, args: Array<{type:'i'|'f'|'s', value:number|string}>) -> Buffer`
- `decodePacket(buf: Buffer) -> Array<{address: string, args: [{type,value}]}>` (flattens bundles; throws on malformed)
- `inferArgs(values: Array<number|string>) -> typed args` (int if Number.isInteger, else float, strings as 's')

**Test first** (`test/osc.test.js`, node:test): round-trip `/composition/layers/1/clips/1/connect` with `[{i:1}]`; float precision to 1e-6; string padding (len 1..5); empty-args message; decode of a hand-built `#bundle` containing two messages; malformed buffer throws.

- [x] Write failing tests → run `npm test` (fails: module missing)
- [x] Implement encode (4-byte padded strings, `,`+typetags, big-endian i/f)
- [x] Implement decode incl. `#bundle` recursion
- [x] `npm test` green → commit `feat: OSC 1.0 codec`

### Task 3: Config store (`src/main/config-store.js`)

**Interfaces (Produces):**
- `defaults() -> config` (deep-fresh object: network{targetIp,targetPort,listenPort,autoConnect,autoReconnect}, ui{theme:'dark'}, fxButtons[16], faders[6], colorButtons[10] — every control fully populated with sensible Resolume defaults)
- `load(filePath) -> config` (missing → defaults; corrupt → backs up `<file>.bad`, returns defaults; partial → deep-merge over defaults, arrays repaired to exact lengths)
- `save(filePath, config) -> void` (tmp file + rename, mkdir -p)

**Tests:** load-missing returns 16/6/10 arrays; save→load round-trip; corrupt JSON produces `.bad` backup + defaults; partial config (only 2 fxButtons) merges to 16 with overrides preserved.

- [x] Failing tests → implement → green → commit `feat: config store with defaults + atomic save`

### Task 4: OSC engine (`src/main/osc-engine.js`)

**Interfaces (Produces):** `class OscEngine extends EventEmitter`
- `configure({targetIp,targetPort,listenPort,autoConnect,autoReconnect})`, `open()`, `close()`
- `send(address, values)` → encode via `inferArgs` and UDP-send; no-throw (emits `'error'`)
- `sendTyped(address, args)`
- `testConnection() -> Promise<{ok:boolean, detail:string}>` (sends `/composition/name`, 1.5s reply window)
- `armLearn()/disarmLearn()`; events: `'status'` (`offline|ready|live`), `'learn'` (`{address,args}`), `'message'`, `'error'`
- LIVE = inbound packet within 5s (timer downgrade to READY); auto-reconnect: on socket error, backoff 0.5s→2s→5s retries while enabled.

**Tests (loopback):** engine.send observed byte-exact by a `dgram` listener on 127.0.0.1; inbound packet flips status ready→live then back after (shortened) window; armLearn emits decoded `{address,args}`; testConnection resolves ok:true when the listener echoes a reply, ok:false on silence.

- [x] Failing tests → implement → green → commit `feat: OSC engine (send/receive/learn/status/test)`

### Task 5: Electron shell (`src/main/main.js`, `src/main/ipc.js`, `src/preload.js`)

**window.rogger API (Produces, all renderer-facing):**
- `getConfig() -> Promise<config>`, `saveConfig(config) -> Promise<void>`
- `send(address, values)` (fire-and-forget `ipcRenderer.send`)
- `applyNetwork(network) -> Promise<void>` (reconfigure + reopen engine)
- `testConnection() -> Promise<{ok,detail}>`
- `armLearn()/disarmLearn()`; `onStatus(cb)`, `onLearn(cb)` (returns unsubscribe)
- `platform: 'electron'`

main.js: single BrowserWindow 1280x800 (min 1024x640), background `#0a0b0d`, `fullscreen: true` when packaged on win32, contextIsolation on, nodeIntegration off, loads `src/renderer/index.html`; engine configured from stored config; `autoConnect && open()`.

- [x] Implement all three files; manual check `npm start` boots on macOS (blank page OK until Task 6); commit `feat: electron shell + preload bridge`

### Task 6: Renderer core (`index.html`, `css/*`, `js/bridge.js`, `js/state.js`, `js/app.js`)

- `bridge.js`: `export const rogger = window.rogger ?? mockBridge()`; mock logs sends to `window.__oscLog` array (Playwright asserts on it) and serves `defaults()`-shaped config from a bundled snapshot.
- `state.js`: holds config, `update(path, value)`, `subscribe(fn)`, debounced `saveConfig`.
- `index.html` + CSS: top bar, 4x4 FX grid (left), 6-fader rack (right), 10-swatch color strip (bottom), overlay roots for settings/editor. grandMA3 palette per spec. CSS grid, `touch-action: none` on controls, `user-select: none`.
- [x] Renders in plain browser with mock bridge; commit `feat: renderer shell + theme`

### Task 7: Main-screen controls (`fx-grid.js`, `faders.js`, `color-row.js`, `topbar.js`)

- FX behaviors: tap=pointerdown send; toggle=latch + value/offValue; hold=value on down / releaseValue on up + `.flashing` CSS anim; repeat=setInterval(intervalMs) while held (cleared on pointerup/cancel); macro=sequential sends; type command/int → `{type:'i'}`, float → `{type:'f'}`.
- Faders: per-fader `setPointerCapture`, drag maps dy to value × sensitivity, invert flag, clamp [min,max], double-tap → defaultValue, rAF-throttled send of float, live readout, thumb glow while active.
- Color row: swatch background = `color`, tap sends `args` (or macro).
- Topbar: status lamp class from `onStatus`, EDIT latch toggling `body.edit-mode`, gear opens settings.
- Edit mode: in `body.edit-mode`, control pointerdown opens editor for `{kind, index}` instead of firing.
- [x] All wired to state + bridge; manual browser check; commit `feat: performance surface controls`

### Task 8: Settings, editor, OSC library, learn (`settings.js`, `editor.js`, `osc-library.js`)

- Settings overlay: targetIp, targetPort, listenPort (number inputs, big), autoConnect/autoReconnect toggles, Test Connection button with inline result, Save (persists + `applyNetwork`), Close.
- `osc-library.js`: `LIBRARY = [{group, label, address, argHint}]` — Resolume 7 set: clip connect `/composition/layers/{L}/clips/{C}/connect`, column `/composition/columns/{N}/connect`, disconnect-all `/composition/disconnectall`, master `/composition/master`, speed `/composition/speed`, crossfader `/composition/crossfader/phase`, tempo tap `/composition/tempocontroller/tempotap`, resync `/composition/tempocontroller/resync`, layer opacity `/composition/layers/{L}/video/opacity`, layer bypass `/composition/layers/{L}/bypassed`, layer solo `/composition/layers/{L}/solo`, layer clear `/composition/layers/{L}/clear`, selected-clip effect opacity `/composition/selectedclip/video/effects/{FX}/opacity` (+ template expansion prompts for {L}/{C}/{N}).
- Editor overlay: context-sensitive per control kind; fields label, icon picker (curated glyph set), color palette (fixed accents), mode segmented control, value type, address (free text + "Library" browser), value/offValue/releaseValue, repeat toggle+interval, macro row list (add/remove rows), fader-specific min/max/default/invert/sensitivity; LEARN button arms engine, inbound fills address+value, disarm on close; Save → state.update + persist; Cancel discards.
- [x] Commit `feat: settings, button editor, OSC library, learn mode`

### Task 9: Playwright verification (browser + mock bridge)

- Serve `src/renderer` via tiny `test/serve.js` static server (`node:http`).
- Assert: 16 FX buttons, 6 faders, 10 color buttons render; tapping FX 1 appends its configured address to `__oscLog`; toggle latches class; fader drag appends float sends within [min,max]; EDIT+tap opens editor; settings save round-trips into state.
- Screenshots to `test-artifacts/` for the final report.
- [x] All assertions pass; commit `test: playwright UI verification`

### Task 10: Packaging + README

- `package.json` `build`: appId `hu.rogger.controller`, productName `ROGGER`, `files: ["src/**/*"]`, `win: { target: ["portable"] }`, `portable: { artifactName: "ROGGER-${version}.exe" }`.
- [x] Run `npm run dist:win` on macOS (electron-builder cross-packages unsigned portable exe). If toolchain blocks, document exact Windows-side one-liner instead — but attempt first.
- [x] `README.md`: what it is, Resolume OSC setup (enable OSC in/out, ports 7000/7001, point output at Ally's IP), dev commands, build commands, config location.
- [x] Final commit `feat: windows packaging + docs`, mark plan checkboxes.

## Self-review

- Spec coverage: every spec section maps to a task (codec→2, config→3, engine/status/test/learn→4, shell→5, layout/theme→6, FX/fader/color/topbar behaviors→7, settings/editor/library/learn UI→8, testing→9, exe+docs→10). Future features intentionally out of scope per spec.
- No placeholders: interfaces are exact; test lists are concrete behaviors. Executor holds full design context in-session.
- Type consistency: `send(address, values)` (bare values, engine infers) vs `sendTyped(address, args)` used consistently in Tasks 4–8; config field names match Task 3 defaults throughout.
