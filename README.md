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
    (8 one-shot punches, two of them left free for whatever comes up).
  - **Page 2** — 8 ramp buttons (hold to sweep an effect in, release to drop
    it), big Tap Tempo / Resync buttons, and 6 horizontal group-master faders.
  - **DJ Intro** — a 24-slot clip grid built dynamically from the live
    composition (**Sync from Resolume** reads the name-source layer and
    targets its group's columns); customized slots survive syncs. The sync
    **cross-checks the group**: if the name plate says COOKY at column 3 but
    the DJ booth layer plays a different artist's clip there, it reports the
    mismatch instead of copying it onto a button, and slots that lost their
    clip are cleared rather than left showing a stale name.
  - **Colors** — advanced picker (hue strip + saturation/value pad, throttled
    live sends), 16 quick swatches, and a ColorMorph strip: Color 1 / Color 3
    wells, SPEED slider, MORPH on/off with OSC feedback. Drives the same
    switchable targets as the main color row (BG / LOGO / FLASH / MORPH 1 /
    MORPH 2).
  - **BPM page (mic analyser)** — a realtime tempo analyser built natively
    on Web Audio (no Python, no ML): pick an input device from a full list
    panel (not a native `<select>`, which cut long device names off inside a
    fixed-width box), Start/Stop
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
- **Utility strip** — a row of small latching toggles across the bottom of the
  surface, on every page: keep-greys, haze, distortion, auto-VJ, and the SLICE
  STROBE parameters (mode, edge, symmetric, slice-o-rama, visual). They are
  ordinary configurable controls, so anything on them can be re-pointed from the
  editor, and the row simply gets longer if you add more — the config may hold
  more of them than the defaults do. The remote API (`/rogger/util/{index}`),
  the gamepad bindings and the grandMA3 DMX map all address the same list.
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

- **Network** — OSC target IP/port, listen port, auto connect/reconnect, and
  **Test connection**, which checks the three legs of the Resolume link
  separately (see below).
- **Controller** — LT/RT analog trigger mapping (address, from/to, release,
  optional engage message), LS/RS stick mapping (address, center, scale),
  and haptics (press ticks, strobe rumble).
- **Pages** — show/hide every page except Page 1; hidden pages drop their
  tab immediately. Covers any page added later automatically.
- **Updates** — over-the-air updates (see below): running version and
  source (BUNDLED / OTA), auto-check toggle, **Check now**, release notes,
  download with progress, **Restart** to apply, and a **Remove updates,
  run the bundled version** escape hatch.
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

## Updates (over the air)

The packaged exe is a thin **shell** around a swappable **payload** — the
whole app (`src/` + `configs/`) as a ~80 KB tarball. An update downloads the
payload, not an 85 MB reinstall, so it takes a second on a venue's Wi-Fi and
needs no installer, no UAC prompt and no admin rights.

- **Checking** is automatic on launch (Settings → Updates turns it off).
  **Downloading and restarting are always an explicit tap** — nothing swaps
  code under a running show, and a restart while the OSC lamp reads LIVE asks
  for confirmation first.
- Every payload is verified against the **sha256** in its release manifest
  before it is unpacked, extracted into a staging directory, checked for
  bootability, and only then renamed into place. A failed or truncated
  download leaves nothing behind.
- An installed payload takes effect **on the next launch**, never mid-session.
- **Rollback is automatic.** A payload that fails to load is blacklisted and
  the previous one (ultimately the bundled copy) boots instead — in the same
  launch if it fails outright, after two failed starts if it comes up broken.
  The Updates tab says when this has happened.
- **Safe mode** forces the bundled payload: launch with `--safe`, or set
  `ROGGER_SAFE=1`.
- Some releases change the Electron shell itself (a `minShell` bump). Those
  cannot be applied over the air; the app says so and links to the release.

Payloads live in `%APPDATA%/ROGGER/payloads/<version>/`, with the boot state
(active version, crash counter, blacklist) in `payloads/state.json`.

### Cutting a release

```bash
npm version minor          # or patch/major
npm run release            # tests + payload bundle + Windows exe
gh release create v<version> \
  "dist/ROGGER-<version>.exe" \
  "dist-payload/rogger-payload-<version>.tar.gz" \
  "dist-payload/rogger-payload-<version>.json" \
  --title "ROGGER <version>" --notes "..."
```

The app looks for exactly `rogger-payload-<version>.tar.gz` and
`rogger-payload-<version>.json` on the **latest** release, and matches the
manifest's version against the release tag. A release without those assets is
reported as a download rather than an over-the-air update. Bump
`rogger.minShell` in `package.json` when a payload starts depending on
something only a newer exe provides.

## When nothing lights up: the three-leg link test

The Resolume link is three independent connections, and each fails on its own:

| Leg | What it carries | Fails when |
|---|---|---|
| Webserver (9292) | DJ sync, BPM seed, this test | the webserver is off |
| ROGGER → Resolume | every button and fader you touch | OSC Input is off / wrong port |
| Resolume → ROGGER | **lamps, latches, feedback, Auto BPM** | OSC **Output** is off or aimed at the wrong machine |

The third one is the dangerous one. Everything still *works* — buttons fire,
faders move Resolume — but nothing on the surface lights up, no toggle latches
from the desk, and Auto BPM never follows. Resolume's OSC output targets one
fixed IP address, so it breaks the moment the console moves to another machine
or the venue hands you a different network, and nothing tells you why.

**Settings → Network → Test connection** reports each leg with its own verdict.
It nudges a parameter that is already at zero (invisible) and restores it, so it
is safe to run mid-set. When feedback is dead it prints the exact line to type:

```
✕  Resolume → ROGGER (feedback)
   Nothing arrived on port 7001. Buttons will still fire, but nothing on the
   surface will light up from Resolume, and Auto BPM will not follow.
   FIX: Resolume → Preferences → OSC → Output: enable it and set the target
        to 192.168.1.254:7001.
```

That address is read from the machine ROGGER is running on, so running the test
**on the console at the venue** tells you what to type into Resolume there.

## Checking the config against the show

Two tools answer "will every button do something tomorrow", against the
composition that is actually open:

```bash
npm run verify:config    # every OSC address in the config resolves to something
npm run check:live       # fire each control and read the parameter back
npm run check:live -- --fire   # ...including clips and clears (output dark!)
```

`verify:config` walks every address on every button, fader, colour preset and
colour target and resolves it against the live composition over the REST API.
It reports addresses that point at nothing, clips that are empty, effects the
composition does not have, and **content triggers wearing an FX button's
clothes** — a DJ logo clip sitting in the FX bank is the exact mistake it was
written to catch. It also lists effects the composition offers that no control
reaches.

It then asks the harder question: *would anyone see it?* A button that drives a
real parameter on a **bypassed** effect, or on a group or layer whose master is
at zero, does exactly nothing on the screens while looking perfectly healthy.
Those are reported as silent controls — unless some other control on the surface
un-bypasses that effect itself, which is how the HAZE, DISTORT and MORPH toggles
are meant to work.

`check:live` proves the whole path: ROGGER's OSC codec, the network, Resolume's
OSC input, the actual parameter. Every parameter is read, driven somewhere it
was not, verified and **restored to the value it had** — safe to run mid-set.
Clip triggers, clears and momentary events change what is on the screens, so
they are skipped unless you pass `--fire`; with it, each clip is connected,
confirmed, and the previously connected clip is put back.

Both need Resolume's webserver on port 9292 and OSC input on the configured
port.

## Resolume setup

1. Preferences → OSC: enable **OSC Input** (this composition uses port 7432).
2. For learn / feedback / LIVE lamp / auto-BPM: enable **OSC Output**,
   target = the controller device's IP, port **7001**.
3. For the DJ-page sync and BPM seeding: enable the **Webserver** (port 9292).
4. Composition Transform (pan/zoom/rotate) targets `/composition/video/effects/transform/<param>`
   on Resolume Arena 7.26+ (no `/effect/` segment — older builds used the
   `.../transform/effect/<param>` form; ROGGER's grandMA3 DMX preset fans out to both).

## Screen size and why nothing adapts

The surface is deliberately **not** responsive. Menus, tabs, readouts, buttons
and fader labels are sized to their longest label and keep that size, font and
decoration at every window size — a control that renames, shrinks or drops its
glyph under your thumb mid-show is worse than one that needs a bigger window.

The price is a hard floor: **1704 x 1035**, declared in `src/window-size.js` and
enforced as the Electron window's `minWidth`/`minHeight`. The ASUS ROG Ally X
runs 1920x1080, comfortably above it.

Three guards keep that honest, because the floor moves whenever a fixed label
gets longer:

```bash
npm run audit:layout               # the authority: inside the real app
node tools/measure-min-window.js   # what the surface needs, measured in a browser
node test/ui/min-window.spec.mjs   # every page and overlay at the floor and at 1920x1080
```

**`npm run audit:layout` is the one that decides.** It walks every page and
settings tab inside the running Electron app and reports any text that does not
fit its box. The two browser-based checks are fast pre-flights, but they cannot
see two things that decide whether a label fits: Electron resolves a different
font than headless Chromium, and font metrics are what make text fit or not;
and the window frame eats into the content box. Both bit at once — every browser
check said the layout was clean while the Page 2 FX labels were clipped by 4px
in the real app, because a 1000px window was giving the surface 968px.

That second one is fixed for good: the window is created with
`useContentSize: true`, so `minWidth`/`minHeight` mean the surface, not the
frame around it. The window cannot be dragged below the floor, so the layout
can never be squeezed at all.

If a new label pushes the natural minimum past the declared floor, these fail —
raise the numbers in `src/window-size.js` on purpose rather than letting the
layout quietly start truncating.

Only genuinely dynamic text clamps: FX button labels carry Resolume clip names,
which can be 40 characters long and cannot be allowed to set the width of a
24-slot grid. Those wrap to two lines and then ellipsize.

## Development (any OS)

```bash
npm install
npm test            # codec / config / engine / bpm / combos / library / tarball /
                    #   payload-resolve / updater / dj-sync / diagnostics tests
npm start           # run the app under Electron (config.dev.json)
node test/serve.js  # browser mode with a mock OSC bridge on :5199
node test/ui/combos.spec.mjs          # Playwright UI checks (spawn their own server
node test/ui/editor-settings.spec.mjs #   where needed; bpm-page.spec.mjs expects
node test/ui/updates.spec.mjs         #   test/serve.js to be running)
node test/ui/min-window.spec.mjs
node test/ui/bpm-page.spec.mjs
python3 tools/test_dmx_tools.py       # DMX map / GDTF / Resolume preset checks
npm run audit:layout # layout check inside the real app (the authority)
npm run payload     # build the OTA payload bundle + manifest into dist-payload/
npm run ma3         # regenerate the grandMA3 GDTF, Resolume preset and LD sheet
```

`ROGGER_SMOKE=1 npm start` boots, prints which payload it resolved, and exits —
handy for checking the shell/payload split without a display.

## Building the Windows exe

```bash
npm run dist:win    # emits dist/ROGGER-<version>.exe (portable, unsigned)
```

The bundled show config (`configs/campus-forum-stage.json`) seeds the user
config on first launch; **Settings → Reload default mapping** restores it any
time. Config lives at `%APPDATA%/ROGGER/config.json` (packaged).

## grandMA3 handoff (DMX / Art-Net)

The tested ROGGER functions are also published as a **DMX fixture** so a
lighting designer can drive Resolume from a grandMA3 desk without ROGGER in
the loop — `npm run ma3` regenerates everything from the show config:

- `dist-ma3/ROGGER@Resolume Remote@v2.gdtf` — GDTF 1.2 fixture, one 98-channel
  mode (master + layer/group levels, flash/bump/util, 5 RGB colour
  sub-fixtures, FX ramps, logo, DJ names, tempo, transform). Copy it into
  `gma3_library/fixturetypes/` and import it in Patch.
- `dist-ma3/ROGGER_MA3.xml` — the matching Resolume **DMX shortcut preset**
  (`tools/install-resolume-preset.sh` copies it into `Shortcuts/DMX/`; the
  composition remembers its preset, so pick `ROGGER_MA3` once in
  Shortcuts → Edit DMX and save the composition, or pass `--composition`).
- `docs/ma3-handoff.html` — the cheat sheet for the LD (patch, network,
  channel table, semantics). Send it with the files.
- `tools/artnet-send.js` — zero-dependency Art-Net sender for bench tests
  (`node tools/artnet-send.js --host <resolume-ip> --set 16=255 --seconds 2`).
- `tools/dmx_map.py` is the single source of truth for the channel map;
  `python3 tools/test_dmx_tools.py` checks map, GDTF and preset.

Verified live (2026-08-22) on Resolume Arena 7.26: range, momentary
(piano hold/release), bool, choice, colour and layer-clear channels all
follow incoming Art-Net.

## Architecture

The exe is a shell around a replaceable payload:

```
src/bootstrap.js        SHELL — picks a payload, guards against crash loops
src/payload-resolve.js  SHELL — pure resolution logic (which payload, rollback)
src/payload-store.js    SHELL — payload directory + boot state on disk
  └─ starts <payload>/src/main/main.js  →  everything below is updatable
```

- `src/main/osc.js` — dependency-free OSC 1.0 codec (i/f/s, bundles).
- `src/main/osc-engine.js` — UDP send/receive, learn, status, reconnect.
- `src/main/config-store.js` — schema defaults, tolerant merge, atomic save.
- `src/main/ipc.js` — bridge handlers incl. REST-backed DJ sync / BPM seed,
  config export/import, update check/download.
- `src/main/updater.js` — GitHub release check, sha256-verified payload
  download and staged install.
- `src/main/tarball.js` — deterministic USTAR tar + gzip (pack and unpack)
  with path-traversal and size guards; shared with `tools/build-payload.js`.
- `src/main/dj-sync.js` — pure rebuild of the DJ page from a composition,
  including the group cross-check and stale-slot clearing.
- `src/main/diagnostics.js` — the three-leg link test, including picking a
  parameter that can be nudged without anyone seeing it.
- `src/window-size.js` — the declared window floor (see above).
- `src/renderer/` — zero-dependency vanilla JS/CSS; runs in a plain browser
  via a mock bridge for the Playwright checks in `test/ui/`.
  - `js/bpm/` — Web Audio BPM analyser (pure DSP core + worklet + page).
  - `js/gamepad.js` + `js/gamepad-resolve.js` — controller polling and the
    pure combo/modifier resolver.
  - `js/remote-api.js` — the inbound `/rogger/*` OSC vocabulary.
  - `js/updates.js` — the Updates panel and the quiet check at launch.
  - `js/dom.js` — shared overlay builders used by the editor and settings,
    plus the full-panel list picker used where a native `<select>` would
    mangle long system text.
- `tools/` — generators for the grandMA3 GDTF, the Resolume DMX preset, the
  LD/APC40 cheat sheets, the OTA payload bundler, the config verifier and live
  round-trip checker, plus the Art-Net test sender.

Design and plan documents live in `docs/superpowers/`.

## Contributing

Contributions are very welcome — this project is actively developed and there
is plenty of room to grow. Good places to jump in:

- **New button behaviors / OSC targets** — the command library and button
  editor are designed to be extended.
- **Beat detection** — the Web Audio BPM core is pure JS with synthetic-audio
  tests; better onset/tempo tracking is welcome.
- **grandMA3 / DMX** — more channels in `tools/dmx_map.py`, other desks.
- **Hardware surfaces** — mappings beyond the APC40 mkII, other handhelds and
  touch devices.
- **Updates** — the payload/shell split is deliberately small; delta payloads,
  release channels and update mirrors are all open ground.
- **Docs, tests, bug reports** — always appreciated.

Workflow: fork → branch → `npm test` (and `node test/serve.js` for UI checks)
→ pull request. Open an issue first for bigger ideas so we can talk design.
No build step, no framework — if you know plain JavaScript, you can hack on
ROGGER.

## License

[MIT](LICENSE)
