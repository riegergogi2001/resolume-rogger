'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { diagnose, pickProbe, localAddresses } = require('../src/main/diagnostics.js');

const NETWORK = { targetIp: '10.0.0.5', targetPort: 7432, listenPort: 7001 };

function effect(name, opacity, extra = {}) {
  return {
    name,
    bypassed: { valuetype: 'ParamBoolean', value: false },
    params: { Opacity: { valuetype: 'ParamRange', min: 0, max: 1, value: opacity }, ...extra },
  };
}

function composition({ compFx = [], groupFx = [], master = 1 } = {}) {
  return {
    name: { value: 'TEST SHOW' },
    master: { valuetype: 'ParamRange', value: master },
    video: { effects: compFx },
    layergroups: groupFx.map((fx, i) => ({ name: { value: `G${i + 1}` }, video: { effects: fx } })),
  };
}

/** Engine stand-in that records sends and can fake inbound feedback. */
function fakeEngine({ feedback = false, applies = true } = {}) {
  const engine = new EventEmitter();
  engine.sent = [];
  engine.state = new Map();
  engine.send = (address, values) => {
    engine.sent.push({ address, values });
    if (applies) engine.state.set(address, values[0]);
    if (feedback) setImmediate(() => engine.emit('message', { address, args: [{ type: 'f', value: values[0] }] }));
  };
  return engine;
}

/** REST stand-in that reflects whatever the engine applied. */
function fakeFetch(engine, comp, { ok = true } = {}) {
  return async () => {
    if (!ok) throw new Error('connect ECONNREFUSED');
    const next = JSON.parse(JSON.stringify(comp));
    for (const [address, value] of engine.state) {
      let m;
      if (address === '/composition/master') next.master.value = value;
      else if ((m = address.match(/^\/composition\/groups\/(\d+)\/video\/effects\/([^/]+)\/opacity$/))) {
        const fx = next.layergroups[+m[1] - 1].video.effects
          .find(e => String(e.name).toLowerCase().replace(/[^a-z0-9]/g, '') === m[2]);
        if (fx) fx.params.Opacity.value = value;
      } else if ((m = address.match(/^\/composition\/video\/effects\/([^/]+)\/opacity$/))) {
        const fx = next.video.effects
          .find(e => String(e.name).toLowerCase().replace(/[^a-z0-9]/g, '') === m[1]);
        if (fx) fx.params.Opacity.value = value;
      }
    }
    return { ok: true, status: 200, json: async () => next };
  };
}

// Yields a macrotask rather than a microtask: the diagnostic counts feedback
// that arrives while it waits, and real inbound OSC lands on the event loop.
const noSleep = () => new Promise(r => setImmediate(r));
const run = (engine, comp, opts = {}) => diagnose({
  engine, network: NETWORK, sleep: noSleep, fetchImpl: fakeFetch(engine, comp, opts),
});

test('pickProbe prefers an effect that is already off, so the nudge is invisible', () => {
  const comp = composition({ groupFx: [[effect('Bloom', 0.8), effect('Goo', 0)]] });
  const probe = pickProbe(comp);
  assert.equal(probe.address, '/composition/groups/1/video/effects/goo/opacity');
  assert.equal(probe.original, 0);
  assert.match(probe.what, /invisible/);
});

test('pickProbe disambiguates duplicate effect names the way Resolume does', () => {
  const comp = composition({ compFx: [effect('PUSHER', 0.5), effect('PUSHER', 0)] });
  assert.equal(pickProbe(comp).address, '/composition/video/effects/pusher2/opacity');
});

test('pickProbe falls back to the master when every effect is up', () => {
  const comp = composition({ groupFx: [[effect('Bloom', 1)]], master: 1 });
  const probe = pickProbe(comp);
  assert.equal(probe.address, '/composition/master');
  assert.match(probe.what, /restored/);
});

test('all three legs pass when the link is healthy', async () => {
  const comp = composition({ groupFx: [[effect('Goo', 0)]] });
  const engine = fakeEngine({ feedback: true });
  const r = await run(engine, comp);
  assert.equal(r.ok, true);
  assert.deepEqual(r.legs.map(l => l.id), ['rest', 'send', 'feedback']);
  assert.ok(r.legs.every(l => l.ok));
  assert.match(r.summary, /All three legs/);
});

