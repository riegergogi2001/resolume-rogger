// ALL as a quick-access trigger. One tap on the ALL chip fires every
// *assigned* colour: each target that ALL covers gets its own ON steps and its
// own colour — what this surface last sent it (color-memory.js), or its chip's
// swatch colour if nothing has been picked yet — on its own addresses. Nothing
// new on the OSC side: it re-sends what the targets already hold.
//
// planRecall() is pure (no DOM, no bridge) so it can be unit-tested; the
// chips call recallAll().

export function hexToRgb01(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padStart(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// A target is a recall trigger when flagged, or when it is the shipped ALL.
export function isRecallTarget(item) {
  return !!item && (item.recall === true || item.id === 'all');
}

// The targets an ALL chip stands for: every other target whose colour
// addresses all lie inside ALL's. MORPH 1/2 are not covered by the shipped ALL.
export function coveredBy(all, t) {
  const bases = Array.isArray(t?.colorBases) ? t.colorBases : [];
  const allBases = Array.isArray(all?.colorBases) ? all.colorBases : [];
  return !!t && t.id !== all?.id && !isRecallTarget(t) && bases.length > 0 && bases.every(b => allBases.includes(b));
}

// Messages to send, in order, plus the colour each covered target ends up on.
export function planRecall(items, all, getColor) {
  const msgs = [];
  const colours = [];
  for (const t of items ?? []) {
    if (!coveredBy(all, t)) continue;
    const rgb = getColor(t.id) ?? hexToRgb01(t.swatch);
    colours.push([t.id, rgb]);
    for (const s of t.onSteps ?? []) msgs.push({ address: s.address, values: s.values ?? [] });
    for (const base of t.colorBases) {
      msgs.push({ address: `${base}/red`, args: [{ type: 'f', value: rgb[0] }] });
      msgs.push({ address: `${base}/green`, args: [{ type: 'f', value: rgb[1] }] });
      msgs.push({ address: `${base}/blue`, args: [{ type: 'f', value: rgb[2] }] });
    }
  }
  return { msgs, colours };
}

export function recallAll(targetsCfg, all, rogger, colorMemory) {
  const { msgs, colours } = planRecall(targetsCfg?.items, all, id => colorMemory.getColor(id));
  for (const m of msgs) {
    if (m.args) rogger.sendTyped(m.address, m.args);
    else rogger.send(m.address, m.values);
  }
  for (const [id, rgb] of colours) colorMemory.setColor(id, rgb);
  return msgs.length;
}
