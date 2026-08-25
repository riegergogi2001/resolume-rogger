#!/usr/bin/env python3
"""Regenerate the APC40 mkII mapping data from the live Resolume files.

Reads (read-only):
  ~/Documents/Resolume Arena/Shortcuts/MIDI/AkaiXboxMaion.xml
  ~/Documents/Resolume Arena/Compositions/<your show>.avc (pass the path as the first argument)

Writes:
  docs/apc40-mapping.html                    (refreshes the /*DATA:START*/ block)

Run again whenever the MIDI mapping or composition changes:
  python3 tools/gen-akai-map.py
"""
import datetime
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

HOME = os.path.expanduser('~')
MAP_SRC = os.path.join(HOME, 'Documents/Resolume Arena/Shortcuts/MIDI/AkaiXboxMaion.xml')
AVC_SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HOME, 'Documents/Resolume Arena/Compositions/show.avc')
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_OUT = os.path.join(REPO, 'docs/apc40-mapping.html')

APC_DEVICE = 'APC40 mkII'

# ---------------- composition names ----------------

def name_of(el):
    p = el.find('Params')
    if p is not None:
        for pa in p.findall('Param'):
            if pa.attrib.get('name') == 'Name':
                return pa.attrib.get('value')
    return None


def abgr_to_hex(v):
    v = int(v)
    r, g, b = v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF
    return f'#{r:02x}{g:02x}{b:02x}'


def load_comp(path):
    avc = ET.parse(path).getroot()
    layers = {i + 1: name_of(L) for i, L in enumerate(avc.findall('Layer'))}
    groups = {i + 1: name_of(G) for i, G in enumerate(avc.findall('Group'))}
    objects = {}
    for el in avc.iter():
        uid = el.attrib.get('uniqueId')
        if uid and el.tag in ('Clip', 'Layer', 'Group'):
            nm = name_of(el)
            if nm:
                objects[uid] = nm
    for i, G in enumerate(avc.findall('Group')):
        objects[G.attrib.get('uniqueId')] = groups[i + 1]
    l12 = {}
    pc = avc.find('PersistentClips')
    if pc is not None:
        for child in pc:
            if child.attrib.get('layerIndex') == '11':
                l12[int(child.attrib['columnIndex']) + 1] = name_of(child.find('Clip'))

    def palette_of(param_color):
        pal = param_color.find('ColorPalette')
        if pal is None:
            return []
        pch = pal.find('Params').find('ParamChoice')
        return [abgr_to_hex(c.attrib.get('value')) for c in pch.findall('Choice')]

    def effect_palette(container, effect_name):
        for rp in container.iter('RenderPass'):
            if rp.attrib.get('name') == effect_name:
                for pcm in rp.iter('ParamColor'):
                    pal = palette_of(pcm)
                    if pal:
                        return pal
        return []

    palettes = {}
    vt = avc.find('VideoTrack')
    palettes['boomer'] = effect_palette(vt, 'BOOMER')
    palettes['bg'] = effect_palette(avc.findall('Group')[0], 'Colorize')
    palettes['logodj'] = effect_palette(avc.findall('Layer')[7], 'OutlineHaze')
    palettes['logomain'] = effect_palette(avc.findall('Layer')[8], 'OutlineHaze')
    comp_name = avc.find('CompositionInfo').attrib.get('name')
    return {'layers': layers, 'groups': groups, 'objects': objects,
            'l12': l12, 'palettes': palettes, 'name': comp_name}


# ---------------- MIDI shortcuts ----------------

def load_shortcuts(path):
    mp = ET.parse(path).getroot()
    rows = []
    for sc in mp.find('ShortcutManager').findall('Shortcut'):
        ip = sc.find("ShortcutPath[@name='InputPath']")
        raw = sc.find('RawInputMessage')
        if ip is None or raw is None:
            continue
        k = int(raw.attrib['key'])
        status, data1 = k & 0xFF, (k >> 8) & 0xFF
        kind = {0x90: 'note', 0xB0: 'cc'}.get(status & 0xF0)
        if kind is None:
            continue
        sub = sc.find('Subtarget')
        rows.append({
            'kind': kind, 'num': data1, 'ch': (status & 0x0F) + 1,
            'path': ip.attrib['path'],
            'behaviour': int(sc.attrib.get('behaviour', 0)),
            'device': sc.attrib.get('inputDeviceName') or '?',
            'subIndex': int(sub.attrib['optionIndex']) if sub is not None else None,
        })
    return rows