test('the probe is always restored, healthy link or not', async () => {
  const comp = composition({ groupFx: [[effect('Goo', 0)]] });
  const engine = fakeEngine({ feedback: true });
  await run(engine, comp);
  assert.equal(engine.sent.length, 2, 'nudge then restore');
  assert.equal(engine.sent[1].values[0], 0, 'put back exactly where it was');
  assert.equal(engine.state.get('/composition/groups/1/video/effects/goo/opacity'), 0);
});

test('feedback failing is called out on its own with the address to fix it', async () => {
  const comp = composition({ groupFx: [[effect('Goo', 0)]] });
  const engine = fakeEngine({ feedback: false });
  const r = await run(engine, comp);
  assert.equal(r.ok, false);
  const rest = r.legs.find(l => l.id === 'rest');
  const send = r.legs.find(l => l.id === 'send');
  const fb = r.legs.find(l => l.id === 'feedback');
  assert.equal(rest.ok, true, 'the webserver leg is unaffected');
  assert.equal(send.ok, true, 'commands still land — this is the point');
  assert.equal(fb.ok, false);
  assert.match(fb.detail, /Buttons will still fire/);
  assert.match(fb.fix, /Preferences → OSC → Output/);
  assert.match(fb.fix, new RegExp(`:${NETWORK.listenPort}`), 'the fix names the listen port');
  assert.match(r.summary, /1 of 3 legs failing/);
});

test('commands not landing is reported separately from feedback', async () => {
  const comp = composition({ groupFx: [[effect('Goo', 0)]] });
  const engine = fakeEngine({ feedback: false, applies: false }); // OSC input off
  const r = await run(engine, comp);
  const send = r.legs.find(l => l.id === 'send');
  assert.equal(send.ok, false);
  assert.match(send.detail, /did not move/);
  assert.match(send.fix, new RegExp(`OSC Input on port ${NETWORK.targetPort}`));
});

test('an unreachable webserver fails its own leg and blocks the send check honestly', async () => {
  const comp = composition({ groupFx: [[effect('Goo', 0)]] });
  const engine = fakeEngine({ feedback: true });
  const r = await run(engine, comp, { ok: false });
  const rest = r.legs.find(l => l.id === 'rest');
  const send = r.legs.find(l => l.id === 'send');
  assert.equal(rest.ok, false);
  assert.match(rest.fix, /Webserver/);
  assert.equal(send.ok, false);
  assert.match(send.detail, /Cannot be verified/, 'no false pass when there is no way to read back');
  assert.equal(engine.sent.length, 0, 'nothing is nudged when we cannot check the result');
});

test('feedback still passes when the messages are unrelated to the probe', async () => {
  // Real feedback is whatever Resolume happens to be sending; any of it proves
  // the leg works.
  const comp = composition({ groupFx: [[effect('Goo', 0)]] });
  const engine = fakeEngine({ feedback: false });
  const original = engine.send;
  engine.send = (a, v) => {
    original(a, v);
    setImmediate(() => engine.emit('message', { address: '/composition/tempocontroller/tempo', args: [{ value: 0.2 }] }));
  };
  const r = await run(engine, comp);
  assert.equal(r.legs.find(l => l.id === 'feedback').ok, true);
});

test('the diagnostic unhooks its listener so it cannot leak', async () => {
  const comp = composition({ groupFx: [[effect('Goo', 0)]] });
  const engine = fakeEngine({ feedback: true });
  const before = engine.listenerCount('message');
  await run(engine, comp);
  assert.equal(engine.listenerCount('message'), before);
});

test('localAddresses returns usable IPv4 addresses only', () => {
  for (const a of localAddresses()) {
    assert.match(a.address, /^\d+\.\d+\.\d+\.\d+$/);
    assert.notEqual(a.address, '127.0.0.1', 'loopback is useless as an OSC output target');
  }
});
