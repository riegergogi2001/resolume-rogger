'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { once } = require('node:events');
const { OscEngine } = require('../src/main/osc-engine.js');
const { encodeMessage, decodePacket } = require('../src/main/osc.js');

function listener() {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    sock.bind(0, '127.0.0.1', () => resolve(sock));
  });
}

async function openEngine(targetPort, opts = {}) {
  const engine = new OscEngine(opts);
  engine.configure({
    targetIp: '127.0.0.1',
    targetPort,
    listenPort: 0, // ephemeral for tests
    autoConnect: true,
    autoReconnect: false,
  });
  await engine.open();
  return engine;
}

test('send() delivers byte-exact OSC to the target', async () => {
  const sock = await listener();
  const engine = await openEngine(sock.address().port);
  const gotMsg = once(sock, 'message');
  engine.send('/composition/columns/2/connect', [1]);
  const [buf] = await gotMsg;
  assert.deepEqual(buf, encodeMessage('/composition/columns/2/connect', [{ type: 'i', value: 1 }]));
  const [msg] = decodePacket(buf);
  assert.equal(msg.address, '/composition/columns/2/connect');
  engine.close(); sock.close();
});

test('send() infers float typing for non-integers', async () => {
  const sock = await listener();
  const engine = await openEngine(sock.address().port);
  const gotMsg = once(sock, 'message');
  engine.send('/composition/master', [0.42]);
  const [buf] = await gotMsg;
  const [msg] = decodePacket(buf);
  assert.equal(msg.args[0].type, 'f');
  assert.ok(Math.abs(msg.args[0].value - 0.42) < 1e-6);
  engine.close(); sock.close();
});

test('status goes ready on open, live on inbound, back to ready after the window', async () => {
  const sock = await listener();
  const engine = await openEngine(sock.address().port, { liveWindowMs: 120 });
  const statuses = [];
  engine.on('status', s => statuses.push(s));
  assert.equal(engine.status, 'ready');
  // inject an inbound packet at the engine's listen port
  const inbound = encodeMessage('/composition/name', [{ type: 's', value: 'Demo' }]);
  sock.send(inbound, engine.listenAddress().port, '127.0.0.1');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(engine.status, 'live');
  await new Promise(r => setTimeout(r, 200));
  assert.equal(engine.status, 'ready');
  assert.deepEqual(statuses, ['live', 'ready']);
  engine.close(); sock.close();
});

test('armLearn emits decoded inbound messages, disarm stops them', async () => {
  const sock = await listener();
  const engine = await openEngine(sock.address().port);
  const learned = [];
  engine.on('learn', m => learned.push(m));
  engine.armLearn();
  sock.send(encodeMessage('/composition/layers/3/video/opacity', [{ type: 'f', value: 0.5 }]),
    engine.listenAddress().port, '127.0.0.1');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(learned.length, 1);
  assert.equal(learned[0].address, '/composition/layers/3/video/opacity');
  assert.equal(learned[0].args[0].type, 'f');
  engine.disarmLearn();
  sock.send(encodeMessage('/other', []), engine.listenAddress().port, '127.0.0.1');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(learned.length, 1, 'no learn events after disarm');
  engine.close(); sock.close();
});

test('testConnection resolves ok when a reply arrives', async () => {
  const sock = await listener();
  sock.on('message', (buf, rinfo) => {
    sock.send(encodeMessage('/composition/name', [{ type: 's', value: 'Demo' }]), rinfo.port, rinfo.address);
  });
  const engine = await openEngine(sock.address().port, { testReplyMs: 300 });
  const result = await engine.testConnection();
  assert.equal(result.ok, true);
  engine.close(); sock.close();
});

test('testConnection resolves ok:false on silence', async () => {
  const sock = await listener(); // never replies
  const engine = await openEngine(sock.address().port, { testReplyMs: 100 });
  const result = await engine.testConnection();
  assert.equal(result.ok, false);
  assert.ok(result.detail.length > 0);
  engine.close(); sock.close();
});

test('send() while closed emits error instead of throwing', async () => {
  const engine = new OscEngine();
  const errors = [];
  engine.on('error', e => errors.push(e));
  engine.send('/x', [1]);
  assert.equal(errors.length, 1);
});

// --- bind failures and socket lifecycle -------------------------------------
// On the Ally the listen port can be taken by another app, or sit inside a
// Windows excluded port range (EACCES). Neither may hang the Settings save or
// take sending down with it.

function blocker(port = 0) {
  return new Promise(resolve => {
    const sock = dgram.createSocket('udp4');
    sock.bind(port, '0.0.0.0', () => resolve(sock));
  });
}

const settles = (promise, ms = 1500) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`open() did not settle within ${ms} ms`)), ms)),
]);

// Every socket/engine below is closed from t.after(), not only on the happy
// path: a failed assertion must not leave a bound UDP socket (or the engine's
// reconnect timer) keeping the process alive, or `node --test` never prints
// its summary and `npm test` hangs instead of failing.
const shut = (...xs) => { for (const x of xs) { try { x?.close(); } catch { /* already closed */ } } };

