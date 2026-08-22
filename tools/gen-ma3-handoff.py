#!/usr/bin/env python3
"""Generate docs/ma3-handoff.html — a self-contained dark cheat sheet for
the local LD, built from tools/dmx_map.py so it can never drift from the
GDTF/Resolume preset it documents.

Run:
    python3 tools/gen-ma3-handoff.py
"""
import datetime
import html
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dmx_map import DEFAULT_CONFIG_PATH, build_map  # noqa: E402

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(REPO_ROOT, 'docs', 'ma3-handoff.html')

KIND_LABEL = {
    'range': 'range (fader)',
    'event': 'event (momentary)',
    'bool': 'bool (toggle)',
    'choice': 'choice',
    'color': 'color',
}

BLOCK_ORDER = ['Dimmer', 'Levels', 'Flash', 'Bump', 'Util', 'Color', 'FX', 'Logo', 'DJ', 'Tempo', 'Transform']


def e(s):
    return html.escape(str(s), quote=True)


def pct(v):
    return round(v / 255 * 100)


def render_row(row):
    targets_html = '<br>'.join(f'<code>{e(t)}</code>' for t in row['targets'])
    kind_html = KIND_LABEL.get(row['kind'], row['kind'])
    geom = row['geometry']
    geom_html = geom if geom == 'Main' else f"{geom} / {row['component']}"
    return (
        '<tr>'
        f'<td class="num">{row["ch"]}</td>'
        f'<td>{e(row["name"])}</td>'
        f'<td>{kind_html}</td>'
        f'<td class="num">{row["default"]} <span class="dim">({pct(row["default"])}%)</span></td>'
        f'<td>{geom_html}</td>'
        f'<td class="path">{targets_html}</td>'
        f'<td class="dim">{e(row["note"])}</td>'
        '</tr>'
    )


def render_table(rows):
    out = ['<table>',
           '<thead><tr><th>Ch</th><th>Name</th><th>Kind</th><th>Default</th>'
           '<th>Geometry</th><th>Targets</th><th>Note</th></tr></thead>', '<tbody>']
    current_block = None
    for row in rows:
        if row['block'] != current_block:
            current_block = row['block']
            out.append(f'<tr class="group"><td colspan="7">{e(current_block)}</td></tr>')
        out.append(render_row(row))
    out.append('</tbody></table>')
    return '\n'.join(out)


def build_html(rows, config_path):
    today = datetime.date.today().isoformat()
    config_name = os.path.basename(config_path)
    table_html = render_table(rows)

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ROGGER &rarr; grandMA3 handoff</title>
<style>
  :root {{
    --bg: #0a0b0d; --panel: #131519; --panel-2: #1a1d22; --panel-3: #22262c;
    --line: #23262c; --line-bright: #3a3f47; --text: #eaeef5; --text-dim: #8e9299;
    --accent: #00e0ff; --ok: #2ee66b; --warn: #ffb400; --err: #ff4757; --radius: 10px;
  }}
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  body {{
    background: var(--bg); color: var(--text);
    font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
    padding: 24px; max-width: 1180px; margin: 0 auto;
  }}
  .num {{ font-variant-numeric: tabular-nums; }}
  header {{ display: flex; align-items: baseline; gap: 16px; flex-wrap: wrap; margin-bottom: 6px; }}
  h1 {{ font-size: 22px; letter-spacing: 0.08em; }}
  h1 b {{ color: var(--accent); }}
  .meta {{ color: var(--text-dim); font-size: 12px; }}
  .hint {{ color: var(--text-dim); font-size: 13px; margin: 6px 0 20px; max-width: 74ch; line-height: 1.5; }}
  h2 {{
    font-size: 12px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase;
    color: var(--text-dim); margin: 30px 0 10px; display: flex; align-items: center; gap: 10px;
  }}
  h2::after {{ content: ""; flex: 1; height: 1px; background: var(--line); }}
  .card {{
    border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel);
    padding: 16px 18px; margin-bottom: 12px;
  }}
  .card h3 {{ font-size: 13px; color: var(--accent); margin-bottom: 8px; }}
  .card ol, .card ul {{ margin-left: 20px; line-height: 1.7; font-size: 13px; }}
  .card p {{ font-size: 13px; line-height: 1.6; color: var(--text); }}
  .card p + p {{ margin-top: 8px; }}
  code {{
    font-family: ui-monospace, "SF Mono", monospace; font-size: 12px;
    background: var(--panel-3); border: 1px solid var(--line-bright);
    border-radius: 4px; padding: 1px 5px; color: var(--accent);
  }}
  .dim {{ color: var(--text-dim); }}
  .grid2 {{ display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }}
  @media (max-width: 820px) {{ .grid2 {{ grid-template-columns: 1fr; }} }}
  .tablewrap {{ overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); }}
  table {{ width: 100%; border-collapse: collapse; font-size: 12px; }}
  th, td {{ text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }}
  th {{ color: var(--text-dim); font-size: 10px; text-transform: uppercase; letter-spacing: 0.1em;
        position: sticky; top: 0; background: var(--panel); }}
  tr.group td {{
    background: var(--panel-2); color: var(--accent); font-weight: 800; font-size: 10px;
    text-transform: uppercase; letter-spacing: 0.12em; padding: 8px 10px;
  }}
  td.path code {{ display: inline-block; margin: 1px 0; }}
  footer {{ margin: 30px 0 8px; color: var(--text-dim); font-size: 11px; }}
