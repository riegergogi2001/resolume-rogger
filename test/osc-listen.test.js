'use strict';
// Where feedback can arrive must be visible: the engine reports the port it
// actually bound, and whether that is the one Settings asked for.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { OscEngine } = require('../src/main/osc-engine.js');

function hold() {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => resolve(s));
  });
}

test('listen event and listenInfo() name the bound port and flag a fallback', async t => {
  const taken = await hold();
  const engine = new OscEngine();
  t.after(() => { engine.close(); taken.close(); });
  engine.on('error', () => {});
  const seen = [];
  engine.on('listen', info => seen.push(info));
  engine.configure({ targetIp: '127.0.0.1', targetPort: 9, listenPort: taken.address().port, autoReconnect: false });
  assert.equal(await engine.open(), true, 'open() settles even though the port is taken');

  const info = engine.listenInfo();
  assert.equal(info.configured, taken.address().port);
  assert.equal(info.fallback, true, 'the engine says it is not on the configured port');
  assert.ok(info.port && info.port !== info.configured, 'and names the port it is really on');
  assert.deepEqual(seen.at(-1), info, 'the same facts were emitted as a listen event');

  engine.close();
  const closed = engine.listenInfo();
  assert.equal(closed.fallback, false);
  assert.equal(closed.port, null);
  assert.deepEqual(seen.at(-1), closed, 'closing emits too, so a stale warning cannot linger');
});

test('a normal bind reports fallback=false on the configured port', async t => {
  const engine = new OscEngine();
  t.after(() => engine.close());
  engine.on('error', () => {});
  engine.configure({ targetIp: '127.0.0.1', targetPort: 9, listenPort: 0, autoReconnect: false });
  assert.equal(await engine.open(), true);
  const info = engine.listenInfo();
  assert.equal(info.fallback, false);
  assert.ok(info.port > 0);
});