test('open() settles when the listen port is taken, and falls back to an ephemeral port so sending still works', async (t) => {
  const taken = await blocker();
  const target = await listener();
  const engine = new OscEngine();
  t.after(() => shut(engine, taken, target));
  const errors = [];
  engine.on('error', e => errors.push(String(e?.message ?? e)));
  engine.configure({
    targetIp: '127.0.0.1', targetPort: target.address().port,
    listenPort: taken.address().port, autoConnect: true, autoReconnect: true,
  });
  const ok = await settles(engine.open());
  assert.equal(ok, true, 'the engine comes up on a fallback port');
  assert.equal(engine.status, 'ready');
  const addr = engine.listenAddress();
  assert.ok(addr && addr.port !== taken.address().port, 'bound somewhere other than the busy port');
  assert.equal(engine.listenFallback, true, 'the engine knows it is not on the configured port');
  assert.ok(errors.some(m => /listen port/i.test(m) && m.includes(String(taken.address().port))),
    `the operator is told which port is busy (got: ${errors.join(' | ')})`);
  const gotMsg = once(target, 'message');
  engine.send('/composition/master', [0.5]);
  const [buf] = await gotMsg;
  assert.equal(decodePacket(buf)[0].address, '/composition/master');
});

test('a second open() while the first is still binding leaves no orphaned socket behind', async (t) => {
  const free = await blocker();
  const port = free.address().port;
  free.close();
  await new Promise(r => setTimeout(r, 20));
  const engine = new OscEngine();
  let again = null;
  t.after(() => shut(engine, again));
  engine.on('error', () => {});
  engine.configure({ targetIp: '127.0.0.1', targetPort: 9, listenPort: port, autoReconnect: false });
  const first = engine.open();   // bind in flight
  const second = engine.open();  // Save tapped twice
  const [r1, r2] = await settles(Promise.all([first, second]));
  assert.equal(r2, true, 'the latest open() wins');
  assert.equal(r1, false, 'the superseded open() reports that it lost');
  assert.equal(engine.listenAddress()?.port, port);
  engine.close();
  await new Promise(r => setTimeout(r, 20));
  again = dgram.createSocket('udp4');
  await new Promise((resolve, reject) => {
    again.on('error', err => reject(new Error(`port ${port} still held after close(): ${err.code}`)));
    again.bind(port, '0.0.0.0', resolve);
  });
});

test('a receive error on the bound socket does not drop the link', async (t) => {
  const target = await listener();
  t.after(() => shut(target));
  const engine = await openEngine(target.address().port);
  t.after(() => shut(engine));
  const errors = [];
  engine.on('error', e => errors.push(e));
  const socket = engine.socket;
  // Windows surfaces an ICMP port-unreachable as an error on the socket.
  socket.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
  await new Promise(r => setTimeout(r, 30));
  assert.equal(engine.socket, socket, 'the socket is kept');
  assert.equal(engine.status, 'ready');
  assert.equal(errors.length, 1, 'the error is still reported');
  const gotMsg = once(target, 'message');
  engine.send('/composition/master', [1]);
  await gotMsg;
});

test('a throwing message listener does not take the socket handler down', async (t) => {
  const target = await listener();
  t.after(() => shut(target));
  const engine = await openEngine(target.address().port);
  t.after(() => shut(engine));
  const seen = [];
  engine.on('message', m => { seen.push(m.address); if (seen.length === 1) throw new Error('renderer gone'); });
  engine.on('error', () => {});
  const port = engine.listenAddress().port;
  target.send(encodeMessage('/one', []), port, '127.0.0.1');
  await new Promise(r => setTimeout(r, 40));
  target.send(encodeMessage('/two', []), port, '127.0.0.1');
  await new Promise(r => setTimeout(r, 40));
  assert.deepEqual(seen, ['/one', '/two']);
});

test('inbound OSC bundles (Resolume sendBundles=1) are unpacked into messages and count as feedback', async (t) => {
  const sock = await listener();
  t.after(() => shut(sock));
  const engine = await openEngine(sock.address().port, { liveWindowMs: 200 });
  t.after(() => shut(engine));
  const got = [];
  engine.on('message', m => got.push(m));
  const el = buf => { const len = Buffer.alloc(4); len.writeInt32BE(buf.length); return Buffer.concat([len, buf]); };
  const header = Buffer.concat([Buffer.from('#bundle\0'), Buffer.alloc(8)]); // immediate timetag
  const inner = Buffer.concat([header, el(encodeMessage('/composition/layers/2/video/opacity', [{ type: 'f', value: 0.25 }]))]);
  const bundle = Buffer.concat([
    header,
    el(encodeMessage('/composition/tempocontroller/tempo', [{ type: 'f', value: 0.4 }])),
    el(encodeMessage('/composition/groups/1/video/effects/goo/bypassed', [{ type: 'i', value: 1 }])),
    el(inner), // Resolume nests bundles inside bundles
  ]);
  sock.send(bundle, engine.listenAddress().port, '127.0.0.1');
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(got.map(m => m.address), [
    '/composition/tempocontroller/tempo',
    '/composition/groups/1/video/effects/goo/bypassed',
    '/composition/layers/2/video/opacity',
  ]);
  assert.equal(engine.status, 'live', 'a bundle lights the LIVE lamp');
});
