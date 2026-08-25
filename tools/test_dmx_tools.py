#!/usr/bin/env python3
"""Plain-assert smoke tests for the ROGGER -> grandMA3 tool chain.

Covers: the 98-channel map itself, the generated GDTF fixture, and the
generated Resolume DMX shortcut preset (including the exact key-formula
test vectors from the design spec).

Run:
    python3 tools/test_dmx_tools.py
"""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import xml.dom.minidom as minidom
import zipfile

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(TOOLS_DIR)
sys.path.insert(0, TOOLS_DIR)

from dmx_map import DEFAULT_CONFIG_PATH, ALT_LOGO_ADDRESS, build_map  # noqa: E402


def load_hyphenated(name, filename):
    """tools/gen-ma3-gdtf.py and tools/gen-resolume-dmx-preset.py have
    hyphens in their filenames (module names can't), so import them by
    file path instead of by `import`."""
    spec = importlib.util.spec_from_file_location(name, os.path.join(TOOLS_DIR, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_generator(filename, *args):
    result = subprocess.run(
        [sys.executable, os.path.join(TOOLS_DIR, filename), *args],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )
    assert result.returncode == 0, (
        f'{filename} {" ".join(args)} failed:\nstdout: {result.stdout}\nstderr: {result.stderr}'
    )
    return result


def main():
    checks = 0

    # ---- 1. the map itself -------------------------------------------------
    rows = build_map()
    assert len(rows) == 98, f'expected 98 channels, got {len(rows)}'
    checks += 1

    chs = [r['ch'] for r in rows]
    assert chs == list(range(1, 99)), 'channels must be unique 1..98 in order'
    checks += 1

    for r in rows:
        for t in r['targets']:
            assert t.startswith('/composition/'), f"ch {r['ch']} target {t!r} does not start with /composition/"
    checks += 1

    with open(DEFAULT_CONFIG_PATH, encoding='utf-8') as f:
        cfg = json.load(f)
    dj_rows = [r for r in rows if r['block'] == 'DJ']
    assert len(dj_rows) == 24, f'expected 24 DJ channels, got {len(dj_rows)}'
    dj_labels = [r['name'] for r in dj_rows]
    cfg_dj_labels = [b['label'] for b in cfg['fxButtons3']]
    assert dj_labels == cfg_dj_labels, (
        f'DJ block labels must equal config fxButtons3 labels:\n{dj_labels}\n!=\n{cfg_dj_labels}'
    )
    checks += 1
    print(f'[ok] map: 98 channels, unique+ordered, all targets /composition/*, '
          f'DJ labels match config fxButtons3 ({len(dj_rows)} channels)')

    # ch 67 must be the alt-logo clip trigger (spec row 67), never derived from
    # fxButtons2[12] — that button is the FX OFF macro whose primary address is
    # an opacity path, which is where the old code silently pointed ch 67.
    ch67 = rows[66]
    assert ch67['ch'] == 67 and ch67['kind'] == 'event', f'ch 67 must be an event channel, got {ch67}'
    assert ch67['targets'] == ['/composition/layers/8/clips/17/connect'], (
        f"ch 67 (ALT LOGO) must target the layer-8 clip-17 connect path, got {ch67['targets']}"
    )
    assert ALT_LOGO_ADDRESS == ch67['targets'][0]
    assert not any('/opacity' in t for t in ch67['targets']), 'ch 67 must not be bound to an opacity path'
    checks += 1
    print(f"[ok] ch 67 ALT LOGO -> {ch67['targets'][0]} (event)")

    # ---- 2. GDTF fixture ----------------------------------------------------
    run_generator('gen-ma3-gdtf.py')
    gdtf_mod = load_hyphenated('gen_ma3_gdtf', 'gen-ma3-gdtf.py')
    gdtf_path = gdtf_mod.OUT_PATH
    assert os.path.isfile(gdtf_path), f'GDTF not written: {gdtf_path}'

    with zipfile.ZipFile(gdtf_path) as z:
        assert 'description.xml' in z.namelist(), 'GDTF zip missing description.xml'
        xml_bytes = z.read('description.xml')

    dom = minidom.parseString(xml_bytes)  # must be strictly well-formed XML
    assert dom.getElementsByTagName('FixtureType'), 'GDTF has no FixtureType element'
    assert gdtf_mod.validate(xml_bytes, rows), 'GDTF sanity checks failed'
    checks += 1
    print(f'[ok] GDTF: {gdtf_path} is a valid zip, description.xml parses and passes sanity checks')

    # ---- 3. Resolume DMX shortcut preset ------------------------------------
    run_generator('gen-resolume-dmx-preset.py')
    preset_mod = load_hyphenated('gen_resolume_dmx_preset', 'gen-resolume-dmx-preset.py')
    preset_path = os.path.join(REPO_ROOT, 'dist-ma3', 'ROGGER_MA3.xml')
    assert os.path.isfile(preset_path), f'preset not written: {preset_path}'

    with open(preset_path, 'rb') as f:
        preset_bytes = f.read()
    pdom = preset_mod.parse_resolume_xml(preset_bytes)  # lenient re: 9bit= (see module docstring)
    shortcuts = pdom.getElementsByTagName('Shortcut')
    assert len(shortcuts) >= 98, f'expected >= 98 shortcuts, got {len(shortcuts)}'
    assert pdom.documentElement.tagName == 'DMXShortcutPreset'
    assert pdom.documentElement.getAttribute('name') == 'ROGGER_MA3'
    ch67_key = preset_mod.dmx_key(0, 67)
    ch67_sc = [sc for sc in shortcuts
               if sc.getElementsByTagName('RawInputMessage')[0].getAttribute('key') == ch67_key]
    assert len(ch67_sc) == 1, f'expected exactly one shortcut on ch 67, got {len(ch67_sc)}'
    ch67_path = ch67_sc[0].getElementsByTagName('ShortcutPath')[0].getAttribute('path')
    assert ch67_path == '/composition/layers/8/clips/17/connect', f'ch 67 preset path is {ch67_path!r}'
    checks += 1
    print(f'[ok] Resolume preset: {preset_path} parses, {len(shortcuts)} shortcuts (>= 98)')

    # ---- 4. key-formula test vectors from the design spec -------------------
    key_ch15_u0 = preset_mod.dmx_key(0, 15)
    assert key_ch15_u0 == '360287970189639694', f'ch15 universe0 key {key_ch15_u0!r} != 360287970189639694'
    checks += 1

    key_ch1_u2 = preset_mod.dmx_key(2, 1)
    assert key_ch1_u2 == '360287970189640704', f'ch1 universe2 key {key_ch1_u2!r} != 360287970189640704'
    checks += 1
    print(f'[ok] key formula: ch15/u0={key_ch15_u0}, ch1/u2={key_ch1_u2}')

    # --address 101 must shift ch1 to the key of channel 101 (universe 0)
    with tempfile.TemporaryDirectory() as tmp:
        shifted_path = os.path.join(tmp, 'shifted.xml')
        run_generator('gen-resolume-dmx-preset.py', '--address', '101', '--out', shifted_path,
                      '--name', 'ROGGER_MA3_TEST_SHIFTED')
        with open(shifted_path, 'rb') as f:
            shifted_bytes = f.read()
        sdom = preset_mod.parse_resolume_xml(shifted_bytes)
        # ch1's target is /composition/master, which fans out to a single shortcut
        found = None
        for sc in sdom.getElementsByTagName('Shortcut'):
            path_el = sc.getElementsByTagName('ShortcutPath')[0]
            if path_el.getAttribute('path') == '/composition/master':
                found = sc.getElementsByTagName('RawInputMessage')[0].getAttribute('key')
                break
        assert found is not None, '/composition/master shortcut not found in shifted preset'
        expected = preset_mod.dmx_key(0, 101)
        assert found == expected, f'--address 101 shifted ch1 key to {found!r}, expected {expected!r}'
    checks += 1
    print(f'[ok] --address 101 shifts ch1 (/composition/master) to channel 101\'s key ({expected})')

    print(f'\n{checks} check groups passed.')


if __name__ == '__main__':
    main()
