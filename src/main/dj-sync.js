'use strict';
// Rebuilds the DJ Intro page from a live Resolume composition.
//
// The page is a column launcher: each button fires one column of the group
// that holds the name-source layer, so every layer in that group (name plate,
// DJ booth video, wings, banner) cuts together.
//
// That only works if the group's layers agree about what lives in each column.
// They are authored by hand, and they drift — a clip dropped one slot over
// leaves a button that says one name and shows another, which nobody notices
// until it is on the screens. So the sync also cross-checks the columns and
// reports the disagreements instead of copying them silently.
//
// Pure: the caller does the HTTP and the saving.

const SWATCHES = ['#00e0ff', '#ffd93d', '#2ee66b', '#b46bff', '#ff7a1a', '#3aa0ff', '#ff3df0', '#eaeef5'];
const PLACEHOLDER_COLOR = '#3a3f47';
const OFF_COLOR = '#ff4757';

const clipName = clip => clip?.name?.value ?? '';
const layerName = layer => layer?.name?.value ?? '';

/** Strip everything but letters and digits so authoring conventions stop mattering. */
function normalise(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Two clip names refer to the same thing if either name contains the other. */
function namesAgree(a, b) {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return true;         // nothing to disagree about
  return x.includes(y) || y.includes(x);
}

/**
 * A layer is keyed by column when its clips carry distinct names — a DJ booth
 * layer with one clip per artist. Layers that repeat the same clip across every
 * column (a static backplate) say nothing about which artist a column is, so
 * they are not worth cross-checking against.
 */
function isColumnKeyed(layer) {
  const names = (layer?.clips ?? []).map(clipName).filter(Boolean);
  if (names.length < 3) return false;
  return new Set(names.map(normalise)).size > names.length / 2;
}

/** The layer whose clip names are the DJ names — by convention it says NAME. */
function findNameLayer(comp) {
  const layers = comp?.layers ?? [];
  const index = layers.findIndex(l => layerName(l).toUpperCase().includes('NAME'));
  return index === -1 ? null : { index, layer: layers[index] };
}

/** The group containing a layer, by id, plus its sibling layers resolved. */
function findGroup(comp, layer) {
  const groups = comp?.layergroups ?? [];
  const index = groups.findIndex(g => (g?.layers ?? []).some(l => (l?.id ?? l) === layer?.id));
  if (index === -1) return null;
  const byId = new Map((comp?.layers ?? []).map(l => [l?.id, l]));
  const members = (groups[index].layers ?? [])
    .map(l => byId.get(l?.id ?? l))
    .filter(Boolean);
  return { index, group: groups[index], members };
}

/**
 * Compare the name-source column against the other column-keyed layers in the
 * group. Returns one entry per column that disagrees.
 */
function crossCheck({ nameLayer, members, columns }) {
  const others = members.filter(l => l !== nameLayer && isColumnKeyed(l));
  const problems = [];
  for (let i = 0; i < columns; i += 1) {
    const expected = clipName(nameLayer.clips?.[i]);
    if (!expected) continue;
    for (const other of others) {
      const actual = clipName(other.clips?.[i]);
      if (!actual) continue;                 // empty slot: the layer sits this one out
      if (namesAgree(expected, actual)) continue;
      problems.push({ column: i + 1, expected, layer: layerName(other), actual });
    }
  }
  return problems;
}

/**
 * Build the DJ page from a composition.
 * @param {object} comp        parsed /api/v1/composition
 * @param {Array} current      the existing fxButtons3 array
 * @returns {{buttons: Array, report: object}}
 * @throws when the composition has no name-source layer to read
 */
function buildDjButtons(comp, current) {
  const found = findNameLayer(comp);
  if (!found) throw new Error('No layer with NAME in its title');
  const { index: layerIndex, layer } = found;
  const group = findGroup(comp, layer);
  const clips = layer.clips ?? [];

  const address = i => (group
    ? `/composition/groups/${group.index + 1}/columns/${i + 1}/connect`
    : `/composition/layers/${layerIndex + 1}/clips/${i + 1}/connect`);

  let synced = 0;
  let cleared = 0;
  const buttons = current.map((button, i) => {
    const name = clipName(clips[i]) || null;
    // A slot that used to hold a name and no longer does is stale: clearing it
    // matters more than preserving it, because a button that fires an empty
    // column blacks out the plate mid-set.
    const wasSynced = button.address === address(i);
    const isPlaceholder = button.label.startsWith('#') || button.label.startsWith('3·FX');

    if (!name && !isPlaceholder && !wasSynced) return button; // hand-made button: leave it alone
    if (name) synced += 1;
    else if (!isPlaceholder) cleared += 1;

    return {
      ...button,
      label: name ?? `#${i + 1}`,
      icon: name ? (name === 'OFF' ? '✕' : '♪') : '·',
      color: name ? (name === 'OFF' ? OFF_COLOR : SWATCHES[i % SWATCHES.length]) : PLACEHOLDER_COLOR,
      mode: 'hold',
      type: 'int',
      value: 1,
      releaseValue: 0,
      releaseAddress: '',
      address: address(i),
    };
  });

  const report = {
    layer: layerName(layer),
    group: group ? (group.group?.name?.value ?? `group ${group.index + 1}`) : null,
    synced,
    cleared,
    slots: current.length,
    named: clips.filter(c => clipName(c)).length,
    mismatches: group ? crossCheck({ nameLayer: layer, members: group.members, columns: Math.min(current.length, clips.length) }) : [],
  };
  return { buttons, report };
}

/** One-line summary for the toast; the detail goes in the panel. */
function summarise(report) {
  const bits = [`Synced ${report.synced} name${report.synced === 1 ? '' : 's'} from ${report.layer}`];
  if (report.group) bits.push(`(group ${report.group})`);
  if (report.cleared) bits.push(`— ${report.cleared} stale slot${report.cleared === 1 ? '' : 's'} cleared`);
  return bits.join(' ');
}

module.exports = { buildDjButtons, summarise, crossCheck, isColumnKeyed, namesAgree, normalise, findNameLayer, findGroup };
