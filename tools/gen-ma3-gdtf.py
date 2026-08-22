#!/usr/bin/env python3
"""Generate the ROGGER grandMA3 GDTF fixture from the DMX channel map.

Writes dist-ma3/ROGGER@Resolume Remote@v2.gdtf — a zip containing a single
description.xml (GDTF 1.2), one DMX mode "ROGGER v2 98ch" with 98 channels,
patchable on a grandMA3 console (USB import or
~/MALightingTechnology/gma3_library/fixturetypes/ on macOS).

Structure and attribute conventions (element order, DMXChannel/
LogicalChannel/ChannelFunction/ChannelSet shape, identity Position matrix
syntax, "<Geometry>_<Attribute>.<Attribute>.<ChannelFunction Name>"
InitialFunction format, WheelSlotIndex on ChannelSet) were reverse-engineered
from a real MA3-exported GDTF 1.2 fixture (Cameo Evos W7) rather than typed
from the spec alone, to maximize the odds this actually imports cleanly.

One deliberate deviation from a literal reading of the design spec: the
spec's prose says DMXChannel should carry both `Default` and `Highlight` as
"<v>/1". A real GDTF 1.2 DMXChannel element has no `Default` attribute at
all (checked against the Cameo reference) — only Offset/DMXBreak/Geometry/
InitialFunction/Highlight; the default lives on <ChannelFunction Default=...>
instead. This script follows the real schema: Highlight="<default>/1" on
DMXChannel, Default="<default>/1" on ChannelFunction, no invented
DMXChannel/Default attribute that risks tripping a strict GDTF validator.

Run:
    python3 tools/gen-ma3-gdtf.py
"""
import os
import re
import sys
import xml.dom.minidom as minidom
import xml.etree.ElementTree as ET
import zipfile
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dmx_map import build_map  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(REPO_ROOT, 'dist-ma3', 'ROGGER@Resolume Remote@v2.gdtf')

# Fixed across regenerations (uuid5(NAMESPACE_DNS, 'rogger.resolume.remote.v2')).
FIXTURE_TYPE_ID = 'F0D3A0EF-6238-59D0-B5E0-AF01B7648416'

IDENTITY_MATRIX = ('{1.000000,0.000000,0.000000,0.000000}'
                    '{0.000000,1.000000,0.000000,0.000000}'
                    '{0.000000,0.000000,1.000000,0.000000}'
                    '{0.000000,0.000000,0.000000,1.000000}')

COLOR_GEOMETRIES = ('BG', 'LOGO', 'FLASH', 'MORPH1', 'MORPH2')
CUSTOM_BLOCKS = ('Levels', 'Flash', 'Bump', 'Util', 'FX', 'Logo', 'DJ', 'Tempo', 'Transform')

EVENT_SETS = (('0/1', 'Release'), ('128/1', 'Press'))
BOOL_SETS = (('0/1', 'Off'), ('128/1', 'On'))
CHOICE_SETS = (('0/1', 'Off'), ('64/1', 'Target 1'), ('128/1', 'Target 2'), ('192/1', 'Target 3'))


def sanitize(label):
    """'BOOM BLUR' -> 'BoomBlur'; '#21' -> 'Ch21'."""
    parts = [p for p in re.split(r'[^A-Za-z0-9]+', label) if p]
    out = ''.join(p.capitalize() for p in parts)
    if not out:
        out = 'Ch'
    if out[0].isdigit():
        out = 'Ch' + out
    return out


def pretty(label, limit=12):
    label = label.strip()
    return label if len(label) <= limit else label[:limit].rstrip()


def attribute_name_for(row):
    """The GDTF <Attribute Name=...> this channel's LogicalChannel/
    ChannelFunction reference. Dimmer and the RGB triplet reuse one shared
    Attribute across geometries (standard GDTF practice, mirrors the Cameo
    reference). Every other channel gets a dedicated custom Attribute; DJ
    block channels are prefixed DJ<NN>_ so labels that repeat elsewhere
    (e.g. "PULLMAXX" on both ch 67 and ch 88, "LOGO OFF" on ch 66 and 92)
    don't collide."""
    if row['block'] == 'Dimmer':
        return 'Dimmer'
    if row['kind'] == 'color':
        return f"ColorAdd_{row['component']}"
    if row['block'] == 'DJ':
        idx = row['ch'] - 69 + 1
        return f"DJ{idx:02d}_{sanitize(row['name'])}"
    return sanitize(row['name'])


