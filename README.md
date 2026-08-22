# ROGGER

**Touchscreen OSC performance controller for Resolume.**

A professional touchscreen OSC performance controller, optimized for the
ASUS ROG Ally X (Windows 11, 7" 1920x1080 multitouch, landscape). ROGGER is
not a Resolume mirror — it is a customizable live surface in the spirit of
grandMA3 / Luminex / Stream Deck hardware that drives Resolume Arena/Avenue or
any OSC-compatible software over Wi-Fi.

Zero runtime dependencies (vanilla JS/CSS + Electron) and a hand-rolled OSC
1.0 codec, with stage-safe guardrails everywhere.

## Surface

- **Five pages** with tabs:
  - **Page 1** — FLASH bank (8 momentary punch buttons) and BUMP bank
    (a 2x2 utility quad — small toggles like keep-greys / haze / CO2 /
    auto-VJ — plus 7 one-shot punches).
  - **Page 2** — 8 ramp buttons (hold to sweep an effect in, release to drop
    it), big Tap Tempo / Resync buttons, and 6 horizontal group-master faders.
  - **DJ Intro** — a 24-slot clip grid built dynamically from the live
    composition (**Sync from Resolume** reads the name-source layer and
    targets its group's columns); customized slots survive syncs.
  - **Colors** — advanced picker (hue strip + saturation/value pad, throttled
    live sends), 16 quick swatches, and a ColorMorph strip: Color 1 / Color 3
    wells, SPEED slider, MORPH on/off with OSC feedback. Drives the same
    switchable targets as the main color row (BG / LOGO / FLASH / MORPH 1 /
    MORPH 2).
  - **BPM page (mic analyser)** — a realtime tempo analyser built natively
    on Web Audio (no Python, no ML): pick an input device, Start/Stop
    capture, a vertical level meter, LOCK (freezes the reported bpm) with
    ÷2/×2 scaling, "Send Tempo to Resolume" (throttled `tempocontroller/tempo`
    once confidence is high enough), and "Resync on Next Beat" (fires
    `tempocontroller/resync` right on the predicted beat). The big readout
    shows bpm + confidence + a beat-pulse dot, backed by a canvas scrolling
    the onset envelope with predicted-beat ticks. The DSP — FFT, spectral
    flux, autocorrelation tempo estimate with octave-error guarding — lives
    in `src/renderer/js/bpm/bpm-core.js` and is unit-tested with synthetic
    audio in `test/bpm-core.test.js`.
  - The APC40 mkII mapping cheat sheet ships as a standalone shareable page,
    `docs/apc40-mapping.html` (regenerate after remapping with
    `python3 tools/gen-akai-map.py`) — send it along with the composition.
- **8 main faders** — vertical MASTER + layer masters + logo, horizontal
  utility strips (multi-target fan-out, e.g. both pushers' fade-out from one
  fader). Double-tap resets; invert/sensitivity/min/max per fader; ♪ beat
  button and optional auto beat-follow (value = bpm / bpmAt1).
- **10 color presets + target switch** — the small squares at the row's end
  choose what the picker paints (background colorize / logo outline-haze /
  strobe color / ColorMorph Color 1 / Color 3); OFF fires the target's release
  steps. Feedback lights the matching preset.
- **Topbar** — OSC target, analog-mapping readout, beat clock (BPM + beat ms,
  /2 and x2, a three-way **Tap / Auto / Mic** beat-source toggle — manual
  taps, following Resolume's reported BPM, or the BPM page's mic analyser —
  beat-pulse tinted by the last picked color), battery, clock, tap/resync,
  status lamp (OFFLINE / READY / LIVE — honest UDP semantics), EDIT, settings.

## Controller (built-in Ally X gamepad)

- Any FX button binds to a pad button (editor grid or **Gamepad Learn**);
  bindings show as badges and steal cleanly across pages.
- **LT / RT are analog**: depth maps onto a float param (master duck, strobe
  stomp with engage/release messages), springing back on release.
- **Stick axes** pan / zoom / rotate the composition transform and re-center
  on release. Haptics: press ticks + depth-scaled strobe rumble.
- **Combos** — any pad button can act as a modifier for another: hold it
  down and press a second button to fire a different binding than that
  second button's plain press (e.g. hold RT and tap A for a different FX
  than A alone). Badges show combos as `RT+A`. Set a modifier in the editor's
  "Modifier (hold with)" row below the controller button pick, or arm
  **Gamepad Learn** and press the modifier + target button together — it
  captures both and toasts the combo (e.g. `Bound to RT+A`). A modifier
  button held alone still fires its own plain binding (and, for LT/RT, its
  analog trigger action) — only the second button's action changes. Press
  and release stay paired to the physical button even if the modifier is
  released first.

## Button behaviors

Tap, toggle (latching), hold (piano-style 1/0, optional separate release
address), flash animation, repeat while held (fixed interval or beat-synced),
ramp-while-held (value sweep), multi-message macros (zeroed on release so
clears let go), per-button icon / label / color, OSC learn, command library
(searchable, with a hint per entry — fader editors only offer float-typed
entries), a mirror-to second address on every FX button, and fader mirror
address(es) + beat-sync (value follows the tapped/auto BPM). Color presets
can either fire their own address/macro, or route RGB through whichever
color target is active — plus an OFF preset that fires that target's off
steps. In Edit mode, tapping a target-switch square opens a **COLOR TARGET**
editor (label, swatch, color-base addresses, on/off step macros).

## Settings

The gear icon opens a tabbed Settings panel (scrolls inside the panel body
at both 1920×1080 and 1280×800):

- **Network** — OSC target IP/port, listen port, auto connect/reconnect,
  Test connection.
- **Controller** — LT/RT analog trigger mapping (address, from/to, release,
  optional engage message), LS/RS stick mapping (address, center, scale),
  and haptics (press ticks, strobe rumble).
- **Pages** — show/hide every page except Page 1; hidden pages drop their
  tab immediately. Covers any page added later automatically.
- **Backup** — **Export config…** / **Import config…** (native file
  dialogs; import tolerantly merges onto the built-in defaults, so a
  partial or foreign file can't corrupt or crash the app) and **Reload
  default mapping**.
- **About** — app version, OSC target/listen ports, and the inbound remote
  API cheat sheet (below).

## Remote API

ROGGER also listens for its own tiny inbound OSC vocabulary on the
configured **listen port**, so other gear — a Companion install, a
grandMA3 OSC-out cue, another ROGGER — can press its buttons and move its
faders. Nothing is echoed back.

| Address | Args | Effect |
|---|---|---|
| `/rogger/fx/{page}/{index}` | `i` (1/0) or none | page 1-3, index 1-based. `1` = press, `0` = release, no arg = press + release 120 ms later. |
| `/rogger/util/{index}` | `i` (1/0) or none | same as above, for the Page 1 utility quad. |
| `/rogger/fader/{index}` | `f` (0..1) | sets a main fader (1-based index); out-of-range values are ignored. |
| `/rogger/gfader/{index}` | `f` (0..1) | sets a Page 2 group fader (1-based index). |
| `/rogger/color/{index}` | — | fires a color preset (1-based index). |
| `/rogger/page` | `i` | switches the active page (1-based). |
| `/rogger/tap` | — | tap tempo. |
| `/rogger/resync` | — | resync beat. |

## Resolume setup

1. Preferences → OSC: enable **OSC Input** (this composition uses port 7432).
2. For learn / feedback / LIVE lamp / auto-BPM: enable **OSC Output**,
   target = the controller device's IP, port **7001**.
3. For the DJ-page sync and BPM seeding: enable the **Webserver** (port 9292).
4. Composition Transform (pan/zoom/rotate) targets `/composition/video/effects/transform/<param>`
   on Resolume Arena 7.26+ (no `/effect/` segment — older builds used the
   `.../transform/effect/<param>` form; ROGGER's grandMA3 DMX preset fans out to both).

## Development (any OS)

```bash
npm install
npm test            # codec / config / engine unit + integration tests
npm start           # run the app under Electron (config.dev.json)
node test/serve.js  # browser mode with a mock OSC bridge on :5199
```

## Building the Windows exe

```bash
npm run dist:win    # emits dist/ROGGER-<version>.exe (portable, unsigned)
```

The bundled show config (`configs/campus-forum-stage.json`) seeds the user
config on first launch; **Settings → Reload default mapping** restores it any
time. Config lives at `%APPDATA%/ROGGER/config.json` (packaged).

## Architecture

- `src/main/osc.js` — dependency-free OSC 1.0 codec (i/f/s, bundles).
- `src/main/osc-engine.js` — UDP send/receive, learn, status, reconnect.
- `src/main/config-store.js` — schema defaults, tolerant merge, atomic save.
- `src/main/ipc.js` — bridge handlers incl. REST-backed DJ sync / BPM seed.
- `src/renderer/` — zero-dependency vanilla JS/CSS; runs in a plain browser
  via a mock bridge for the Playwright suite (75+ checks).

Design and plan documents live in `docs/superpowers/`.

## Contributing

Contributions are very welcome — this project is actively developed and there
is plenty of room to grow. Good places to jump in:

- **New button behaviors / OSC targets** — the command library and button
  editor are designed to be extended.
- **Hardware surfaces** — mappings beyond the APC40 mkII, other handhelds and
  touch devices.
- **Docs, tests, bug reports** — always appreciated.

Workflow: fork → branch → `npm test` (and `node test/serve.js` for UI checks)
→ pull request. Open an issue first for bigger ideas so we can talk design.
No build step, no framework — if you know plain JavaScript, you can hack on
ROGGER.

## License

[MIT](LICENSE)
