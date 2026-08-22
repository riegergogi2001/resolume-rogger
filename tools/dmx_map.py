#!/usr/bin/env python3
"""Single source of truth for the ROGGER -> grandMA3 DMX channel map.

98 channels, one universe, 8-bit, fixed order — see
docs/superpowers/specs/2026-08-22-v2-complete-remote-design.md ("DMX channel
map" table) for the binding spec this mirrors.

build_map(config_path) reads the tested ROGGER show config
(configs/campus-forum-stage.json by default) and returns the 98 rows as
plain dicts:

    ch        1-based DMX channel number (1..98, unique, in order)
    block     FeatureGroup bucket: Dimmer | Levels | Flash | Bump | Util |
              Color | FX | Logo | DJ | Tempo | Transform
    name      short channel name (used verbatim as the GDTF ChannelFunction
              Name and, sanitized, as the GDTF custom Attribute Name)
    kind      range | event | bool | choice | color
    targets   list of Resolume OSC addresses this channel fans out to
    default   0..255 DMX default/power-on value
    geometry  "Main", or one of the color sub-geometries BG/LOGO/FLASH/
              MORPH1/MORPH2
    component "R"/"G"/"B" for kind == "color", else None
    note      one-line human description (used by the LD handoff sheet)

Two ColorMorph-related fields (colorMorph.speedAddress/bypassAddress, and
the colorTargets.items entries for morph1/morph2) are not customized in the
tested show config -- config-store.js's runtime merge fills them in from
its own defaults() before ROGGER ever uses them. This module carries the
same fallback constants (see FALLBACK_* below) rather than reimplementing
config-store.js's full deepMerge in Python, since every other array this
map reads (fxButtons/fxButtons2/fxButtons3/utilButtons/faders/groupFaders/
colorButtons/colorTargets.bg|logo|flash/sticks) is fully populated in the
saved config already.

Run directly to print the table:
    python3 tools/dmx_map.py
"""
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_CONFIG_PATH = os.path.join(REPO_ROOT, 'configs', 'campus-forum-stage.json')

# ---- fallback constants for the two ColorMorph fields the saved show
# config leaves at their config-store.js defaults() values ------------------
FALLBACK_COLORMORPH = {
    'speedAddress': '/composition/video/effects/colormorph/effect/speed',
    'bypassAddress': '/composition/video/effects/colormorph/bypassed',
}
FALLBACK_MORPH1_BASE = '/composition/video/effects/colormorph/effect/color1'
FALLBACK_MORPH2_BASE = '/composition/video/effects/colormorph/effect/color3'

# Tempo tap/resync are app-wide constants (src/renderer/js/topbar.js,
# fx-grid.js, osc-library.js), not per-show config fields.
TEMPO_TAP_ADDRESS = '/composition/tempocontroller/tempotap'
TEMPO_RESYNC_ADDRESS = '/composition/tempocontroller/resync'


def load_config(config_path=None):
    path = config_path or DEFAULT_CONFIG_PATH
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def _clamp255(v):
    return max(0, min(255, round(v)))


def _dmx_default(fraction):
    """0..1 float -> 0..255 DMX default value, rounded and clamped."""
    return _clamp255(fraction * 255)


def _targets_of(btn):
    """Fan-out targets for a fxButtons/fxButtons2/fxButtons3/utilButtons
    entry: macro steps replace the primary address entirely (that's how
    fx-grid.js sends them); otherwise address + extraAddress(es)."""
    macro = btn.get('macro') or []
    if macro:
        out = []
        for step in macro:
            addr = step.get('address')
            if addr and addr not in out:
                out.append(addr)
        return out
    out = [btn['address']]
    extra = btn.get('extraAddress')
    if extra:
        out.append(extra)
    out.extend(btn.get('extraAddresses') or [])
    return out