def build_attribute_defs(rows):
    """Ordered, de-duplicated (name -> (feature, activation_group, unit, pretty))."""
    defs = {}
    defs['Dimmer'] = ('Dimmer.Dimmer', None, 'None', 'Dim')
    for comp in ('R', 'G', 'B'):
        defs[f'ColorAdd_{comp}'] = ('Color.RGB', 'ColorRGB', 'ColorComponent', comp)
    for row in rows:
        name = attribute_name_for(row)
        if name in defs:
            continue
        if row['block'] == 'Dimmer' or row['kind'] == 'color':
            continue
        defs[name] = (f"{row['block']}.{row['block']}", None, 'None', pretty(row['name']))
    return defs


def el(parent, tag, **attrs):
    return ET.SubElement(parent, tag, {k: v for k, v in attrs.items() if v is not None})


def build_xml(rows):
    gdtf = ET.Element('GDTF', DataVersion='1.2')
    ft = ET.SubElement(gdtf, 'FixtureType', {
        'Name': 'ROGGER Resolume Remote',
        'ShortName': 'ROGGER',
        'LongName': 'ROGGER Resolume Remote v2',
        'Manufacturer': 'ROGGER',
        'Description': 'Generated from the ROGGER show config (configs/campus-forum-stage.json) '
                        'by tools/gen-ma3-gdtf.py — one DMX mode driving the same OSC functions '
                        'ROGGER drives in Resolume.',
        'FixtureTypeID': FIXTURE_TYPE_ID,
        'RefFT': '',
        'Thumbnail': '',
        'CanHaveChildren': 'No',
    })

    # ---- AttributeDefinitions ---------------------------------------------
    ad = ET.SubElement(ft, 'AttributeDefinitions')
    ags = ET.SubElement(ad, 'ActivationGroups')
    el(ags, 'ActivationGroup', Name='ColorRGB')

    fgs = ET.SubElement(ad, 'FeatureGroups')
    fg = el(fgs, 'FeatureGroup', Name='Dimmer', Pretty='Dimmer')
    el(fg, 'Feature', Name='Dimmer')
    fg = el(fgs, 'FeatureGroup', Name='Color', Pretty='Color')
    el(fg, 'Feature', Name='RGB')
    for block in CUSTOM_BLOCKS:
        fg = el(fgs, 'FeatureGroup', Name=block, Pretty=block)
        el(fg, 'Feature', Name=block)

    attr_defs = build_attribute_defs(rows)
    attrs_el = ET.SubElement(ad, 'Attributes')
    for name, (feature, activation, unit, pr) in attr_defs.items():
        el(attrs_el, 'Attribute', Name=name, Feature=feature, ActivationGroup=activation,
           PhysicalUnit=unit, Pretty=pr)

    # ---- Wheels (none) -------------------------------------------------------
    ET.SubElement(ft, 'Wheels')

    # ---- PhysicalDescriptions (minimal valid) ---------------------------------
    pd = ET.SubElement(ft, 'PhysicalDescriptions')
    el(pd, 'ColorSpace', Mode='sRGB', Name='')
    ET.SubElement(pd, 'AdditionalColorSpaces')
    ET.SubElement(pd, 'Gamuts')
    ET.SubElement(pd, 'Filters')
    ET.SubElement(pd, 'Emitters')

    # ---- Models ------------------------------------------------------------------
    models = ET.SubElement(ft, 'Models')
    el(models, 'Model', Name='Base', PrimitiveType='Cube',
       Length='0.100000', Width='0.100000', Height='0.100000')

    # ---- Geometries -----------------------------------------------------------------
    geos = ET.SubElement(ft, 'Geometries')
    main = el(geos, 'Geometry', Name='Main', Model='Base', Position=IDENTITY_MATRIX)
    for g in COLOR_GEOMETRIES:
        el(main, 'Geometry', Name=g, Model='Base', Position=IDENTITY_MATRIX)

    # ---- DMXModes -----------------------------------------------------------------------
    modes = ET.SubElement(ft, 'DMXModes')
    mode = el(modes, 'DMXMode', Name='ROGGER v2 98ch', Geometry='Main')
    chans = ET.SubElement(mode, 'DMXChannels')

    for row in rows:
        geometry = row['geometry']
        attr_name = attribute_name_for(row)
        default_str = f"{row['default']}/1"
        cf_name = row['name']
        initial_function = f"{geometry}_{attr_name}.{attr_name}.{cf_name}"

        dmx_ch = el(chans, 'DMXChannel', DMXBreak='1', Geometry=geometry,
                    Highlight=default_str, InitialFunction=initial_function,
                    Offset=str(row['ch']))
        snap = 'Yes' if row['kind'] in ('event', 'bool', 'choice') else 'No'
        lc = el(dmx_ch, 'LogicalChannel', Attribute=attr_name, DMXChangeTimeLimit='0.000000',
                 Master='None', MibFade='0.000000', Snap=snap)
        cfun = el(lc, 'ChannelFunction', Attribute=attr_name, CustomName='', DMXFrom='0/1',
                   Default=default_str, Max='1.000000', Min='0.000000', Name=cf_name,
                   OriginalAttribute='', PhysicalFrom='0.000000', PhysicalTo='1.000000',
                   RealAcceleration='0.000000', RealFade='0.000000')

        if row['kind'] == 'event':
            sets = EVENT_SETS
        elif row['kind'] == 'bool':
            sets = BOOL_SETS
        elif row['kind'] == 'choice':
            sets = CHOICE_SETS
        else:
            sets = ()
        for dmx_from, name in sets:
            el(cfun, 'ChannelSet', DMXFrom=dmx_from, Name=name, WheelSlotIndex='0')

    ET.SubElement(mode, 'Relations')
    ET.SubElement(mode, 'FTMacros')

    # ---- Revisions --------------------------------------------------------------------
    revs = ET.SubElement(ft, 'Revisions')
    el(revs, 'Revision', Date=date.today().isoformat(), Text='Generated from ROGGER config', UserID='0')

    # ---- Protocols (none) --------------------------------------------------------------
    ET.SubElement(ft, 'Protocols')

    return gdtf


