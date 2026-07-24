'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { encodeMessage, decodePacket, inferArgs } = require('../src/main/osc.js');

test('round-trips an int message', () => {
  const buf = encodeMessage('/composition/layers/1/clips/1/connect', [{ type: 'i', value: 1 }]);
  const msgs = decodePacket(buf);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].address, '/composition/layers/1/clips/1/connect');
  assert.deepEqual(msgs[0].args, [{ type: 'i', value: 1 }]);
});

test('round-trips a float with 1e-6 precision', () => {
  const buf = encodeMessage('/composition/master', [{ type: 'f', value: 0.7351 }]);
  const [msg] = decodePacket(buf);
  assert.equal(msg.args[0].type, 'f');
  assert.ok(Math.abs(msg.args[0].value - 0.7351) < 1e-6);
});

test('round-trips strings of every padding length', () => {
  for (const s of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
    const buf = encodeMessage('/x', [{ type: 's', value: s }]);
    assert.equal(buf.length % 4, 0, `buffer for "${s}" is 4-byte aligned`);
    const [msg] = decodePacket(buf);
    assert.deepEqual(msg.args, [{ type: 's', value: s }]);
  }
});

test('round-trips a message with no args', () => {
  const buf = encodeMessage('/composition/tempocontroller/tempotap', []);
  const [msg] = decodePacket(buf);
  assert.equal(msg.address, '/composition/tempocontroller/tempotap');
  assert.deepEqual(msg.args, []);
});

test('round-trips mixed args in order', () => {
  const args = [{ type: 'i', value: 3 }, { type: 'f', value: 0.5 }, { type: 's', value: 'go' }];
  const [msg] = decodePacket(encodeMessage('/mix', args));
  assert.equal(msg.args[0].value, 3);
  assert.ok(Math.abs(msg.args[1].value - 0.5) < 1e-6);
  assert.equal(msg.args[2].value, 'go');
});

test('decodes a bundle into its flattened messages', () => {
  const m1 = encodeMessage('/a', [{ type: 'i', value: 1 }]);
  const m2 = encodeMessage('/b', [{ type: 'f', value: 2.5 }]);
  const header = Buffer.alloc(16);
  header.write('#bundle\0', 0, 'ascii');
  header.writeBigUInt64BE(1n, 8); // immediate timetag
  const size1 = Buffer.alloc(4); size1.writeInt32BE(m1.length);
  const size2 = Buffer.alloc(4); size2.writeInt32BE(m2.length);
  const bundle = Buffer.concat([header, size1, m1, size2, m2]);
  const msgs = decodePacket(bundle);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].address, '/a');
  assert.equal(msgs[1].address, '/b');
});

test('throws on malformed packets', () => {
  assert.throws(() => decodePacket(Buffer.from('garbage')));
  assert.throws(() => decodePacket(Buffer.alloc(0)));
  // address not starting with '/' and no bundle header
  assert.throws(() => decodePacket(Buffer.from('abcd\0\0\0\0,\0\0\0')));
});

test('inferArgs types integers, floats and strings', () => {
  assert.deepEqual(inferArgs([1, 0.5, 'text']), [
    { type: 'i', value: 1 },
    { type: 'f', value: 0.5 },
    { type: 's', value: 'text' },
  ]);
});
