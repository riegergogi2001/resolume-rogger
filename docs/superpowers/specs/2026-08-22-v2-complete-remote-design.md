# ROGGER v2 — complete remote, no AI, combos, MA3 handoff (design)

Date: 2026-08-22. Decisions taken autonomously under a `/goal` directive
(user unavailable); recorded here so every agent works from one source.

## Goals (from the user)
1. Finish ROGGER as a **complete Resolume remote**: every configurable thing
   is editable in-app, the OSC command library covers the whole Resolume 7
   surface, config can be exported/imported, and ROGGER itself has a small
   inbound OSC API.
2. **Remove the flaky AI features** (Agent page + Python BeatNet sidecar,
   Director page + local-model brain). Keep Page 1, Page 2, DJ Intro, Colors.
3. Keep **realtime mic analysis** but only as a **BPM analyser**, done natively
   in the app (Web Audio, no Python): a BPM page + a third beat source (MIC).
4. **Gamepad combos / modifiers**: holding a modifier (e.g. RT) and pressing A
   fires a different binding than A alone. Any pad button can be a modifier.
5. **grandMA3 GDTF** of the tested ROGGER functions so the local LD can patch
   "the video" as a fixture, plus the matching Resolume DMX shortcut preset
   and an LD cheat sheet. Tested end-to-end (Art-Net → Resolume REST check).
6. Test everything: unit tests (`node --test`), browser-mode UI checks
   (Playwright against `test/serve.js`), live Resolume Arena checks.

## Non-goals
- No ML/AI, no Python runtime, no LM Studio. No new hardware surfaces.

## Architecture changes
- Delete `src/renderer/js/agent-page.js`, `director-page.js`,
  `src/renderer/js/director/`, `src/main/brain.js`, `agent/`, their tests,
  their specs, their CSS, their IPC/preload/bridge entries, and the
  `director` / `agent` config sections.
- New `src/renderer/js/bpm/` : `bpm-core.js` (pure JS: FFT, spectral-flux
  onset envelope, autocorrelation tempo estimate 60–200 BPM with log-Gaussian
  prior ~125, octave-error check, median smoothing, confidence, beat phase
  prediction) — unit-tested in Node with synthetic audio; `bpm-analyser.js`
  (Web Audio wiring: getUserMedia device pick, AudioWorklet frame pump with
  ScriptProcessor fallback, level meter, emits {bpm, confidence, level,
  onset, beat}); `bpm-page.js` (UI). Beat clock gets mode `mic`.
- Gamepad: `gamepadModifier` (-1 | button index) on every fx/util button.
  Resolution on press: binding with (button, held modifier) wins over the
  plain (button, -1) binding. Modifier buttons keep their own plain binding
  and analog trigger action. Press/release are paired per physical button.
  Editor: modifier pick row + "Gamepad learn" captures a held modifier.
  Badge shows `RT+A`. Uniqueness is per (modifier, button) pair.
- Editor completeness: extraAddress(es), fader orientation/beatSync,
  color preset rgb/isOff, color-target editor (label/swatch/bases/on/off
  steps), Settings → Controller (LT/RT analog, sticks, haptics), Pages
  visibility, config export/import (Electron dialogs), OSC library search.
- Inbound OSC API (listen port): `/rogger/fx/{page}/{index} [1|0]`,
  `/rogger/util/{index}`, `/rogger/fader/{index} f`, `/rogger/gfader/{index}
  f`, `/rogger/color/{index}`, `/rogger/page {n}`, `/rogger/tap`,
  `/rogger/resync`. Documented in README.
- MA3 handoff: `tools/dmx_map.py` (single source of truth, built from
  `configs/show.json`), `tools/gen-ma3-gdtf.py`,
  `tools/gen-resolume-dmx-preset.py`, `tools/artnet-send.js`,
  `tools/install-resolume-preset.sh`, `docs/ma3-handoff.html`.

