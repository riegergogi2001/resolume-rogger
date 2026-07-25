// AKAI page: read-only APC40 mkII cheat sheet rendered from the generated
// mapping snapshot (akai-map.js). Tapping a control only shows its detail —
// this page never sends OSC.
import { APC } from './akai-map.js';

export function renderAkaiPage(el) {
  el.classList.add('akai-page');

  const detail = document.createElement('div');
  detail.className = 'apc-detail u-num';
  detail.textContent = 'Tap any control to see what it does.';

  let picked = null;
  function pick(node, c, name) {
    if (picked) picked.classList.remove('picked');
    picked = node;
    node.classList.add('picked');
    const heads = c.detail.map(d => d.name).join('  +  ');
    const paths = c.detail.map(d => d.path).join('  ·  ');
    detail.innerHTML = `<b>${name}</b> — ${heads}<span class="apc-paths">${paths}</span>`;
  }

  function cellButton(c, cls, fallbackName) {
    const b = document.createElement('button');
    b.className = cls;
    if (!c) {
      b.classList.add('unmapped');
      b.disabled = true;
      return b;
    }
    if (c.hex) b.style.setProperty('--pad', c.hex);
    const tag = c.tag && c.tag !== 'abs' ? `<i>${c.tag}</i>` : '';
    b.innerHTML = `<span>${c.label || ''}</span>${c.more ? `<em>+${c.more}</em>` : ''}${tag}`;
    b.addEventListener('pointerdown', () => pick(b, c, fallbackName));
    return b;
  }

  const head = document.createElement('div');
  head.className = 'bank-title';
  head.innerHTML = `APC40 mkII · <span class="u-num">${APC.meta.mapping}</span>` +
    `<span class="apc-meta u-num">${APC.meta.composition} · ${APC.meta.generated}</span>`;

  const board = document.createElement('div');
  board.className = 'apc-board';

  // ---- clip grid + scene launch column ----
  const gridZone = document.createElement('div');
  gridZone.className = 'apc-zone';
  APC.grid.forEach((row, ri) => {
    const zone = document.createElement('div');
    zone.className = 'apc-zone-label u-caps';
    zone.textContent = row.zone;
    gridZone.appendChild(zone);
    row.cells.forEach((c, ci) => {
      gridZone.appendChild(cellButton(c, 'apc-pad', `Pad ${ri + 1}·${ci + 1}`));
    });
    const sc = APC.scenes[ri];
    gridZone.appendChild(cellButton(sc, 'apc-pad apc-scene', `Scene ${ri + 1}`));
  });
  const corner = document.createElement('div');
  corner.className = 'apc-zone-label u-caps';
  corner.textContent = 'track strip ↓ / scene ↑';
  gridZone.appendChild(corner);
  for (let ch = 1; ch <= 8; ch++) {
    const n = document.createElement('div');
    n.className = 'apc-zone-label apc-ch u-num';
    n.textContent = `T${ch}`;
    gridZone.appendChild(n);
  }
  gridZone.appendChild(document.createElement('div'));

  // ---- per-track button strip ----
  APC.strip.forEach(row => {
    const zone = document.createElement('div');
    zone.className = 'apc-zone-label u-caps';
    zone.textContent = row.name;
    gridZone.appendChild(zone);
    row.cells.forEach((c, i) => {
      gridZone.appendChild(cellButton(c, 'apc-pad apc-small', `${row.name} · track ${i + 1}`));
    });
    gridZone.appendChild(document.createElement('div'));
  });

  // ---- knobs ----
  const knobRow = (cells, name, ccBase) => {
    const zone = document.createElement('div');
    zone.className = 'apc-zone-label u-caps';
    zone.textContent = name;
    gridZone.appendChild(zone);
    cells.forEach((c, i) => {
      gridZone.appendChild(cellButton(c, 'apc-pad apc-knob', `${name} ${i + 1} (CC${ccBase + i})`));
    });
    gridZone.appendChild(document.createElement('div'));
  };
  knobRow(APC.knobs.track, 'TOP KNOBS', 48);
  knobRow(APC.knobs.device, 'DEV KNOBS', 16);

  // ---- faders ----
  const zone = document.createElement('div');
  zone.className = 'apc-zone-label u-caps';
  zone.textContent = 'FADERS';
  gridZone.appendChild(zone);
  APC.faders.tracks.forEach((c, i) => {
    gridZone.appendChild(cellButton(c, 'apc-pad apc-fader', `Fader track ${i + 1}`));
  });
  gridZone.appendChild(cellButton(APC.faders.master, 'apc-pad apc-fader', 'Master fader'));

  board.appendChild(gridZone);

  // ---- transport / misc buttons + crossfader ----
  const misc = document.createElement('div');
  misc.className = 'apc-misc';
  const xf = APC.faders.crossfader;
  if (xf) misc.appendChild(cellButton({ ...xf, label: `XFADE → ${xf.label}` }, 'apc-chip', 'Crossfader'));
  APC.buttons.forEach(b => {
    misc.appendChild(cellButton({ ...b, label: `${b.name} → ${b.label}` }, 'apc-chip', b.name));
  });
  board.appendChild(misc);

  el.append(head, board, detail);
}