# ---------------- labels ----------------

def make_labelers(comp):
    layers, groups, objects, l12 = comp['layers'], comp['groups'], comp['objects'], comp['l12']

    def friendly(path):
        m = re.match(r'/composition/layers/(\d+)/clips/(\d+)/(.*)', path)
        if m:
            ln, cn, tail = int(m.group(1)), int(m.group(2)), m.group(3)
            lname = layers.get(ln, f'Layer {ln}')
            cname = l12.get(cn) if ln == 12 else None
            base = f'{lname} clip {cn}' + (f' ({cname})' if cname else '')
            return f'launch {base}' if tail == 'connect' else f'{base} {tail}'
        m = re.match(r'/composition/layers/(\d+)/(.*)', path)
        if m:
            return f"{layers.get(int(m.group(1)), 'Layer ' + m.group(1))} {m.group(2)}"
        m = re.match(r'/composition/groups/(\d+)/(.*)', path)
        if m:
            return f"{groups.get(int(m.group(1)), 'Group ' + m.group(1))} group {m.group(2)}"
        m = re.match(r'/composition/objects/(\d+)/(.*)', path)
        if m:
            return f"{objects.get(m.group(1), 'object')} {m.group(2)}"
        m = re.match(r'/composition/video/effects/(\w+)/bypassed', path)
        if m:
            return f'{m.group(1)} on/off (composition FX)'
        m = re.match(r'/composition/video/effects/(\w+)/effect/(\S+)', path)
        if m:
            return f'{m.group(1)} {m.group(2)} (composition FX)'
        m = re.match(r'/composition/tempocontroller/(\w+)', path)
        if m:
            tail = {'tempo': 'tempo up/down', 'tempotap': 'tempo tap'}.get(m.group(1), f'tempo {m.group(1)}')
            return tail
        return path.replace('/composition/', '')

    SHORT_RULES = [
        (r'/composition/layers/12/clips/(\d+)/connect', lambda m: (l12.get(int(m.group(1)), f'FX C{m.group(1)}') or '').upper()),
        (r'/composition/layers/12/clips/(\d+)/video/opacity', lambda m: f'FX C{m.group(1)} OPAC'),
        (r'/composition/layers/(\d+)/clips/(\d+)/connect', lambda m: f'V{m.group(1)} C{m.group(2)}'),
        (r'/composition/layers/(\d+)/bypassed', lambda m: (layers.get(int(m.group(1)), 'L' + m.group(1)) or '') + ' ⊘'),
        (r'/composition/layers/(\d+)/solo', lambda m: (layers.get(int(m.group(1)), 'L' + m.group(1)) or '') + ' SOLO'),
        (r'/composition/layers/(\d+)/select', lambda m: (layers.get(int(m.group(1)), 'L' + m.group(1)) or '') + ' SEL'),
        (r'/composition/layers/(\d+)/master', lambda m: layers.get(int(m.group(1)), 'L' + m.group(1))),
        (r'/composition/groups/(\d+)/bypassed', lambda m: (groups.get(int(m.group(1)), 'G' + m.group(1)) or '') + ' ⊘'),
        (r'/composition/groups/(\d+)/solo', lambda m: (groups.get(int(m.group(1)), 'G' + m.group(1)) or '') + ' SOLO'),
        (r'/composition/groups/(\d+)/select', lambda m: (groups.get(int(m.group(1)), 'G' + m.group(1)) or '') + ' SEL'),
        (r'/composition/groups/(\d+)/master', lambda m: (groups.get(int(m.group(1)), 'G' + m.group(1)) or '') + ' GRP'),
        (r'/composition/groups/(\d+)/dashboard/link(\d+)', lambda m: f"{(groups.get(int(m.group(1)), 'G' + m.group(1)) or '')[:5]} D{m.group(2)}"),
        (r'/composition/groups/(\d+)/video/effects/(\w+)/bypassed', lambda m: f"{(groups.get(int(m.group(1)), 'G' + m.group(1)) or '')[:5]} {m.group(2)[:8].upper()} ⊘"),
        (r'/composition/groups/(\d+)/video/effects/\w+/effect/(\S+)', lambda m: f"{(groups.get(int(m.group(1)), 'G' + m.group(1)) or '')[:5]} {m.group(2)[:8].upper()}"),
        (r'/composition/objects/(\d+)/dashboard/link(\d+)', lambda m: f"{(objects.get(m.group(1), 'OBJ') or 'OBJ')[:5]} D{m.group(2)}"),
        (r'/composition/objects/(\d+)/video/effects/\w+/effect/(\S+)', lambda m: f"{(objects.get(m.group(1), 'OBJ') or 'OBJ')[:8]} {m.group(2)[:6].upper()}"),
        (r'/composition/objects/(\d+)/connect', lambda m: f"▶ {(objects.get(m.group(1), 'OBJ') or 'OBJ')[:8]}"),
        (r'/composition/video/effects/boomer/effect/(\w+)bpm', lambda m: f'BOOM {m.group(1)[:5].upper()} BPM'),
        (r'/composition/video/effects/pusher/effect/push!', lambda m: 'PUSH 1'),
        (r'/composition/video/effects/pusher2/effect/push!', lambda m: 'PUSH 2'),
        (r'/composition/video/effects/boomer/effect/(\w+!?)', lambda m: f'BOOM {m.group(1)[:6].upper()}'),
        (r'/composition/video/effects/pusher/effect/(\w+)', lambda m: f'PUSH1 {m.group(1)[:5].upper()}'),
        (r'/composition/video/effects/pusher2/effect/(\w+)', lambda m: f'PUSH2 {m.group(1)[:5].upper()}'),
        (r'/composition/video/effects/(\w+)/bypassed', lambda m: f'{m.group(1).upper()} ⊘'),
        (r'/composition/tempocontroller/tempotap', lambda m: 'TAP'),
        (r'/composition/tempocontroller/resync', lambda m: 'RESYNC'),
        (r'/composition/tempocontroller/tempo$', lambda m: 'TEMPO ±'),
        (r'/composition/tempocontroller/metronome', lambda m: 'METRONOME'),
        (r'/composition/tempocontroller/play', lambda m: 'PLAY'),
        (r'/composition/bypassed', lambda m: 'COMP ⊘'),
        (r'/composition/master', lambda m: 'COMP MASTER'),
        (r'/composition/crossfader/phase', lambda m: 'CROSSFADER'),
        (r'/application/ui/clipsscrollhorizontal', lambda m: 'UI SCROLL ↔'),
        (r'/application/ui/clipsscrollvertical', lambda m: 'UI SCROLL ↕'),
        (r'/audiodevicemanager/params/fftinputgain', lambda m: 'FFT GAIN'),
    ]

    def short(path):
        for pat, fn in SHORT_RULES:
            m = re.match(pat, path)
            if m:
                return fn(m)
        return path.rsplit('/', 2)[-1][:12].upper()

    return friendly, short


