# ROGGER

**Touchscreen OSC performance controller for Resolume — with an AI VJ brain.**

A professional touchscreen OSC performance controller, optimized for the
ASUS ROG Ally X (Windows 11, 7" 1920x1080 multitouch, landscape). ROGGER is
not a Resolume mirror — it is a customizable live surface in the spirit of
grandMA3 / Luminex / Stream Deck hardware that drives Resolume Arena/Avenue or
any OSC-compatible software over Wi-Fi.

Zero runtime dependencies (vanilla JS/CSS + Electron), a hand-rolled OSC 1.0
codec, an ML beat-tracking sidecar, and an autonomous AI Visual Director that
understands your composition and reacts to the music — with stage-safe
guardrails everywhere.

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
  - The APC40 mkII mapping cheat sheet ships as a standalone shareable page,
    `docs/apc40-mapping.html` (regenerate after remapping with
    `python3 tools/gen-akai-map.py`) — send it along with the composition.
  - **Agent** — cockpit for the AI VJ agent (`agent/rogger_agent.py`, a Mac
    sidecar that listens to line-in/mic, tracks beats with the BeatNet ML
    model — DSP fallback — and detects build-ups / drops / breakdowns).
    Live band meters, BPM + confidence, section state, event log, and cue
    rules (event → OSC macro with cooldown + pulse). Nothing fires until the
    big **ARM** button is lit; TEST works while disarmed. See `agent/README.md`.
  - **Director** — the autonomous AI Visual Director (`src/renderer/js/director/`).
    Consumes the agent's music intelligence (beat/phrase position, build/drop/
    fake-build/breakdown, energy/tension/bass/density/vocal metrics, drop
    predictions), inspects the live composition through Resolume's webserver
    to build a **semantic show model** (hero/strobe/flash/impact/camera-FX
    roles; TC/PB, TIMER, LFV, AB, INPUT layers are protected and never
    touched), and emits high-level intents (TriggerFlash, SwitchDeck,
    HoldCurrentVisual…) with **confidence + reasoning**. A visual-economy
    memory makes repeated strobes/flashes/impacts progressively more
    expensive; confidence tiers (act / cautious / hold / notify), **safe
    mode** on health issues (audio lost, BPM lost, Resolume API down, UI
    overload), and **supervisor mode** (any manual touch pauses the AI for
    30 s, then it eases back in) keep it stage-safe. Boots disarmed in
    suggest mode; every decision is logged as JSONL for replay/learning.
- **8 main faders** — vertical MASTER + layer masters + logo, horizontal
  utility strips (multi-target fan-out, e.g. both pushers' fade-out from one
  fader). Double-tap resets; invert/sensitivity/min/max per fader; ♪ beat
  button and optional auto beat-follow (value = bpm / bpmAt1).
- **10 color presets + target switch** — the small squares at the row's end
  choose what the picker paints (background colorize / logo outline-haze /
  strobe color / ColorMorph Color 1 / Color 3); OFF fires the target's release
  steps. Feedback lights the matching preset.
- **Topbar** — OSC target, analog-mapping readout, beat clock (BPM + beat ms,
  /2 and x2, AUTO toggle to follow Resolume's BPM, beat-pulse tinted by the
  last picked color), battery, clock, tap/resync, status lamp
  (OFFLINE / READY / LIVE — honest UDP semantics), EDIT, settings.

## Controller (built-in Ally X gamepad)

- Any FX button binds to a pad button (editor grid or **Gamepad Learn**);
  bindings show as badges and steal cleanly across pages.
- **LT / RT are analog**: depth maps onto a float param (master duck, strobe
  stomp with engage/release messages), springing back on release.
- **Stick axes** pan / zoom / rotate the composition transform and re-center
  on release. Haptics: press ticks + depth-scaled strobe rumble.

## Button behaviors

Tap, toggle (latching), hold (piano-style 1/0, optional separate release
address), flash animation, repeat while held (fixed interval or beat-synced),
ramp-while-held (value sweep), multi-message macros (zeroed on release so
clears let go), per-button icon / label / color, OSC learn, command library.

## Resolume setup

1. Preferences → OSC: enable **OSC Input** (this composition uses port 7432).
2. For learn / feedback / LIVE lamp / auto-BPM: enable **OSC Output**,
   target = the controller device's IP, port **7001**.
3. For the DJ-page sync and BPM seeding: enable the **Webserver** (port 9292).

## Director brain (local model)

The Director can hand its decisions to a **local model** served by LM Studio
(or Ollama / llama-server — any OpenAI-style endpoint). Toggle the **BRAIN**
chip on the Director page; when the server is reachable the model picks the
intent *and* the color mood every few bars, and a vision model (if one is
loaded, e.g. `qwen3-vl`) periodically reviews a screenshot of the output
display. Everything is schema-validated, flows through the same confidence
tiers / protected-layer guard, and the heuristic policy takes over the moment
the model is off, slow or malformed.

Setup on the performance machine:

1. Install LM Studio, load a small instruct model (e.g. `qwen2.5-3b-instruct`
   — avoid "thinking" models for low latency) and optionally a vision model.
2. Start the local server (default `http://127.0.0.1:1234`).
3. Director page → tap **BRAIN**. Config keys live under `director.brain`
   (`url`, `model`, `visionModel`, `decideEveryBars`, `lookEveryMs`,
   `display` — which screen the Resolume output lives on).

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
- **Director intelligence** — new intents, better policies, smarter show-model
  role detection, replay/learning from the JSONL decision logs.
- **Beat detection** — improvements to the BeatNet/DSP sidecar
  (`agent/rogger_agent.py`).
- **Hardware surfaces** — mappings beyond the APC40 mkII, other handhelds and
  touch devices.
- **Docs, tests, bug reports** — always appreciated.

Workflow: fork → branch → `npm test` (and `node test/serve.js` for UI checks)
→ pull request. Open an issue first for bigger ideas so we can talk design.
No build step, no framework — if you know plain JavaScript, you can hack on
ROGGER.

## License

[MIT](LICENSE)
