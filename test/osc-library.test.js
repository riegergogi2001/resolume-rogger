'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const configStore = require('../src/main/config-store.js');

const libUrl = pathToFileURL(path.join(__dirname, '..', 'src/renderer/js/osc-library.js')).href;
const showConfigPath = path.join(__dirname, '..', 'configs', 'show.json');

const VALID_KINDS = new Set(['event', 'float', 'int', 'bool', 'choice', 'string']);
const ALLOWED_PLACEHOLDERS = new Set(['L', 'C', 'N', 'G', 'D', 'FX', 'P', 'K']);

// Regex fragments used to turn a LIBRARY address template into a matcher
// for concrete addresses pulled out of real config files.
const PLACEHOLDER_PATTERNS = {
  L: '\\d+', C: '\\d+', N: '\\d+', G: '\\d+', D: '\\d+',
  // A parameter name keeps its punctuation: Resolume lower-cases and strips
  // spaces but leaves hyphens and "!" alone, so Slice-O-Rama addresses as
  // slice-o-rama and PUSH! as push!. Verified live against Arena 7.26.
  FX: '[a-z0-9]+', P: '[a-z0-9!-]+', K: '[1-8]',
};

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function templateToRegex(tmpl) {
  let out = '';
  let lastIndex = 0;
  const re = /\{(\w+)\}/g;
  let m;
  while ((m = re.exec(tmpl))) {
    out += escapeRegex(tmpl.slice(lastIndex, m.index));
    out += PLACEHOLDER_PATTERNS[m[1]] || '.+';
    lastIndex = re.lastIndex;
  }
  out += escapeRegex(tmpl.slice(lastIndex));
  return new RegExp(`^${out}$`, 'i');
}

// Walk a ROGGER config object (either config-store.defaults() or a saved
// config JSON) and collect every OSC address it references, per the spec:
// fxButtons*/utilButtons addresses+extraAddress+releaseAddress+macro steps,
// faders/groupFaders addresses+extraAddress+extraAddresses, colorButtons
// address, colorTargets bases (+/red) + onSteps/offSteps, colorMorph,
// triggers engage/analog addresses, sticks x/y addresses.
function collectAddresses(cfg) {
  const out = [];
  const push = (a) => { if (a) out.push(a); };

  for (const key of ['fxButtons', 'fxButtons2', 'fxButtons3', 'utilButtons']) {
    for (const btn of cfg[key] || []) {
      push(btn.address);
      push(btn.extraAddress);
      push(btn.releaseAddress);
      for (const step of btn.macro || []) push(step.address);
    }
  }

  for (const key of ['faders', 'groupFaders']) {
    for (const fader of cfg[key] || []) {
      push(fader.address);
      push(fader.extraAddress);
      for (const extra of fader.extraAddresses || []) push(extra);
    }
  }

  for (const btn of cfg.colorButtons || []) push(btn.address);

  for (const item of cfg.colorTargets?.items || []) {
    for (const base of item.colorBases || []) push(`${base}/red`);
    for (const step of item.onSteps || []) push(step.address);
    for (const step of item.offSteps || []) push(step.address);
  }

  if (cfg.colorMorph) {
    push(cfg.colorMorph.speedAddress);
    push(cfg.colorMorph.bypassAddress);
  }

  for (const t of Object.values(cfg.triggers || {})) {
    push(t.engageAddress);
    push(t.analogAddress);
  }

  for (const s of Object.values(cfg.sticks || {})) {
    push(s.x?.address);
    push(s.y?.address);
  }

  return [...new Set(out)];
}

test('has at least 130 entries', async () => {
  const { LIBRARY } = await import(libUrl);
  assert.ok(LIBRARY.length >= 130, `expected >=130 entries, got ${LIBRARY.length}`);
});

test('every address is unique', async () => {
  const { LIBRARY } = await import(libUrl);
  const addresses = LIBRARY.map(e => e.address);
  assert.equal(new Set(addresses).size, addresses.length, 'duplicate address found');
});

test('every address starts with /', async () => {
  const { LIBRARY } = await import(libUrl);
  for (const entry of LIBRARY) {
    assert.ok(entry.address.startsWith('/'), `"${entry.address}" (${entry.label}) must start with /`);
  }
});

test('every placeholder is from the allowed set', async () => {
  const { LIBRARY, placeholders } = await import(libUrl);
  for (const entry of LIBRARY) {
    for (const key of placeholders(entry.address)) {
      assert.ok(ALLOWED_PLACEHOLDERS.has(key), `"${entry.address}" uses disallowed placeholder {${key}}`);
    }
  }
});

test('every kind is valid', async () => {
  const { LIBRARY } = await import(libUrl);
  for (const entry of LIBRARY) {
    assert.ok(VALID_KINDS.has(entry.kind), `"${entry.address}" has invalid kind "${entry.kind}"`);
  }
});

