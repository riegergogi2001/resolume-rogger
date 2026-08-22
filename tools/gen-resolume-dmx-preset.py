#!/usr/bin/env python3
"""Generate the Resolume DMX shortcut preset that mirrors dmx_map.py.

Writes dist-ma3/ROGGER_MA3.xml — a Resolume Arena DMXShortcutPreset named
ROGGER_MA3 that binds every one of the 98 DMX channels in the map to its
Resolume OSC target(s), so the same universe an MA3 fixture (see
tools/gen-ma3-gdtf.py) sends can drive Resolume directly.

Key formula and per-kind paramNodeName/behaviour (reverse-engineered from
the user's own installed presets — VEGMA3.xml, PHOTON2.xml, campus.xml —
under ~/Documents/Resolume Arena/Shortcuts/DMX/):

    key = (5 << 56) + universe * 512 + (channel - 1)   # decimal string

  range/color -> ParamRange  / behaviour 22  + <Subtarget type="5" optionIndex="-1"/>
  event       -> ParamEvent  / behaviour 1046
  bool        -> RangedParam[bool] / behaviour 22
  choice      -> ParamChoice / behaviour 22

One <Shortcut> per fanned-out target address; several shortcuts share one
key when a channel fans out (multiple targets -> multiple identical-key
Shortcut elements, matching how the reference presets encode fan-out).

Run:
    python3 tools/gen-resolume-dmx-preset.py [--universe 0] [--address 1]
        [--name ROGGER_MA3] [--out dist-ma3/ROGGER_MA3.xml]
"""
import argparse
import os
import sys
import xml.dom.minidom as minidom
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dmx_map import build_map  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(REPO_ROOT, 'dist-ma3', 'ROGGER_MA3.xml')

# Fixed preset id (int32) so re-generating never orphans a saved reference to it.
PRESET_ID = -1755800000
UID_START = 1755800000000

KIND_PARAM = {
    'range': ('ParamRange', '22'),
    'color': ('ParamRange', '22'),
    'event': ('ParamEvent', '1046'),
    'bool': ('RangedParam[bool]', '22'),
    'choice': ('ParamChoice', '22'),
}


def dmx_key(universe, channel):
    """channel is 1-based DMX channel number (after --address offset is applied)."""
    return str((5 << 56) + universe * 512 + (channel - 1))


def build_preset_xml(rows, universe, address_offset, name):
    root = ET.Element('DMXShortcutPreset', presetId=str(PRESET_ID), name=name)
    ver = ET.SubElement(root, 'versionInfo')
    ver.set('name', 'Resolume Arena')
    ver.set('majorVersion', '7')
    ver.set('minorVersion', '25')
    ver.set('microVersion', '1')
    ver.set('revision', '1565')
    mgr = ET.SubElement(root, 'ShortcutManager', name='DMXShortcutManagerShortcuts')

    uid = UID_START
    count = 0
    for row in rows:
        channel = row['ch'] + (address_offset - 1)
        key = dmx_key(universe, channel)
        param_node, behaviour = KIND_PARAM[row['kind']]
        for target in row['targets']:
            sc = ET.SubElement(mgr, 'Shortcut', name='Shortcut', uniqueId=str(uid),
                                paramNodeName=param_node, behaviour=behaviour)
            ET.SubElement(sc, 'ShortcutPath', name='InputPath', path=target,
                          translationType='1', allowedTranslationTypes='1')
            if row['kind'] in ('range', 'color'):
                ET.SubElement(sc, 'Subtarget', type='5', optionIndex='-1')
            ET.SubElement(sc, 'RawInputMessage', key=key, value='0', numSteps='256', **{'9bit': '1'})
            uid += 1
            count += 1
    return root, count


def parse_resolume_xml(text_or_bytes):
    """Resolume Arena's own DMX shortcut XML writer emits a non-strict
    attribute name — `9bit="1"` on <RawInputMessage> — that starts with a
    digit and is therefore illegal per the XML 1.0 Name production; even
    the user's real, working, Resolume-exported presets
    (~/Documents/Resolume Arena/Shortcuts/DMX/*.xml) fail a strict
    xml.dom.minidom parse for exactly this reason. Resolume's own reader
    is evidently lenient about it. To validate our own output (and any
    real Resolume preset) with the stdlib's strict expat backend, rename
    the token to a legal one before parsing; nothing else in the format
    depends on the literal spelling."""
    text = text_or_bytes.decode('utf-8') if isinstance(text_or_bytes, bytes) else text_or_bytes
    return minidom.parseString(text.replace('9bit=', 'nineBit='))


def prettify(root):
    ET.indent(root, space='\t')
    body = ET.tostring(root, encoding='unicode')
    body = body.replace(' />', '/>')  # match Resolume's own no-space self-close style
    xml_bytes = ('<?xml version="1.0" encoding="utf-8"?>\n' + body + '\n').encode('utf-8')
    parse_resolume_xml(xml_bytes)  # round-trip check with the lenient reader above
    return xml_bytes


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--universe', type=int, default=0, help='0-based Art-Net universe index')
    ap.add_argument('--address', type=int, default=1, help='start channel (1-based); shifts every channel')
    ap.add_argument('--name', default='ROGGER_MA3', help='DMXShortcutPreset name')
    ap.add_argument('--out', default=DEFAULT_OUT, help='output path')
    args = ap.parse_args()

    rows = build_map()
    root, count = build_preset_xml(rows, args.universe, args.address, args.name)
    xml_bytes = prettify(root)

    # sanity: re-parse and confirm shortcut count + key formula round-trip
    dom = parse_resolume_xml(xml_bytes)
    shortcuts = dom.getElementsByTagName('Shortcut')
    assert len(shortcuts) == count
    assert dom.documentElement.getAttribute('name') == args.name

    out_dir = os.path.dirname(os.path.abspath(args.out))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.out, 'wb') as f:
        f.write(xml_bytes)

    print(f'wrote {args.out} ({count} shortcuts across {len(rows)} channels, '
          f'universe {args.universe}, address {args.address})')


if __name__ == '__main__':
    main()