def _transform_fanout(new_path_address):
    """Composition Transform channels fan out to two addresses: the 7.26+
    path (.../transform/<param>, no /effect/ segment -- verified live via
    Art-Net + REST readback) first, then the legacy pre-7.26 path
    (.../transform/effect/<param>) so the preset keeps working on older
    Resolume builds. `new_path_address` is the config's stored address,
    which is already the new (no /effect/) form."""
    marker = '/effects/transform/'
    idx = new_path_address.find(marker)
    if idx == -1:
        return [new_path_address]
    head = new_path_address[:idx + len(marker)]
    param = new_path_address[idx + len(marker):]
    legacy = f'{head}effect/{param}'
    return [new_path_address, legacy]


def _fader_targets(fd):
    out = [fd['address']]
    extra = fd.get('extraAddress')
    if extra:
        out.append(extra)
    out.extend(fd.get('extraAddresses') or [])
    return out


def _color_target(cfg, item_id, fallback_base=None):
    items = cfg['colorTargets']['items']
    match = next((it for it in items if it['id'] == item_id), None)
    if match is not None:
        return match
    # morph1/morph2 aren't customized in this show config; fall back to
    # config-store.js's defaults() shape (see module docstring).
    base = fallback_base or FALLBACK_MORPH1_BASE
    return {'colorBases': [base], 'offSteps': []}


def _color_triplet_rows(ch_start, block, geom, bases, default=0):
    """3 rows (R,G,B), each fanned out across every base in `bases`."""
    rows = []
    for i, comp in enumerate(('R', 'G', 'B')):
        suffix = {'R': 'red', 'G': 'green', 'B': 'blue'}[comp]
        targets = [f'{b}/{suffix}' for b in bases]
        rows.append({
            'ch': ch_start + i, 'block': block, 'name': f'{geom} {comp}',
            'kind': 'color', 'targets': targets, 'default': default,
            'geometry': geom, 'component': comp,
            'note': f'{comp} component of the {geom} sub-fixture RGB color '
                    f'(fans out to {len(targets)} target'
                    f'{"s" if len(targets) != 1 else ""}; drive with the MA3 color picker).',
        })
    return rows