def prettify(root):
    rough = ET.tostring(root, encoding='utf-8')
    parsed = minidom.parseString(rough)
    pretty_xml = parsed.toprettyxml(indent='  ', encoding='UTF-8')
    # drop minidom's blank lines between siblings
    lines = [ln for ln in pretty_xml.decode('utf-8').split('\n') if ln.strip()]
    return ('\n'.join(lines) + '\n').encode('utf-8')


def validate(xml_bytes, rows):
    """Parse with xml.dom.minidom and run the sanity checks the spec asks for:
    every DMXChannel Attribute exists, every Geometry referenced exists,
    offsets are unique 1..98."""
    dom = minidom.parseString(xml_bytes)
    ft = dom.getElementsByTagName('FixtureType')[0]

    defined_attrs = {a.getAttribute('Name') for a in dom.getElementsByTagName('Attribute')}
    defined_geoms = {'Main'} | set(COLOR_GEOMETRIES)

    offsets = []
    for dc in dom.getElementsByTagName('DMXChannel'):
        offsets.append(int(dc.getAttribute('Offset')))
        geom = dc.getAttribute('Geometry')
        assert geom in defined_geoms, f'DMXChannel references undefined Geometry {geom!r}'
        lcs = dc.getElementsByTagName('LogicalChannel')
        assert len(lcs) == 1
        attr = lcs[0].getAttribute('Attribute')
        assert attr in defined_attrs, f'LogicalChannel references undefined Attribute {attr!r}'
        cfs = lcs[0].getElementsByTagName('ChannelFunction')
        assert len(cfs) == 1
        assert cfs[0].getAttribute('Attribute') in defined_attrs

    assert sorted(offsets) == list(range(1, 99)), 'DMXChannel offsets must be a 1..98 permutation'
    assert len(dom.getElementsByTagName('DMXMode')) == 1
    assert ft.getAttribute('FixtureTypeID') == FIXTURE_TYPE_ID
    return True


def main():
    rows = build_map()
    root = build_xml(rows)
    xml_bytes = prettify(root)
    validate(xml_bytes, rows)

    out_dir = os.path.dirname(OUT_PATH)
    os.makedirs(out_dir, exist_ok=True)
    with zipfile.ZipFile(OUT_PATH, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('description.xml', xml_bytes)

    print(f'wrote {OUT_PATH} ({len(rows)} channels, validated)')


if __name__ == '__main__':
    main()