test('float entries and only float entries carry float:true', async () => {
  const { LIBRARY } = await import(libUrl);
  for (const entry of LIBRARY) {
    if (entry.kind === 'float') {
      assert.equal(entry.float, true, `"${entry.address}" has kind float but float !== true`);
    } else {
      assert.notEqual(entry.float, true, `"${entry.address}" has kind "${entry.kind}" but float === true`);
    }
  }
});

test('every entry has a group and a non-empty label', async () => {
  const { LIBRARY } = await import(libUrl);
  for (const entry of LIBRARY) {
    assert.ok(typeof entry.group === 'string' && entry.group.length > 0, `missing group for "${entry.address}"`);
    assert.ok(typeof entry.label === 'string' && entry.label.length > 0, `missing label for "${entry.address}"`);
  }
});

test('GROUPS lists every LIBRARY group, in first-appearance order, with no dupes', async () => {
  const { LIBRARY, GROUPS } = await import(libUrl);
  const expectedOrder = [
    'Composition', 'Tempo', 'Crossfader', 'Decks', 'Columns', 'Layer groups',
    'Layer', 'Layer FX', 'Clip', 'Clip transport', 'Clip FX', 'Composition FX',
    'Audio', 'Dashboard', 'Selected', 'Timecode',
  ];
  assert.deepEqual(GROUPS, expectedOrder);
  assert.equal(new Set(GROUPS).size, GROUPS.length);
  const seenInLibrary = [...new Set(LIBRARY.map(e => e.group))];
  assert.deepEqual(GROUPS, seenInLibrary, 'GROUPS must match first-appearance order of LIBRARY groups');
});

test('search("tempo tap") finds the tempo tap entry', async () => {
  const { search } = await import(libUrl);
  const results = search('tempo tap');
  assert.ok(results.some(e => e.address === '/composition/tempocontroller/tempotap'),
    `expected tempotap entry in results: ${JSON.stringify(results.map(r => r.address))}`);
});

test('search matches are case-insensitive and require every term (AND)', async () => {
  const { search } = await import(libUrl);
  const upper = search('MASTER LEVEL');
  const lower = search('master level');
  assert.deepEqual(upper.map(e => e.address), lower.map(e => e.address));
  assert.ok(upper.length > 0);
  // A nonsense extra term should eliminate all results.
  assert.equal(search('master level zzzznotarealterm').length, 0);
});

test('search with empty query returns the full library', async () => {
  const { LIBRARY, search } = await import(libUrl);
  assert.equal(search('').length, LIBRARY.length);
  assert.equal(search('   ').length, LIBRARY.length);
});

test('expand fills in placeholders and leaves the rest alone', async () => {
  const { expand } = await import(libUrl);
  assert.equal(
    expand('/composition/layers/{L}/clips/{C}/connect', { L: 2, C: 3 }),
    '/composition/layers/2/clips/3/connect',
  );
  assert.equal(
    expand('/composition/video/effects/{FX}/effect/{P}', { FX: 'boomer', P: 'blur' }),
    '/composition/video/effects/boomer/effect/blur',
  );
});

test('placeholders() extracts every {token} in an address', async () => {
  const { placeholders } = await import(libUrl);
  assert.deepEqual(placeholders('/composition/layers/{L}/clips/{C}/video/effects/{FX}/effect/{P}'),
    ['L', 'C', 'FX', 'P']);
  assert.deepEqual(placeholders('/composition/master'), []);
});

test('every address referenced by config-store.defaults() matches a LIBRARY entry', async () => {
  const { LIBRARY } = await import(libUrl);
  const regexes = LIBRARY.map(e => templateToRegex(e.address));
  const addresses = collectAddresses(configStore.defaults());
  assert.ok(addresses.length > 20, `sanity check: expected to collect a good number of addresses, got ${addresses.length}`);
  const unmatched = addresses.filter(a => !regexes.some(r => r.test(a)));
  assert.deepEqual(unmatched, [], `addresses from config-store.defaults() with no LIBRARY match`);
});

test('every address referenced by configs/show.json matches a LIBRARY entry', async () => {
  const { LIBRARY } = await import(libUrl);
  const regexes = LIBRARY.map(e => templateToRegex(e.address));
  const cfg = JSON.parse(fs.readFileSync(showConfigPath, 'utf8'));
  const addresses = collectAddresses(cfg);
  assert.ok(addresses.length > 20, `sanity check: expected to collect a good number of addresses, got ${addresses.length}`);
  const unmatched = addresses.filter(a => !regexes.some(r => r.test(a)));
  assert.deepEqual(unmatched, [], `addresses from show.json with no LIBRARY match`);
});