def build_map(config_path=None):
    cfg = load_config(config_path)
    rows = []

    faders = cfg['faders']
    gfaders = cfg['groupFaders']
    fx1 = cfg['fxButtons']
    fx2 = cfg['fxButtons2']
    fx3 = cfg['fxButtons3']
    util = cfg['utilButtons']
    sticks = cfg['sticks']
    color_targets = cfg['colorTargets']
    color_morph = cfg.get('colorMorph') or FALLBACK_COLORMORPH

    # ---- ch 1: MASTER (Dimmer) --------------------------------------------
    rows.append({
        'ch': 1, 'block': 'Dimmer', 'name': 'MASTER', 'kind': 'range',
        'targets': _fader_targets(faders[0]), 'default': _dmx_default(faders[0]['defaultValue']),
        'geometry': 'Main', 'component': None,
        'note': 'Composition master fader — standard grandMA3 Dimmer attribute.',
    })

    # ---- ch 2-5: LAYER 1-4 -------------------------------------------------
    for i in range(4):
        fd = faders[1 + i]
        rows.append({
            'ch': 2 + i, 'block': 'Levels', 'name': fd['label'], 'kind': 'range',
            'targets': _fader_targets(fd), 'default': _dmx_default(fd['defaultValue']),
            'geometry': 'Main', 'component': None,
            'note': f"Layer {i + 1} master level.",
        })

    # ---- ch 6: LOGO layer master -------------------------------------------
    fd = faders[5]
    rows.append({
        'ch': 6, 'block': 'Levels', 'name': fd['label'], 'kind': 'range',
        'targets': _fader_targets(fd), 'default': _dmx_default(fd['defaultValue']),
        'geometry': 'Main', 'component': None, 'note': 'Logo layer master level.',
    })

    # ---- ch 7-12: group faders (BG GRP, BANNER, LOGOS, FX RACK, TC GRP, TIMES)
    for i in range(6):
        fd = gfaders[i]
        rows.append({
            'ch': 7 + i, 'block': 'Levels', 'name': fd['label'], 'kind': 'range',
            'targets': _fader_targets(fd), 'default': _dmx_default(fd['defaultValue']),
            'geometry': 'Main', 'component': None,
            'note': f"{fd['label']} group master level.",
        })

    # ---- ch 13: PUSH TIME ---------------------------------------------------
    fd = faders[6]
    rows.append({
        'ch': 13, 'block': 'Levels', 'name': fd['label'], 'kind': 'range',
        'targets': _fader_targets(fd), 'default': _dmx_default(fd['defaultValue']),
        'geometry': 'Main', 'component': None,
        'note': 'Pusher + Pusher2 fade-out time (shared).',
    })

    # ---- ch 14: STR SPD -------------------------------------------------------
    fd = faders[7]
    rows.append({
        'ch': 14, 'block': 'Levels', 'name': fd['label'], 'kind': 'range',
        'targets': _fader_targets(fd), 'default': _dmx_default(fd['defaultValue']),
        'geometry': 'Main', 'component': None,
        'note': 'Strobe speed shared across FLASH M2/FE STR/SLICE STR clip FX.',
    })

    # ---- ch 15-22: Flash bank (fxButtons[0..7]) ------------------------------
    for i in range(8):
        b = fx1[i]
        rows.append({
            'ch': 15 + i, 'block': 'Flash', 'name': b['label'], 'kind': 'event',
            'targets': _targets_of(b), 'default': 0,
            'geometry': 'Main', 'component': None,
            'note': 'Momentary clip trigger (piano-mode: hold the button, DMX>=128=press, <128=release).',
        })

    # ---- ch 23: CLR FX ---------------------------------------------------------
    rows.append({
        'ch': 23, 'block': 'Flash', 'name': 'CLR FX', 'kind': 'event',
        'targets': ['/composition/layers/12/clear'], 'default': 0,
        'geometry': 'Main', 'component': None,
        'note': 'Clears the FX rack layer (layer 12).',
    })

    # ---- ch 24-28: Bump — BOOM BLUR/EXPO/EDGE/BLOW/INV ------------------------
    bump_boomer = [
        ('BOOM BLUR', 'blur'), ('BOOM EXPO', 'exposure'), ('BOOM EDGE', 'edge'),
        ('BOOM BLOW', 'blow'), ('BOOM INV', 'invert'),
    ]
    for i, (name, param) in enumerate(bump_boomer):
        rows.append({
            'ch': 24 + i, 'block': 'Bump', 'name': name, 'kind': 'event',
            'targets': [f'/composition/video/effects/boomer/effect/{param}'], 'default': 0,
            'geometry': 'Main', 'component': None,
            'note': f'Composition-level BOOMER {param} bump (momentary).',
        })

    # ---- ch 29-30: PUSH WHT / PUSH BLK -----------------------------------------
    rows.append({
        'ch': 29, 'block': 'Bump', 'name': 'PUSH WHT', 'kind': 'event',
        'targets': ['/composition/video/effects/pusher/effect/push!'], 'default': 0,
        'geometry': 'Main', 'component': None, 'note': 'White pusher bump.',
    })
    rows.append({
        'ch': 30, 'block': 'Bump', 'name': 'PUSH BLK', 'kind': 'event',
        'targets': ['/composition/video/effects/pusher2/effect/push!'], 'default': 0,
        'geometry': 'Main', 'component': None, 'note': 'Black pusher bump.',
    })

    # ---- ch 31: BOOM ALL (fan-out of the 4 boomer params) ----------------------
    rows.append({
        'ch': 31, 'block': 'Bump', 'name': 'BOOM ALL', 'kind': 'event',
        'targets': [f'/composition/video/effects/boomer/effect/{p}' for p in ('blur', 'exposure', 'edge', 'blow')],
        'default': 0, 'geometry': 'Main', 'component': None,
        'note': 'Fires blur+exposure+edge+blow together.',
    })

    # ---- ch 32: PUSH X2 (fan-out of both pushers) -------------------------------
    rows.append({
        'ch': 32, 'block': 'Bump', 'name': 'PUSH X2', 'kind': 'event',
        'targets': ['/composition/video/effects/pusher/effect/push!',
                    '/composition/video/effects/pusher2/effect/push!'],
        'default': 0, 'geometry': 'Main', 'component': None,
        'note': 'Fires both pushers together.',
    })

    # ---- ch 33-36: Util quad (utilButtons[0..3]) --------------------------------
    u = util[0]
    rows.append({
        'ch': 33, 'block': 'Util', 'name': u['label'], 'kind': 'bool',
        'targets': _targets_of(u), 'default': 0,
        'geometry': 'Main', 'component': None, 'note': 'Keep greys on the BG colorize effect.',
    })
    u = util[1]
    rows.append({
        'ch': 34, 'block': 'Util', 'name': 'HAZE BYPASS', 'kind': 'bool',
        'targets': _targets_of(u), 'default': 0,
        'geometry': 'Main', 'component': None,
        'note': 'Bypasses OutlineHaze on layers 8+9 (0=haze on, >=128=bypassed/off).',
    })
    u = util[2]
    rows.append({
        'ch': 35, 'block': 'Util', 'name': 'DISTORT BYPASS', 'kind': 'bool',
        'targets': _targets_of(u), 'default': 255,
        'geometry': 'Main', 'component': None,
        'note': 'Bypasses the composition-level distortion effect (defaults bypassed/off).',
    })
    u = util[3]
    rows.append({
        'ch': 36, 'block': 'Util', 'name': 'AUTO VJ', 'kind': 'choice',
        'targets': _targets_of(u), 'default': 0,
        'geometry': 'Main', 'component': None,
        'note': "Layer 1 autopilot target: 0=Off, 64/128/192=Target 1/2/3.",
    })

    # ---- ch 37-40: BG color triplet + bypass ------------------------------------
    bg = _color_target(cfg, 'bg')
    rows.extend(_color_triplet_rows(37, 'Color', 'BG', bg['colorBases']))
    bg_off = bg['offSteps'][0]['address'] if bg.get('offSteps') else \
        '/composition/groups/1/video/effects/colorize/bypassed'
    rows.append({
        'ch': 40, 'block': 'Util', 'name': 'BG COLOR BYPASS', 'kind': 'bool',
        'targets': [bg_off], 'default': 255,
        'geometry': 'Main', 'component': None,
        'note': 'Bypasses the BG colorize effect (defaults bypassed/off until a color is chosen).',
    })

    # ---- ch 41-43: LOGO color triplet ---------------------------------------------
    logo = _color_target(cfg, 'logo')
    rows.extend(_color_triplet_rows(41, 'Color', 'LOGO', logo['colorBases']))

    # ---- ch 44-46: FLASH color triplet ---------------------------------------------
    flash = _color_target(cfg, 'flash')
    rows.extend(_color_triplet_rows(44, 'Color', 'FLASH', flash['colorBases']))

    # ---- ch 47-49: MORPH1 color triplet ---------------------------------------------
    morph1 = _color_target(cfg, 'morph1', FALLBACK_MORPH1_BASE)
    rows.extend(_color_triplet_rows(47, 'Color', 'MORPH1', morph1['colorBases']))

    # ---- ch 50-52: MORPH2 color triplet ---------------------------------------------
    morph2 = _color_target(cfg, 'morph2', FALLBACK_MORPH2_BASE)
    rows.extend(_color_triplet_rows(50, 'Color', 'MORPH2', morph2['colorBases']))

    # ---- ch 53-54: MORPH SPEED / MORPH BYPASS -----------------------------------------
    rows.append({
        'ch': 53, 'block': 'Util', 'name': 'MORPH SPEED', 'kind': 'range',
        'targets': [color_morph['speedAddress']], 'default': 0,
        'geometry': 'Main', 'component': None, 'note': 'ColorMorph cycle speed.',
    })
    rows.append({
        'ch': 54, 'block': 'Util', 'name': 'MORPH BYPASS', 'kind': 'bool',
        'targets': [color_morph['bypassAddress']], 'default': 255,
        'geometry': 'Main', 'component': None,
        'note': 'Bypasses the ColorMorph composition effect (defaults bypassed/off).',
    })

    # ---- ch 55-61: FX bank (fxButtons2[0..6]) ------------------------------------------
    for i in range(7):
        b = fx2[i]
        rows.append({
            'ch': 55 + i, 'block': 'FX', 'name': b['label'], 'kind': 'range',
            'targets': _targets_of(b), 'default': 0,
            'geometry': 'Main', 'component': None,
            'note': f"Group 1 content FX opacity ({b['label']}).",
        })

    # ---- ch 62: HUE ROTATE --------------------------------------------------------------
    rows.append({
        'ch': 62, 'block': 'FX', 'name': 'HUE ROTATE', 'kind': 'range',
        'targets': ['/composition/groups/1/video/effects/huerotate/effect/huerotate'],
        'default': _dmx_default(0.57),
        'geometry': 'Main', 'component': None,
        'note': 'Group 1 hue rotation (defaults to the HUE RST rest position, 0.57).',
    })

    # ---- ch 63-64: ZOOM RST / ACUA RST ---------------------------------------------------
    rows.append({
        'ch': 63, 'block': 'FX', 'name': 'ZOOM RST', 'kind': 'event',
        'targets': [fx2[14]['address']], 'default': 0,
        'geometry': 'Main', 'component': None, 'note': 'Resets the infinite-zoom effect.',
    })
    rows.append({
        'ch': 64, 'block': 'FX', 'name': 'ACUA RST', 'kind': 'event',
        'targets': [fx2[15]['address']], 'default': 0,
        'geometry': 'Main', 'component': None, 'note': 'Resets the acuarela effect.',
    })

    # ---- ch 65-68: Logo block -------------------------------------------------------------
    rows.append({
        'ch': 65, 'block': 'Logo', 'name': 'LOGO ON', 'kind': 'event',
        'targets': ['/composition/layers/9/clips/2/connect', '/composition/layers/8/clear'],
        'default': 0, 'geometry': 'Main', 'component': None,
        'note': 'Main logo on (also clears the DJ-page alt logo layer 8).',
    })
    rows.append({
        'ch': 66, 'block': 'Logo', 'name': 'LOGO OFF', 'kind': 'event',
        'targets': ['/composition/layers/8/clear', '/composition/layers/9/clear'],
        'default': 0, 'geometry': 'Main', 'component': None,
        'note': 'Clears both logo layers (8 and 9).',
    })
    rows.append({
        'ch': 67, 'block': 'Logo', 'name': 'PULLMAXX', 'kind': 'event',
        'targets': [fx2[12]['address']], 'default': 0,
        'geometry': 'Main', 'component': None,
        'note': 'Alt logo (PULLMAXX) on layer 8 — distinct from the DJ-page PULLMAXX track on ch 88.',
    })
    rows.append({
        'ch': 68, 'block': 'Logo', 'name': 'CLR LOGO', 'kind': 'event',
        'targets': [fx2[9]['address']], 'default': 0,
        'geometry': 'Main', 'component': None, 'note': 'Clears the main logo layer (9).',
    })

    # ---- ch 69-92: DJ block (fxButtons3[0..23], labels+addresses AS-IS) --------------------
    for i in range(24):
        b = fx3[i]
        note = f"DJ Intro page clip trigger ({b['label']})."
        if i == 22:
            note = 'DJ-page logo shortcut (R1 LOGO) — duplicates ch 65 LOGO ON for on-page reach.'
        elif i == 23:
            note = 'DJ-page logo shortcut — duplicates ch 66 LOGO OFF for on-page reach.'
        rows.append({
            'ch': 69 + i, 'block': 'DJ', 'name': b['label'], 'kind': 'event',
            'targets': _targets_of(b), 'default': 0,
            'geometry': 'Main', 'component': None, 'note': note,
        })

    # ---- ch 93-94: Tempo -------------------------------------------------------------------
    rows.append({
        'ch': 93, 'block': 'Tempo', 'name': 'TAP TEMPO', 'kind': 'event',
        'targets': [TEMPO_TAP_ADDRESS], 'default': 0,
        'geometry': 'Main', 'component': None, 'note': 'Tap-tempo input to Resolume\'s tempo controller.',
    })
    rows.append({
        'ch': 94, 'block': 'Tempo', 'name': 'RESYNC', 'kind': 'event',
        'targets': [TEMPO_RESYNC_ADDRESS], 'default': 0,
        'geometry': 'Main', 'component': None, 'note': 'Resyncs the beat phase to the last tap/BPM.',
    })

    # ---- ch 95-98: Transform (sticks) ------------------------------------------------------
    # Fan out to both the 7.26+ path (no /effect/ segment -- verified live via
    # Art-Net + REST readback on this Mac, see docs/superpowers/specs/
    # 2026-08-22-v2-complete-remote-design.md) and the legacy pre-7.26 path
    # (with /effect/), new path first, so the preset still works against
    # older Resolume builds that only answer on the /effect/ form.
    ls, rs = sticks['ls'], sticks['rs']
    rows.append({
        'ch': 95, 'block': 'Transform', 'name': 'POS X', 'kind': 'range',
        'targets': _transform_fanout(ls['x']['address']), 'default': _dmx_default(ls['x']['center']),
        'geometry': 'Main', 'component': None, 'note': 'Composition transform position X (LS stick).',
    })
    rows.append({
        'ch': 96, 'block': 'Transform', 'name': 'POS Y', 'kind': 'range',
        'targets': _transform_fanout(ls['y']['address']), 'default': _dmx_default(ls['y']['center']),
        'geometry': 'Main', 'component': None, 'note': 'Composition transform position Y (LS stick).',
    })
    rows.append({
        'ch': 97, 'block': 'Transform', 'name': 'SCALE', 'kind': 'range',
        'targets': _transform_fanout(rs['y']['address']), 'default': _dmx_default(rs['y']['center']),
        'geometry': 'Main', 'component': None, 'note': 'Composition transform scale (RS stick Y).',
    })
    rows.append({
        'ch': 98, 'block': 'Transform', 'name': 'ROTATION', 'kind': 'range',
        'targets': _transform_fanout(rs['x']['address']), 'default': _dmx_default(rs['x']['center']),
        'geometry': 'Main', 'component': None, 'note': 'Composition transform rotation Z (RS stick X).',
    })

    # ---- sanity ---------------------------------------------------------------------------
    assert len(rows) == 98, f'expected 98 channels, built {len(rows)}'
    assert [r['ch'] for r in rows] == list(range(1, 99)), 'channels must be 1..98 in order'
    for r in rows:
        assert r['targets'], f"ch {r['ch']} ({r['name']}) has no targets"
        for t in r['targets']:
            assert t.startswith('/composition/'), f"ch {r['ch']} target {t!r} is not a composition path"
        assert 0 <= r['default'] <= 255, f"ch {r['ch']} default out of range"
        assert r['kind'] in ('range', 'event', 'bool', 'choice', 'color')

    return rows


def main():
    rows = build_map()
    hdr = f"{'CH':>3}  {'BLOCK':<10}{'NAME':<16}{'KIND':<7}{'DEF':>4}  {'GEOM':<7}  TARGETS"
    print(hdr)
    print('-' * len(hdr))
    for r in rows:
        targets = ', '.join(r['targets'])
        comp = f"[{r['component']}] " if r['component'] else ''
        print(f"{r['ch']:>3}  {r['block']:<10}{r['name']:<16}{r['kind']:<7}{r['default']:>4}  "
              f"{r['geometry']:<7}  {comp}{targets}")
    print(f"\n{len(rows)} channels total.")


if __name__ == '__main__':
    main()
