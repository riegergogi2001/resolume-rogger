#!/usr/bin/env node
'use strict';
// Fires every safe control in a config at a live Resolume and reads the
// parameter back over the REST API to prove the whole path works: ROGGER's
// OSC codec -> the network -> Resolume's OSC input -> the actual parameter.
//
//   node tools/live-check.js [config.json] [--host 127.0.0.1] [--port 7432]
//
// Non-destructive by default. Every parameter is read first, driven, verified
// and restored to the value it had. Clip triggers and clears change what is on
// the screens, so they are skipped unless you pass --fire.
//
//   node tools/live-check.js --fire
//
// With --fire it also connects each clip, confirms Resolume reports it
// connected, and puts the previously connected clip back. Do that with the
// output dark.
const dgram = require('node:dgram');
const fs = require('node:fs');
const path = require('node:path');
const { encodeMessage, inferArgs } = require('../src/main/osc.js');

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const HOST = flag('--host', '127.0.0.1');
// Clip triggers and clears change what is on the screens, so they are only
// fired when explicitly asked for. Run with --fire before doors, not mid-set.
const FIRE = args.includes('--fire');
const PORT = Number(flag('--port', 7432));
const CONFIG = args.find(a => !a.startsWith('--') && a !== HOST && a !== String(PORT))
  ?? path.join(__dirname, '..', 'config.dev.json');

const REST = `http://${HOST}:9292/api/v1`;
const socket = dgram.createSocket('udp4');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function send(address, values) {
  return new Promise((resolve, reject) => {
    socket.send(encodeMessage(address, inferArgs(values)), PORT, HOST, err => (err ? reject(err) : resolve()));
  });
}

