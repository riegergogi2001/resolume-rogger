#!/usr/bin/env node
'use strict';
// Checks every OSC address in a ROGGER config against a live Resolume
// composition, so a config that drifted from the show is caught at the desk
// instead of on the screens.
//
//   node tools/verify-config.js [config.json] [--host 127.0.0.1]
//
// Reports addresses that point at nothing, clips that are empty, and
// triggers that are not effects at all (a DJ logo sitting in the FX bank).
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const hostIdx = args.indexOf('--host');
const HOST = hostIdx >= 0 ? args[hostIdx + 1] : '127.0.0.1';
const CONFIG = args.find(a => !a.startsWith('--') && a !== HOST) ?? path.join(__dirname, '..', 'config.dev.json');

/** Resolume's OSC name for an effect: lowercased, non-alphanumerics dropped. */
const oscName = n => String(n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Effects on a container, in OSC order — duplicates get a numeric suffix. */
function effectIndex(container) {
  const map = new Map();
  const seen = new Map();
  for (const e of (container?.video?.effects ?? [])) {
    const raw = typeof e?.name === 'object' ? e.name.value : e?.name;
    const base = oscName(raw);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    map.set(n === 1 ? base : `${base}${n}`, { name: raw, effect: e });
  }
  return map;
}

function buildIndex(comp) {
  return {
    comp,
    compEffects: effectIndex(comp),
    layers: comp.layers ?? [],
    groups: comp.layergroups ?? [],
    layerEffects: (comp.layers ?? []).map(effectIndex),
    groupEffects: (comp.layergroups ?? []).map(effectIndex),
  };
}

const layerName = l => l?.name?.value ?? '?';
const val = p => (p && typeof p === 'object' && 'value' in p ? p.value : undefined);
const clipName = c => c?.name?.value ?? '';

/**
 * Resolve one OSC address.
 * @returns {{ok: boolean, what: string, warn?: string}}
 */
function resolve(address, idx) {
  const a = String(address ?? '').trim();
  if (!a) return { ok: true, what: 'no address (macro-only or unused)' };
  if (!a.startsWith('/composition')) return { ok: false, what: 'not a /composition address' };

  let m;

  if (a === '/composition/master') return { ok: true, what: 'composition master' };

  // /composition/layers/N/clips/M/...
  if ((m = a.match(/^\/composition\/layers\/(\d+)\/clips\/(\d+)(\/.*)?$/))) {
    const li = +m[1] - 1;
    const ci = +m[2] - 1;
    const layer = idx.layers[li];
    if (!layer) return { ok: false, what: `layer ${m[1]} does not exist` };
    const clip = layer.clips?.[ci];
    if (!clip) return { ok: false, what: `layer ${m[1]} "${layerName(layer)}" has no clip ${m[2]}` };
    const name = clipName(clip);
    const rest = m[3] ?? '';
    if (rest.startsWith('/video/effects/')) {
      const fx = oscName(rest.split('/')[3]);
      const has = effectIndex(clip).has(fx);
      return has
        ? { ok: true, what: `clip "${name}" effect ${fx}` }
        : { ok: false, what: `clip "${name}" (layer ${m[1]}) has no effect "${fx}"` };
    }
    if (!name) return { ok: false, what: `layer ${m[1]} "${layerName(layer)}" clip ${m[2]} is EMPTY` };
    return {
      ok: true, what: `layer ${m[1]} "${layerName(layer)}" clip ${m[2]} "${name}"`,
      clip: name, layer: layerName(layer),
      container: `layer ${m[1]} "${layerName(layer)}"`, containerLevel: val(layer.master),
    };
  }

  // /composition/layers/N/...
  if ((m = a.match(/^\/composition\/layers\/(\d+)\/(.*)$/))) {
    const li = +m[1] - 1;
    const layer = idx.layers[li];
    if (!layer) return { ok: false, what: `layer ${m[1]} does not exist` };
    const rest = m[2];
    if (rest === 'clear') {
      return {
        ok: true, what: `clear layer ${m[1]} "${layerName(layer)}"`, layer: layerName(layer),
        container: `layer ${m[1]} "${layerName(layer)}"`, containerLevel: val(layer.master),
      };
    }
    if (rest === 'master') return { ok: true, what: `master of layer ${m[1]} "${layerName(layer)}"`, layer: layerName(layer) };
    if (rest.startsWith('video/effects/')) {
      const fx = oscName(rest.split('/')[2]);
      return idx.layerEffects[li].has(fx)
        ? { ok: true, what: `layer ${m[1]} "${layerName(layer)}" effect ${fx}` }
        : { ok: false, what: `layer ${m[1]} "${layerName(layer)}" has no effect "${fx}"` };
    }
    // autopilot, dashboard and friends are real layer params but not exposed
    // in the composition dump the same way — check the layer object directly.
    const head = rest.split('/')[0];
    return head in layer
      ? { ok: true, what: `layer ${m[1]} "${layerName(layer)}" ${rest}` }
      : { ok: false, what: `layer ${m[1]} "${layerName(layer)}" has no "${head}" parameter` };
  }

  // /composition/groups/N/...
  if ((m = a.match(/^\/composition\/groups\/(\d+)\/(.*)$/))) {
    const gi = +m[1] - 1;
    const group = idx.groups[gi];
    if (!group) return { ok: false, what: `group ${m[1]} does not exist` };
    const gname = group.name?.value ?? '?';
    const rest = m[2];
    if (rest === 'master') return { ok: true, what: `master of group ${m[1]} "${gname}"` };
    if ((m = rest.match(/^columns\/(\d+)\/connect$/))) {
      return { ok: true, what: `group "${gname}" column ${m[1]}` };
    }
    if (rest.startsWith('video/effects/')) {
      const fx = oscName(rest.split('/')[2]);
      const entry = idx.groupEffects[gi].get(fx);
      return entry
        ? {
          ok: true,
          what: `group ${gi + 1} "${gname}" effect ${fx}`,
          effect: entry.effect,
          effectKey: `group${gi + 1}:${fx}`,
          container: `group ${gi + 1} "${gname}"`,
          containerLevel: val(group.master),
        }
        : { ok: false, what: `group ${gi + 1} "${gname}" has no effect "${fx}"` };
    }
    return { ok: true, what: `group "${gname}" ${rest}` };
  }

  // /composition/columns/N/connect
  if ((m = a.match(/^\/composition\/columns\/(\d+)\/connect$/))) {
    const n = +m[1];
    return n <= (idx.comp.columns ?? []).length
      ? { ok: true, what: `composition column ${n}` }
      : { ok: false, what: `composition has no column ${n}` };
  }

  // /composition/video/effects/<fx>/...
  if ((m = a.match(/^\/composition\/video\/effects\/([^/]+)\//))) {
    const fx = oscName(m[1]);
    const entry = idx.compEffects.get(fx);
    return entry
      ? {
        ok: true,
        what: `composition effect ${fx}`,
        effect: entry.effect,
        effectKey: `composition:${fx}`,
        container: 'the composition',
        containerLevel: val(idx.comp.master),
      }
      : { ok: false, what: `composition has no effect "${fx}"` };
  }

  if (a.startsWith('/composition/tempocontroller/')) return { ok: true, what: 'tempo controller' };
  return { ok: true, what: 'unchecked composition address' };
}

/** Every address a control fires, including mirrors and macro steps. */
function addressesOf(control) {
  const out = [];
  const push = (addr, role) => { if (addr) out.push({ addr, role }); };
  push(control.address, 'address');
  push(control.releaseAddress, 'release');
  push(control.extraAddress, 'mirror');
  for (const a of control.extraAddresses ?? []) push(a, 'mirror');
  for (const step of control.macro ?? []) push(step.address, 'macro');
  return out;
}

const SECTIONS = [
  ['fxButtons', 'Page 1'],
  ['fxButtons2', 'Page 2'],
  ['fxButtons3', 'DJ Intro'],
  ['utilButtons', 'Page 1 utility quad'],
  ['faders', 'Main faders'],
  ['groupFaders', 'Group faders'],
  ['colorButtons', 'Colour presets'],
];

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  const res = await fetch(`http://${HOST}:9292/api/v1/composition`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Resolume webserver answered ${res.status}`);
  const comp = await res.json();
  const idx = buildIndex(comp);

  console.log(`config      ${path.relative(process.cwd(), CONFIG)}`);
  console.log(`composition ${comp.name?.value} (via ${HOST}:9292)\n`);

  // Which effects does some control switch on for itself? A bypassed effect
  // is only a problem when nothing on the surface can un-bypass it.
  const bypassDrivers = new Set();
  const collect = control => {
    for (const { addr } of addressesOf(control)) {
      if (!/\/bypassed$/.test(addr ?? '')) continue;
      const r = resolve(addr, idx);
      if (r.effectKey) bypassDrivers.add(r.effectKey);
    }
  };
  for (const [key] of SECTIONS) for (const c of cfg[key] ?? []) collect(c);
  for (const t of cfg.colorTargets?.items ?? []) {
    for (const step of [...(t.onSteps ?? []), ...(t.offSteps ?? [])]) {
      if (!/\/bypassed$/.test(step.address ?? '')) continue;
      const r = resolve(step.address, idx);
      if (r.effectKey) bypassDrivers.add(r.effectKey);
    }
  }

  let broken = 0;
  let odd = 0;
  const silent = [];
  for (const [key, title] of SECTIONS) {
    const controls = cfg[key] ?? [];
    const lines = [];
    controls.forEach((control, i) => {
      for (const { addr, role } of addressesOf(control)) {
        const r = resolve(addr, idx);
        if (!r.ok) {
          broken += 1;
          lines.push(`  [BROKEN] ${i + 1}. ${control.label} (${role}) -> ${addr}\n             ${r.what}`);
          continue;
        }
        // Reaches a real parameter, but would anyone see it?
        if (role === 'address' && !/\/bypassed$/.test(addr)) {
          if (r.effect && val(r.effect.bypassed) === true && !bypassDrivers.has(r.effectKey)) {
            silent.push(`${title} ${i + 1}. ${control.label} — ${r.what} is BYPASSED and nothing on the surface turns it back on`);
          }
          if (r.containerLevel === 0) {
            silent.push(`${title} ${i + 1}. ${control.label} — ${r.container} is at 0, so this will not be seen`);
          }
        }
        // A clip trigger on a layer that is not an FX layer is a content
        // trigger wearing an FX button's clothes.
        if (key === 'fxButtons2' && r.clip && !/^FX/i.test(r.layer ?? '')) {
          odd += 1;
          lines.push(`  [ODD]    ${i + 1}. ${control.label} -> ${addr}\n             fires content clip "${r.clip}" on layer "${r.layer}", not an effect`);
        }
      }
    });
    if (lines.length) {
      console.log(`--- ${title} (${key}) ---`);
      console.log(lines.join('\n'));
      console.log('');
    }
  }

  // What the composition offers that nothing in the config reaches.
  const used = new Set();
  for (const [key] of SECTIONS) {
    for (const c of cfg[key] ?? []) for (const { addr } of addressesOf(c)) used.add(addr);
  }
  for (const t of cfg.colorTargets?.items ?? []) {
    for (const b of t.colorBases ?? []) used.add(b);
    for (const s of [...(t.onSteps ?? []), ...(t.offSteps ?? [])]) used.add(s.address);
  }
  const unreached = [];
  for (const [fx] of idx.compEffects) {
    if (fx === 'transform') continue; // driven by the gamepad sticks, not a button
    if (![...used].some(a => a.includes(`/composition/video/effects/${fx}/`))) unreached.push(`composition effect "${fx}"`);
  }
  idx.groupEffects.forEach((map, gi) => {
    for (const [fx] of map) {
      if (fx === 'transform') continue; // driven by the sticks, not a button
      if (![...used].some(a => a.includes(`/composition/groups/${gi + 1}/video/effects/${fx}/`))) {
        unreached.push(`group ${gi + 1} "${idx.groups[gi].name?.value}" effect "${fx}"`);
      }
    }
  });

  if (unreached.length) {
    console.log('--- in the composition but not on any control ---');
    for (const u of unreached) console.log(`  ${u}`);
    console.log('');
  }

  if (silent.length) {
    console.log('--- reaches a real parameter, but nobody would see it ---');
    for (const s2 of silent) console.log(`  ${s2}`);
    console.log('');
  }

  console.log(`${broken} broken address(es), ${odd} misplaced control(s), ${silent.length} silent control(s), ${unreached.length} unmapped effect(s).`);
  process.exitCode = broken ? 1 : 0;
}
main().catch(err => { console.error('verify failed:', err.message); process.exitCode = 1; });
