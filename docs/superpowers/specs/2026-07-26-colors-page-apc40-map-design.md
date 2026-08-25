# COLORS page, ColorMorph targets, APC40 mapping visuals — design

Date: 2026-07-26 · Composition: `show.avc` · Mapping: `AkaiXboxMaion.xml` (APC40 mkII)

## Why

- The composition gained a new composition-level FX: **ColorMorph** (`/composition/video/effects/colormorph`),
  with two live colors — `Color 1` (red) and `Color 3` (magenta) — plus `Speed` and `Bypassed`.
  ROGGER's color picker only knew BG / LOGO / FLASH targets.
- The APC40 mkII mapping (166 shortcuts) lives only in Resolume; handing the comp to a friend
  means handing over tribal knowledge. It needs a visual cheat sheet — in-app and as a
  standalone webpage — generated from the actual mapping file (read-only; nothing is triggered).

## 1 · Config: two new color targets

`config-store.js` colorTargets.items gains:

- `morph1` — base `/composition/video/effects/colormorph/effect/color1`
- `morph2` — base `/composition/video/effects/colormorph/effect/color3`

Both use onSteps/offSteps on `/composition/video/effects/colormorph/bypassed` (0 = on, 1 = off).
The main-page color row picks them up automatically via its target switch.

`mergeConfig` gets a colorTargets-aware merge: saved items merge **by id** onto defaults, so
existing user configs (saved with 3 targets) don't erase the new ones.

## 2 · COLORS page (page 4)

New tab in `PAGE_DEFS` (`layout: 'colors'`), rendered by `color-lab.js`:

- **Target chips** — one per colorTargets item + OFF (fires the active target's offSteps).
- **Advanced picker** — hue strip + saturation/value pad (canvas, pointer-driven,
  sends throttled `<base>/red|green|blue` floats), live preview + hex readout.
- **Swatch bank** — 16 quick colors (the comp's 8-color rainbow palette + practical extras).
- **MORPH strip** — Color 1 / Color 3 wells (tap = select target), SPEED slider
  (`/effect/speed`), ON/OFF toggle on `bypassed` with OSC feedback.

## 3 · AKAI page (page 5)

`akai-page.js` + generated `akai-map.js` (static data distilled from the mapping XML +
composition names). Read-only visual layout of the APC40 mkII:

- 5×8 clip grid — top row: FX 1 flash clips (GeneraXYZ, FLASH MASTER ×2, INVERT, PIXELATE,
  FE STR, SUCK IT!, SLICE STROBE); rows 2–4: rainbow palette pickers (BG+BOOMER / LOGO MAIN /
  LOGO DJ); bottom row: VIDEO 1 clips 2–9.
- Scene launch column, per-track strip buttons (arm/solo/activator/select), knobs
  (device → STOCKS dashboard 1–8, track knobs → FX params), faders, transport cluster.
- Tap any control → detail readout (label + OSC path). Never sends OSC.

## 4 · Shareable webpage

`docs/apc40-mapping.html` — fully self-contained (inline CSS/JS/data), same visual layout +
searchable table of all 166 shortcuts incl. the "IMC REAPER TO MA" ch-16 bridge section.
Ship it next to the composition.

## Testing

- `node --test`: config merge keeps saved values and unions colorTargets by id.
- Browser-mode (test/serve.js + Playwright): pages render, picker sends rgb triplets to the
  mock OSC log, AKAI page sends nothing.