async function composition() {
  const res = await fetch(`${REST}/composition`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Resolume webserver answered ${res.status}`);
  return res.json();
}

const oscName = n => String(n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Walk the composition to the parameter an OSC address points at. */
function readParam(comp, address) {
  const effectsOf = container => {
    const map = new Map();
    const seen = new Map();
    for (const e of (container?.video?.effects ?? [])) {
      const raw = typeof e?.name === 'object' ? e.name.value : e?.name;
      const base = oscName(raw);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      map.set(n === 1 ? base : `${base}${n}`, e);
    }
    return map;
  };
  // Resolume puts effect parameters under `params`, keyed by their display
  // name ("Fade Out Time"), and the OSC address uses the same name lowercased
  // with the punctuation dropped.
  const paramIn = (effect, tail) => {
    if (!effect) return undefined;
    if (tail === 'bypassed') return effect.bypassed;
    const params = effect.params ?? {};
    const byName = key => {
      const want = oscName(key);
      const hit = Object.entries(params).find(([k]) => oscName(k) === want);
      return hit?.[1];
    };
    if (tail === 'opacity') return byName('Opacity');
    if (!tail.startsWith('effect/')) return undefined;
    const parts = tail.slice('effect/'.length).split('/');
    const param = byName(parts[0]);
    if (!param) return undefined;
    if (parts.length === 1) return param;
    // colour sub-addresses: /effect/color/red on a "#rrggbbaa" ParamColor
    if (param.valuetype === 'ParamColor' && typeof param.value === 'string') {
      const hex = param.value.replace('#', '');
      const channel = { red: 0, green: 1, blue: 2, alpha: 3 }[parts[1].toLowerCase()];
      if (channel == null) return undefined;
      const byte = parseInt(hex.slice(channel * 2, channel * 2 + 2), 16);
      return Number.isNaN(byte) ? undefined : { value: byte / 255, valuetype: 'ParamRange' };
    }
    return undefined;
  };

  let m;
  if (address === '/composition/master') return comp.master;
  if ((m = address.match(/^\/composition\/layers\/(\d+)\/master$/))) return comp.layers?.[+m[1] - 1]?.master;
  if ((m = address.match(/^\/composition\/groups\/(\d+)\/master$/))) return comp.layergroups?.[+m[1] - 1]?.master;
  if ((m = address.match(/^\/composition\/groups\/(\d+)\/video\/effects\/([^/]+)\/(.+)$/))) {
    return paramIn(effectsOf(comp.layergroups?.[+m[1] - 1]).get(oscName(m[2])), m[3]);
  }
  if ((m = address.match(/^\/composition\/layers\/(\d+)\/video\/effects\/([^/]+)\/(.+)$/))) {
    return paramIn(effectsOf(comp.layers?.[+m[1] - 1]).get(oscName(m[2])), m[3]);
  }
  if ((m = address.match(/^\/composition\/layers\/(\d+)\/clips\/(\d+)\/video\/effects\/([^/]+)\/(.+)$/))) {
    return paramIn(effectsOf(comp.layers?.[+m[1] - 1]?.clips?.[+m[2] - 1]).get(oscName(m[3])), m[4]);
  }
  if ((m = address.match(/^\/composition\/video\/effects\/([^/]+)\/(.+)$/))) {
    return paramIn(effectsOf(comp).get(oscName(m[1])), m[2]);
  }
  return undefined;
}

/**
 * A ParamChoice reports its selection as the option *string* ("Slice Order")
 * while OSC drives it by index, so comparing `value` against what we sent
 * always looks like a failure. Read the index for those.
 */
const valueOf = p => {
  if (!p || typeof p !== 'object') return undefined;
  if (p.valuetype === 'ParamChoice') return typeof p.index === 'number' ? p.index : undefined;
  return 'value' in p ? p.value : undefined;
};
/** ParamEvent is a momentary trigger: no value to read, and firing it shows. */
const isTrigger = p => p && typeof p === 'object' && p.valuetype === 'ParamEvent';

/** Only parameters are driven — never anything that changes what is on screen. */
function isSafe(address) {
  if (!address) return false;
  if (/\/connect$/.test(address)) return false;   // would cut to another clip
  if (/\/clear$/.test(address)) return false;     // would black a layer out
  if (/push!/.test(address)) return false;        // fires a visible transition
  if (/\/autopilot\//.test(address)) return false;
  if (/tempocontroller/.test(address)) return false;
  return /^\/composition\//.test(address);
}

/** Which clip (1-based) is currently connected on a layer, or 0 for none. */
function connectedClip(comp, layerIndex) {
  const clips = comp.layers?.[layerIndex - 1]?.clips ?? [];
  const i = clips.findIndex(c => /connect/i.test(c?.connected?.value ?? ''));
  return i === -1 ? 0 : i + 1;
}

/**
 * Fire a control that changes the output, prove it landed, and put the layer
 * back the way it was. Only used under --fire.
 */
async function fireVisible(targets, comp) {
  for (const address of targets) {
    let m;
    if ((m = address.match(/^\/composition\/layers\/(\d+)\/clips\/(\d+)\/connect$/))) {
      const layer = +m[1];
      const clip = +m[2];
      const was = connectedClip(comp, layer);
      await send(address, [1]);
      await sleep(220);
      const now = connectedClip(await composition(), layer);
      // restore
      if (was && was !== now) await send(`/composition/layers/${layer}/clips/${was}/connect`, [1]);
      else if (!was) await send(`/composition/layers/${layer}/clear`, [1]);
      await sleep(180);
      if (now !== clip) return { ok: false, what: `${address} did not connect (layer shows clip ${now})` };
      return { ok: true, what: `connected clip ${clip} on layer ${layer}, restored clip ${was || 'none'}` };
    }
    if ((m = address.match(/^\/composition\/layers\/(\d+)\/clear$/))) {
      const layer = +m[1];
      const was = connectedClip(comp, layer);
      await send(address, [1]);
      await sleep(220);
      const now = connectedClip(await composition(), layer);
      if (was) await send(`/composition/layers/${layer}/clips/${was}/connect`, [1]);
      await sleep(180);
      if (now !== 0) return { ok: false, what: `${address} did not clear (layer still shows clip ${now})` };
      return { ok: true, what: `cleared layer ${layer}, restored clip ${was || 'none'}` };
    }
  }
  // momentary triggers (BOOM/PUSH): fire and report — there is nothing to read
  for (const address of targets) await send(address, [1]);
  await sleep(150);
  for (const address of targets) await send(address, [0]);
  return { ok: true, what: `fired ${targets.length} momentary trigger(s)` };
}

const SECTIONS = [
  ['fxButtons', 'Page 1'],
  ['fxButtons2', 'Page 2'],
  ['utilButtons', 'Utility strip'],
  ['faders', 'Main faders'],
  ['groupFaders', 'Group faders'],
];

function targetsOf(control) {
  const out = [];
  const push = a => { if (a) out.push(a); };
  push(control.address);
  push(control.extraAddress);
  for (const a of control.extraAddresses ?? []) push(a);
  for (const s of control.macro ?? []) push(s.address);
  return [...new Set(out)];
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  console.log(`config      ${path.relative(process.cwd(), CONFIG)}`);
  let comp = await composition();
  console.log(`composition ${comp.name?.value}`);
  console.log(`osc         ${HOST}:${PORT}   rest ${HOST}:9292\n`);

  let pass = 0;
  let fail = 0;
  const skipped = [];
  const failures = [];

  for (const [key, title] of SECTIONS) {
    const controls = cfg[key] ?? [];
    console.log(`--- ${title} ---`);
    for (let i = 0; i < controls.length; i += 1) {
      const control = controls[i];
      const targets = targetsOf(control);
      const safe = targets.filter(isSafe);
      if (!safe.length) {
        if (FIRE) {
          const outcome = await fireVisible(targets, comp);
          comp = await composition();
          if (outcome.ok) {
            pass += 1;
            console.log(`  ok    ${String(i + 1).padStart(2)}. ${control.label.padEnd(12)} ${outcome.what}`);
          } else {
            fail += 1;
            failures.push(`${title} ${i + 1}. ${control.label} -> ${outcome.what}`);
            console.log(`  FAIL  ${String(i + 1).padStart(2)}. ${control.label.padEnd(12)} ${outcome.what}`);
          }
          continue;
        }
        skipped.push(`${title} ${i + 1}. ${control.label}`);
        console.log(`  skip  ${String(i + 1).padStart(2)}. ${control.label.padEnd(12)} shows on the output — pass --fire to test it`);
        continue;
      }
      const results = [];
      let triggers = 0;
      let fired = 0;
      for (const address of safe) {
        const param = readParam(comp, address);
        if (isTrigger(param)) { triggers += 1; continue; }
        const before = valueOf(param);
        if (before === undefined) { results.push(`${address} (no readback)`); continue; }
        // Drive it somewhere it is definitely not, then put it back.
        const isBool = typeof before === 'boolean';
        const isChoice = param?.valuetype === 'ParamChoice';
        const options = Array.isArray(param?.options) ? param.options.length : 2;
        // For a choice, step to a different option that actually exists.
        const probe = isChoice ? (before + 1) % Math.max(2, options)
          : isBool ? !before : (before > 0.5 ? 0.0 : 1.0);
        await send(address, [isBool ? (probe ? 1 : 0) : probe]);
        await sleep(140);
        const mid = valueOf(readParam(await composition(), address));
        await send(address, [isBool ? (before ? 1 : 0) : before]);
        await sleep(120);
        const moved = (isBool || isChoice) ? mid === probe : Math.abs(Number(mid) - probe) < 0.02;
        results.push({ address, before, probe, mid, moved });
      }
      const real = results.filter(r => typeof r === 'object');
      const bad = real.filter(r => !r.moved);
      if (real.length && !bad.length) {
        pass += 1;
        console.log(`  ok    ${String(i + 1).padStart(2)}. ${control.label.padEnd(12)} ${real.length} target(s) moved and restored`);
      } else if (!real.length) {
        skipped.push(`${title} ${i + 1}. ${control.label}`);
        if (FIRE && triggers) {
          const outcome = await fireVisible(safe, comp);
          comp = await composition();
          pass += 1;
          console.log(`  ok    ${String(i + 1).padStart(2)}. ${control.label.padEnd(12)} ${outcome.what}`);
        } else {
          const why = triggers
            ? `${triggers} momentary trigger(s) — pass --fire to fire them`
            : 'no readable parameter';
          console.log(`  trig  ${String(i + 1).padStart(2)}. ${control.label.padEnd(12)} ${why}`);
        }
      } else {
        fail += 1;
        for (const b of bad) {
          failures.push(`${title} ${i + 1}. ${control.label} -> ${b.address} (sent ${b.probe}, read ${b.mid})`);
          console.log(`  FAIL  ${String(i + 1).padStart(2)}. ${control.label.padEnd(12)} ${b.address}\n           sent ${b.probe}, read back ${b.mid}`);
        }
      }
      comp = await composition();
    }
    console.log('');
  }

  console.log(`${pass} control(s) verified live, ${fail} failed, ${skipped.length} not driven.`);
  if (!FIRE && skipped.length) {
    console.log('Run again with --fire (output dark) to test the clip and trigger buttons too.');
  }
  if (failures.length) {
    console.log('\nFAILURES:');
    for (const f of failures) console.log(`  ${f}`);
  }
  socket.close();
  process.exitCode = fail ? 1 : 0;
}
main().catch(err => { console.error('live check failed:', err.message); socket.close(); process.exitCode = 1; });