GRID_ROWS = [  # top row first, as on the hardware
    {'notes': range(32, 40), 'zone': 'FX 1 · flash clips'},
    {'notes': range(24, 32), 'zone': 'BG + BOOMER color', 'palette': 'bg'},
    {'notes': range(16, 24), 'zone': 'LOGO MAIN color', 'palette': 'logomain'},
    {'notes': range(8, 16), 'zone': 'LOGO DJ color', 'palette': 'logodj'},
    {'notes': range(0, 8), 'zone': 'VIDEO 1 clips'},
]

SCENE_NOTES = [82, 83, 84, 85, 86]
STRIP_ROWS = [(52, 'CLIP STOP'), (51, 'TRK SELECT'), (50, 'ACTIVATOR'), (49, 'SOLO/CUE'), (48, 'REC ARM')]
BUTTON_NAMES = {
    58: 'DEV ←', 59: 'DEV →', 60: 'BANK ←', 61: 'BANK →', 62: 'DEV ON/OFF', 63: 'DEV LOCK',
    64: 'CLIP/DEV', 65: 'DETAIL', 66: 'A/B ASSIGN', 80: 'MASTER', 81: 'STOP ALL CLIPS',
    87: 'PAN', 88: 'SENDS', 89: 'USER', 90: 'METRONOME', 91: 'PLAY', 93: 'RECORD',
    98: 'SHIFT', 99: 'TAP TEMPO', 100: 'NUDGE −', 101: 'NUDGE +', 102: 'SESSION REC', 103: 'BANK'}


def behaviour_tag(b):
    if b & 1024:
        return 'hold'
    if b & 65536:
        return 'step'
    if b & 8:
        return 'abs'
    if b & 4:
        return 'toggle'
    return ''


