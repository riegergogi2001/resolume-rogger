'use strict';
// Three-leg link diagnostic for the Resolume connection.
//
// "Test connection" used to send one message and wait for anything to come
// back, which conflates three different failures into one unhelpful answer.
// The link actually has three independent legs, and each fails on its own:
//
//   1. REST      Resolume is running and we can read its state (port 9292)
//   2. OSC out   ROGGER -> Resolume: our commands land          (OSC input port)
//   3. OSC in    Resolume -> ROGGER: feedback comes back        (our listen port)
//
// Leg 3 is the one that fails silently and stays broken all show: Resolume's
// OSC output points at a fixed IP, so the moment the console moves to another
// machine or the network changes, every lamp and latch on the surface goes
// dead while everything still *works*. When that happens this reports the
// exact address to type into Resolume's preferences.
const os = require('node:os');

const REST_TIMEOUT_MS = 4000;
const FEEDBACK_WAIT_MS = 1500;
// A nudge this small is below anything an audience or an operator can see,
// which is what makes it safe to run during a show.
const NUDGE = 0.004;

/** Non-internal IPv4 addresses of this machine, in interface order. */
function localAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

const ipToInt = ip => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(ip ?? ''));
  return m ? ((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0 : null;
};

/**
 * Order this machine's addresses for the FIX line. A console has several — the
 * Ally carries Wi-Fi, a dock's Ethernet, maybe a VPN — and only the one on
 * Resolume's own subnet is an address Resolume can send to. A link-local
 * 169.254.x.x (an adapter with no DHCP lease) is never it.
 */
function rankAddresses(addresses, targetIp) {
  const target = ipToInt(targetIp);
  const score = a => {
    const ip = ipToInt(a.address);
    const mask = ipToInt(a.netmask);
    if (ip == null) return 3;
    if (target != null && mask != null && ((ip & mask) >>> 0) === ((target & mask) >>> 0)) return 0;
    if (String(a.address).startsWith('169.254.')) return 2;
    return 1;
  };
  return addresses
    .map((a, i) => ({ a, i, s: score(a) }))
    .sort((x, y) => x.s - y.s || x.i - y.i)
    .map(x => x.a);
}

const oscName = n => String(n ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Find a parameter we can move without anyone noticing: an effect whose
 * opacity is already at zero. Nudging that changes nothing visible.
 * Falls back to the composition master, where the nudge is 0.4%.
 */
function pickProbe(comp) {
  const containers = [
    { base: '/composition', obj: comp },
    ...(comp?.layergroups ?? []).map((g, i) => ({ base: `/composition/groups/${i + 1}`, obj: g })),
  ];
  for (const { base, obj } of containers) {
    const seen = new Map();
    for (const fx of obj?.video?.effects ?? []) {
      const raw = typeof fx?.name === 'object' ? fx.name.value : fx?.name;
      const key = oscName(raw);
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const opacity = fx?.params?.Opacity;
      if (opacity?.valuetype !== 'ParamRange') continue;
      if (!(opacity.value <= 0.001)) continue;
      return {
        address: `${base}/video/effects/${n === 1 ? key : key + n}/opacity`,
        rest: c => readOpacity(c, base, n === 1 ? key : key + n),
        original: opacity.value,
        what: `${raw} opacity (currently off, so the nudge is invisible)`,
      };
    }
  }
  const master = comp?.master?.value;
  if (typeof master === 'number') {
    return {
      address: '/composition/master',
      rest: c => c?.master?.value,
      original: master,
      // A master sitting at 1.0 (where it lives during a show) cannot go up:
      // Resolume clamps the nudge away and the leg reads as dead.
      nudge: master + NUDGE > 1 ? -NUDGE : NUDGE,
      what: 'composition master (nudged by 0.4%, then restored)',
    };
  }
  return null;
}

function readOpacity(comp, base, oscKey) {
  const m = base.match(/^\/composition\/groups\/(\d+)$/);
  const obj = m ? comp?.layergroups?.[+m[1] - 1] : comp;
  const seen = new Map();
  for (const fx of obj?.video?.effects ?? []) {
    const raw = typeof fx?.name === 'object' ? fx.name.value : fx?.name;
    const key = oscName(raw);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if ((n === 1 ? key : key + n) === oscKey) return fx?.params?.Opacity?.value;
  }
  return undefined;
}

/**
 * Run the diagnostic.
 * @param {object} opts
 * @param {object} opts.engine   OscEngine (send + 'message' events)
 * @param {object} opts.network  { targetIp, targetPort, listenPort }
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.sleep]
 * @param {Array} [opts.addresses]  this machine's addresses (defaults to localAddresses())
 * @returns {Promise<{legs: Array, summary: string, ok: boolean}>}
 */
async function diagnose({ engine, network, fetchImpl, sleep, addresses }) {
  const doFetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
  const wait = sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const legs = [];
  const ip = network?.targetIp;
  // Our own socket. If it is not open nothing below can be blamed on Resolume.
  const socketOpen = engine.status !== 'offline';
  const boundPort = engine.listenAddress?.()?.port;
  const listenFallback = Boolean(engine.listenFallback) || (typeof boundPort === 'number' && boundPort !== network?.listenPort);

  // Watch for any inbound OSC for the whole run — that is leg 3's evidence.
  let inbound = 0;
  const onMessage = () => { inbound += 1; };
  engine.on('message', onMessage);

  try {
    // ---- leg 1: REST ----
    let comp = null;
    try {
      const res = await doFetch(`http://${ip}:9292/api/v1/composition`, {
        signal: AbortSignal.timeout(REST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`answered ${res.status}`);
      comp = await res.json();
      legs.push({
        id: 'rest', ok: true, title: 'Resolume webserver',
        detail: `Connected to ${ip}:9292 — composition "${comp?.name?.value ?? 'unnamed'}".`,
      });
    } catch (err) {
      legs.push({
        id: 'rest', ok: false, title: 'Resolume webserver',
        detail: `No answer from ${ip}:9292 (${err?.message ?? err}).`,
        fix: 'Resolume → Preferences → Webserver: enable it on port 9292. Needed for DJ sync, BPM seed and this test.',
      });
    }

    // ---- leg 2: our commands land ----
    const probe = comp ? pickProbe(comp) : null;
    if (!comp) {
      legs.push({
        id: 'send', ok: false, title: 'ROGGER → Resolume',
        detail: 'Cannot be verified without the webserver — there is no way to read back what arrived.',
        fix: 'Enable the webserver, then run this again.',
      });
    } else if (!socketOpen) {
      legs.push({
        id: 'send', ok: false, title: 'ROGGER → Resolume',
        detail: 'ROGGER\'s own OSC socket is not open — nothing was sent, so this is not a Resolume setting.',
        fix: 'Settings → Network → Save network settings to reopen it (or restart ROGGER). If the listen port is held by another app, change it here.',
      });
    } else if (!probe) {
      legs.push({
        id: 'send', ok: false, title: 'ROGGER → Resolume',
        detail: 'Found no parameter safe to nudge in this composition.',
      });
    } else {
      const nudge = probe.nudge ?? NUDGE;
      engine.send(probe.address, [probe.original + nudge]);
      await wait(300);
      let moved = false;
      try {
        const res = await doFetch(`http://${ip}:9292/api/v1/composition`, {
          signal: AbortSignal.timeout(REST_TIMEOUT_MS),
        });
        const after = probe.rest(await res.json());
        moved = Math.abs(Number(after) - (probe.original + nudge)) < 0.002;
      } catch { /* leave moved false */ }
      engine.send(probe.address, [probe.original]);   // always put it back
      await wait(150);
      legs.push(moved
        ? {
          id: 'send', ok: true, title: 'ROGGER → Resolume',
          detail: `Commands land. Verified on ${probe.what}, then restored.`,
        }
        : {
          id: 'send', ok: false, title: 'ROGGER → Resolume',
          detail: `Sent to ${ip}:${network.targetPort} but the parameter did not move.`,
          fix: `Resolume → Preferences → OSC: enable OSC Input on port ${network.targetPort}.`,
        });
    }

    // ---- leg 3: feedback comes back ----
    await wait(FEEDBACK_WAIT_MS);
    const ranked = rankAddresses(addresses ?? localAddresses(), ip);
    const [best, ...others] = ranked;
    const hint = best
      ? `${best.address}:${network.listenPort}` +
        (others.length ? ` (this machine also has ${others.map(a => a.address).join(', ')} — use the one on Resolume's network)` : '')
      : `this machine:${network.listenPort}`;
    legs.push(inbound > 0
      ? {
        id: 'feedback', ok: true, title: 'Resolume → ROGGER (feedback)',
        detail: `${inbound} message(s) received. Lamps, latches and auto-BPM will follow Resolume.`,
      }
      : listenFallback
        ? {
          id: 'feedback', ok: false, title: 'Resolume → ROGGER (feedback)',
          detail: `ROGGER could not open port ${network.listenPort} (another app on this machine is using it) and is listening on ${boundPort ?? 'an ephemeral port'} instead, which Resolume does not know about. Buttons still fire, but nothing lights up from Resolume.`,
          fix: `Close the other app using UDP ${network.listenPort}, or pick a different listen port here and point Resolume's OSC Output at it; then Save network settings.`,
        }
        : {
          id: 'feedback', ok: false, title: 'Resolume → ROGGER (feedback)',
          detail: `Nothing arrived on port ${network.listenPort}. Buttons will still fire, but nothing on the surface will light up from Resolume, and Auto BPM will not follow.`,
          fix: `Resolume → Preferences → OSC → Output: enable it and set the target to ${hint}, or set the target type to Broadcast (port ${network.listenPort}) so it reaches every machine on the subnet.`,
        });
  } finally {
    engine.removeListener('message', onMessage);
  }

  const ok = legs.every(l => l.ok);
  const failed = legs.filter(l => !l.ok);
  const summary = ok
    ? 'All three legs of the Resolume link are working.'
    : `${failed.length} of ${legs.length} legs failing: ${failed.map(l => l.title).join(', ')}.`;
  return { legs, summary, ok };
}

module.exports = { diagnose, localAddresses, rankAddresses, pickProbe };