## DMX channel map (one universe, 8-bit, fixed order)
| Ch | Block | Name | Kind | Resolume target(s) | Default |
|---|---|---|---|---|---|
| 1 | Main | MASTER | range | /composition/master | 255 |
| 2–5 | Main | LAYER 1–4 | range | /composition/layers/{1..4}/master | 255 |
| 6 | Main | LOGO | range | /composition/layers/9/master | 255 |
| 7–12 | Main | BG GRP, BANNER, LOGOS, FX RACK, TC GRP, TIMES | range | /composition/groups/{1..6}/master | 255 |
| 13 | Main | PUSH TIME | range | pusher + pusher2 fadeouttime | 94 |
| 14 | Main | STR SPD | range | flashmaster strobespeed (L12 clips 3,4,7) + slicestrobe speed (clip 9) | 79 |
| 15–22 | Flash | GENERA, FLASH M, FLASH M2, INVERT, PIXELATE, FE STR, SUCK IT!, SLICE STR | event (momentary) | /composition/layers/12/clips/{2..9}/connect | 0 |
| 23 | Flash | CLR FX | event | /composition/layers/12/clear | 0 |
| 24–28 | Bump | BOOM BLUR/EXPO/EDGE/BLOW/INV | event | boomer/effect/{blur,exposure,edge,blow,invert} | 0 |
| 29–30 | Bump | PUSH WHT / PUSH BLK | event | pusher / pusher2 effect/push! | 0 |
| 31 | Bump | BOOM ALL | event | blur+exposure+edge+blow | 0 |
| 32 | Bump | PUSH X2 | event | pusher + pusher2 push! | 0 |
| 33 | Util | KEEP GREYS | bool | groups/1 colorize/effect/greyskeep | 0 |
| 34 | Util | HAZE BYPASS | bool | layers/8 + layers/9 outlinehaze/bypassed | 0 |
| 35 | Util | DISTORT BYPASS | bool | /composition/video/effects/distortion/bypassed | 255 |
| 36 | Util | AUTO VJ | choice | /composition/layers/1/autopilot/target | 0 |
| 37–39 | BG (sub) | R G B | color | groups/1 colorize/effect/color/{red,green,blue} | 0 |
| 40 | Util | BG COLOR BYPASS | bool | groups/1 colorize/bypassed | 255 |
| 41–43 | LOGO (sub) | R G B | color | layers/8 + layers/9 outlinehaze/effect/color/* | 0 |
| 44–46 | FLASH (sub) | R G B | color | L12 clips 3,4,7 flashmaster/effect/color1/* | 0 |
| 47–49 | MORPH1 (sub) | R G B | color | colormorph/effect/color1/* | 0 |
| 50–52 | MORPH2 (sub) | R G B | color | colormorph/effect/color3/* | 0 |
| 53 | Util | MORPH SPEED | range | colormorph/effect/speed | 0 |
| 54 | Util | MORPH BYPASS | bool | colormorph/bypassed | 255 |
| 55–61 | FX | EDGE FX, ACUARELA, BLOOM, GOO, INF ZOOM, METASHAPE, GLITCH | range | groups/1 video/effects/{edgedetection,acuarela,bloom,goo,infinitezoom,metashape,shiftglitch}/opacity | 0 |
| 62 | FX | HUE ROTATE | range | groups/1 huerotate/effect/huerotate | 145 |
| 63–64 | FX | ZOOM RST / ACUA RST | event | infinitezoom / acuarela effect/reset | 0 |
| 65 | Logo | LOGO ON | event | layers/9/clips/2/connect + layers/8/clear | 0 |
| 66 | Logo | LOGO OFF | event | layers/8/clear + layers/9/clear | 0 |
| 67 | Logo | ALT LOGO | event | layers/8/clips/17/connect | 0 |
| 68 | Logo | CLR LOGO | event | layers/9/clear | 0 |
| 69–92 | DJ | labels from config fxButtons3 | event | their addresses (layers/17/clips/{1..24}/connect) | 0 |
| 93–94 | Tempo | TAP TEMPO / RESYNC | event | tempocontroller/tempotap, resync | 0 |
| 95–96 | Transform | POS X / POS Y | range | transform/effect/positionx|positiony | 128 |
| 97 | Transform | SCALE | range | transform/effect/scale | 26 |
| 98 | Transform | ROTATION | range | transform/effect/rotationz | 128 |

Event channels: DMX ≥128 = press, <128 = release (piano-mode clips stop
on release). Bool: ≥128 = true. Color sub-geometries let the MA3 color
picker drive Resolume colors per target.

## Resolume DMX shortcut XML facts (reverse-engineered from the user's presets)
- File: `~/Documents/Resolume Arena/Shortcuts/DMX/<name>.xml`, root
  `<DMXShortcutPreset presetId="<int32>" name="...">` with `<versionInfo …/>`
  and `<ShortcutManager name="DMXShortcutManagerShortcuts">`.
- `<RawInputMessage key="K" value="0" numSteps="256" 9bit="1"/>` where
  `K = (5 << 56) + universeIndex*512 + (channel-1)` (decimal string).
- Float params: `paramNodeName="ParamRange" behaviour="22"` + `<Subtarget
  type="5" optionIndex="-1"/>`; triggers (connect, push!, clear, reset,
  tempotap, resync): `paramNodeName="ParamEvent" behaviour="1046"`; booleans:
  `paramNodeName="RangedParam[bool]" behaviour="22"`; choice: `ParamChoice`
  behaviour 22 (verify live).
- `<ShortcutPath name="InputPath" path="<osc address>" translationType="1"
  allowedTranslationTypes="1"/>` (index-based paths, same as ROGGER).
- Several shortcuts may share one key (fan-out).

## Testing
- `npm test` (node --test) — codec, config, engine, bpm-core, osc-library,
  gamepad combo resolver, dmx map.
- Browser-mode UI: Playwright vs `node test/serve.js` (mock bridge,
  `window.__oscLog`, `window.__gamepadOverride`).
- Live: Resolume Arena 7.25 on this Mac (OSC in 7432, webserver 9292,
  Art-Net bound to en11); `tools/artnet-send.js` → REST `/api/v1/composition`.