def distill(comp, shortcuts):
    friendly, short = make_labelers(comp)
    # Shortcuts saved without a device name are still APC presses (the preset
    # was written with the controller unplugged) — keep them on the layout.
    apc = [s for s in shortcuts if s['device'] in (APC_DEVICE, '?')]
    other = [s for s in shortcuts if s['device'] not in (APC_DEVICE, '?')]
    used = set()

    def find(kind, num, ch):
        out = []
        for i, s in enumerate(apc):
            if s['kind'] == kind and s['num'] == num and s['ch'] == ch:
                out.append(s)
                used.add(i)
        # named layer/group targets label better than raw object ids
        out.sort(key=lambda s: s['path'].startswith('/composition/objects/'))
        return out

    def cell(matches, hexes=None):
        if not matches:
            return None
        first = matches[0]
        hx = None
        if hexes and first.get('subIndex') is not None and first['subIndex'] < len(hexes):
            hx = hexes[first['subIndex']]
        return {
            'label': short(first['path']),
            'more': len(matches) - 1,
            'tag': behaviour_tag(first['behaviour']),
            'detail': [{'name': friendly(s['path']), 'path': s['path']} for s in matches],
            'hex': hx,
        }

    grid = []
    for row in GRID_ROWS:
        pal = comp['palettes'].get(row.get('palette', ''), [])
        cells = []
        for n in row['notes']:
            c = cell(find('note', n, 1), pal)
            if c is not None:
                c['note'] = n
                if pal and c['hex']:
                    c['label'] = ''  # a colored pad says it better than text
            cells.append(c)
        grid.append({'zone': row['zone'], 'cells': cells})

    scenes = []
    for n in SCENE_NOTES:
        c = cell(find('note', n, 1))
        if c is not None:
            c['note'] = n
        scenes.append(c)

    strip = []
    for num, name in STRIP_ROWS:
        cells = []
        for ch in range(1, 9):
            c = cell(find('note', num, ch))
            if c is not None:
                c['note'] = num
                c['ch'] = ch
            cells.append(c)
        strip.append({'name': name, 'note': num, 'cells': cells})

    knobs = {'device': [], 'track': []}
    for cc in range(16, 24):
        c = cell(find('cc', cc, 1))
        if c is not None:
            c['cc'] = cc
        knobs['device'].append(c)
    for cc in range(48, 56):
        c = cell(find('cc', cc, 1))
        if c is not None:
            c['cc'] = cc
        knobs['track'].append(c)

    faders = {'tracks': [], 'master': None, 'crossfader': None}
    for ch in range(1, 9):
        c = cell(find('cc', 7, ch))
        if c is not None:
            c['ch'] = ch
        faders['tracks'].append(c)
    faders['master'] = cell(find('cc', 14, 1))
    faders['crossfader'] = cell(find('cc', 15, 1))

    buttons = []
    leftovers = [s for i, s in enumerate(apc) if i not in used]
    by_key = {}
    for s in leftovers:
        by_key.setdefault((s['kind'], s['num'], s['ch']), []).append(s)
    for (kind, num, ch), matches in sorted(by_key.items()):
        c = cell(matches)
        c.update({'kind': kind, 'num': num, 'ch': ch,
                  'name': BUTTON_NAMES.get(num, f'{kind.upper()} {num}') if kind == 'note' else f'CC {num}'})
        buttons.append(c)

    bridge = [{'kind': s['kind'], 'num': s['num'], 'ch': s['ch'],
               'label': friendly(s['path']), 'path': s['path']} for s in other]

    return {
        'meta': {
            'composition': comp['name'],
            'mapping': os.path.basename(MAP_SRC),
            'generated': datetime.date.today().isoformat(),
            'shortcuts': len(shortcuts),
        },
        'grid': grid, 'scenes': scenes, 'strip': strip,
        'knobs': knobs, 'faders': faders, 'buttons': buttons, 'bridge': bridge,
    }


def main():
    comp = load_comp(AVC_SRC)
    shortcuts = load_shortcuts(MAP_SRC)
    data = distill(comp, shortcuts)
    payload = json.dumps(data, ensure_ascii=False, indent=1)

    if os.path.exists(HTML_OUT):
        with open(HTML_OUT, encoding='utf-8') as f:
            html = f.read()
        marked = re.sub(r'/\*DATA:START\*/.*?/\*DATA:END\*/',
                        f'/*DATA:START*/const APC = {payload};/*DATA:END*/',
                        html, flags=re.S)
        if marked != html:
            with open(HTML_OUT, 'w', encoding='utf-8') as f:
                f.write(marked)
            print(f'refreshed data in {HTML_OUT}')
        else:
            print(f'warning: no DATA markers found in {HTML_OUT}', file=sys.stderr)


if __name__ == '__main__':
    main()