</style>
</head>
<body>
<header>
  <h1>ROGGER &rarr; grand<b>MA3</b> handoff</h1>
  <div class="meta">generated {e(today)} &middot; from {e(config_name)}</div>
</header>
<p class="hint">
  This turns the tested ROGGER show into a single grandMA3 fixture: one GDTF,
  one DMX mode, 98 channels on one universe, driving the exact same Resolume
  OSC targets the ROGGER touchscreen drives. Patch it once and the LD can run
  flash/bump/DJ/color/transform cues from the console instead of the tablet.
</p>

<h2>Patch it</h2>
<div class="card">
  <ol>
    <li>Copy the .gdtf onto the console:
      <br>macOS &mdash; <code>~/MALightingTechnology/gma3_library/fixturetypes/</code>
      <br>Windows &mdash; <code>C:\\ProgramData\\MALightingTechnology\\gma3_library\\fixturetypes\\</code>
      <br>console &mdash; USB import into the fixture type library.</li>
    <li>Patch &rarr; Insert new fixture &rarr; Import, pick fixture type
      &ldquo;ROGGER Resolume Remote&rdquo;, mode &ldquo;ROGGER v2 98ch&rdquo;.</li>
    <li>Address it, e.g. universe <b>U</b> address <b>1</b> &mdash; this
      <b>must match</b> the universe/address the Resolume DMX preset was
      generated for (see Network below).</li>
  </ol>
</div>

<h2>Network</h2>
<div class="grid2">
  <div class="card">
    <h3>grandMA3</h3>
    <p>Menu &rarr; In &amp; Out &rarr; DMX Protocols &rarr; Art-Net &rarr; add an output.
    Net 0 / Subnet 0 / Universe 0 matches this preset's defaults (match
    whatever universe you actually patched the fixture on). Destination:
    <b>unicast the Resolume machine's IP</b>, or broadcast on the same
    subnet &mdash; both work.</p>
  </div>
  <div class="card">
    <h3>Resolume</h3>
    <p>Preferences &rarr; DMX &rarr; <b>New Input</b> (creates an Art-Net input,
    Channel Offset 0 / Subnet 0 / Universe 0 by default) &rarr; set
    <b>Network Adapter</b> to the real NIC on the MA3's subnet (or
    &ldquo;Localhost&rdquo; only if the console and Resolume are the exact
    same machine). Resolume only starts listening on UDP 6454 once an input
    exists <i>and</i> a valid adapter is picked &mdash; sending to
    <code>127.0.0.1</code> does nothing if a real NIC (e.g. Wi-Fi) is
    selected instead. OSC and the webserver stay untouched &mdash; ROGGER
    keeps driving Resolume over OSC exactly as before; this is a second,
    parallel input.</p>
  </div>
</div>

<h2>Resolume side</h2>
<div class="card">
  <p>Run <code>tools/install-resolume-preset.sh</code> (quit Resolume Arena
  first &mdash; it refuses to run while Arena is open) to copy
  <code>ROGGER_MA3.xml</code> into
  <code>~/Documents/Resolume Arena/Shortcuts/DMX/</code>, select it as the
  active preset, and (if no Art-Net input exists yet) add one to
  <code>Preferences/dmx.xml</code>. It never touches which network adapter
  is bound &mdash; pick that yourself in Preferences &rarr; DMX after
  launching Arena. Or do it all by hand: copy the file into that folder,
  then in Resolume go to Shortcuts &rarr; DMX and choose
  &ldquo;ROGGER_MA3&rdquo; from the preset list.</p>
</div>

<h2>How channels behave</h2>
<div class="card">
  <ul>
    <li><b>range</b> &mdash; works like a fader: 0&ndash;255 maps linearly onto the target's 0..1 range.</li>
    <li><b>event</b> &mdash; momentary: DMX &ge;50% (&ge;128) = press (fires the target), &lt;50% = release.
      The flash-bank clips are piano mode, so <b>hold</b> the button/fader up to keep the effect running.</li>
    <li><b>bool</b> &mdash; toggle: DMX &ge;50% = true, &lt;50% = false.</li>
    <li><b>choice</b> &mdash; a small set of discrete positions (AUTO VJ: off / target 1 / 2 / 3).</li>
    <li><b>color</b> &mdash; five RGB sub-fixtures (BG, LOGO, FLASH, MORPH1, MORPH2), each just 3
      range channels (R/G/B) &mdash; drive them with the MA3 color picker like any other fixture.</li>
  </ul>
</div>

<h2>Channel map ({len(rows)} channels)</h2>
<div class="tablewrap">
{table_html}
</div>

<footer>Generated {e(today)} by tools/gen-ma3-handoff.py from {e(config_name)} &middot;
regenerate with <code>npm run ma3</code>.</footer>
</body>
</html>
"""


def main():
    rows = build_map()
    doc = build_html(rows, DEFAULT_CONFIG_PATH)
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, 'w', encoding='utf-8') as f:
        f.write(doc)
    print(f'wrote {OUT_PATH} ({len(rows)} channels)')


if __name__ == '__main__':
    main()
