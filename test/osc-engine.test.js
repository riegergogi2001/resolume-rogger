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
