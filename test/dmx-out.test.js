'use strict';
// sacn:// / artnet:// button addresses: parsing, value = DMX level, packets, quit zeroes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { DmxOut, parse, level } = require('../src/main/dmx-out.js');

function fakeOut() {
  const sent = [];
  const sock = { send: (buf, port, host) => sent.push({ buf: Buffer.from(buf), port, host }) };
  const d = new DmxOut(() => sock);
  return { d, sent };
}
const sacnCh = (p, c) => p.buf[126 + c - 1];

test('parse', () => {
  assert.deepEqual(parse('sacn://8/3'), { proto: 'sacn', host: '239.255.0.8', port: 5568, universe: 8, channel: 3, iface: null });
  assert.equal(parse('sacn://300/1').host, '239.255.1.44');
  assert.equal(parse('sacn://8/3?host=10.0.0.50').host, '10.0.0.50');
  assert.equal(parse('sacn://8/3?iface=10.0.0.2').iface, '10.0.0.2');
  assert.equal(parse('sacn://0/1'), null, 'sACN universes start at 1');
  assert.equal(parse('sacn://1/513'), null);
  assert.equal(parse('artnet://10.0.0.5/0/1').port, 6454);
  assert.equal(parse('/composition/layers/1/clear'), null);
});

test('level: the sent value is the DMX level', () => {
  assert.equal(level([{ type: 'i', value: 255 }]), 255);
  assert.equal(level([{ type: 'i', value: 0 }]), 0);
  assert.equal(level([{ type: 'i', value: 300 }]), 255);
  assert.equal(level([{ type: 'f', value: 1 }]), 255, 'float 0..1 scales');
  assert.equal(level([{ type: 'f', value: 0.5 }]), 128);
  assert.equal(level([200]), 200);
  assert.equal(level([]), 0);
});

test('press / release / quit on sACN', () => {
  const { d, sent } = fakeOut();
  assert.equal(d.handle('/composition/x', [{ type: 'i', value: 1 }]), false);
  assert.equal(d.handle('sacn://8/3', [{ type: 'i', value: 200 }]), true);
  let p = sent.at(-1);
  assert.equal(p.port, 5568); assert.equal(p.host, '239.255.0.8'); assert.equal(p.buf.length, 638);
  assert.equal(p.buf.toString('latin1', 4, 13), 'ASC-E1.17');
  assert.equal(p.buf.readUInt32BE(18), 4);
  assert.equal(p.buf.readUInt32BE(40), 2);
  assert.equal(p.buf[108], 100);
  assert.equal(p.buf.readUInt16BE(113), 8);
  assert.equal(p.buf[117], 2); assert.equal(p.buf[118], 0xa1);
  assert.equal(p.buf.readUInt16BE(123), 513); assert.equal(p.buf[125], 0);
  assert.equal(sacnCh(p, 3), 200);
  d.handle('sacn://8/3', [{ type: 'i', value: 10 }]);
  assert.equal(sacnCh(sent.at(-1), 3), 10);
  d.handle('sacn://8/3', [{ type: 'i', value: 255 }]);
  d.close();
  assert.equal(sacnCh(sent.at(-1), 3), 0, 'quit zeroes the channel');
});

test('artnet packet', () => {
  const { d, sent } = fakeOut();
  d.handle('artnet://1.2.3.4/7/3', [{ type: 'i', value: 99 }]);
  const p = sent.at(-1);
  assert.equal(p.buf.toString('latin1', 0, 8), 'Art-Net\0');
  assert.equal(p.buf.readUInt16LE(14), 7);
  assert.equal(p.buf[18 + 2], 99);
  d.close();
});

test('real UDP: unicast sACN arrives', async () => {
  const rx = dgram.createSocket('udp4');
  await new Promise(r => rx.bind(0, '127.0.0.1', r));
  const port = rx.address().port;
  const got = new Promise(r => rx.once('message', m => r(m)));
  const d = new DmxOut();
  // same packet, test-only port: patch parse result via host + port override
  const out = { proto: 'sacn', host: '127.0.0.1', port, universe: 8, channel: 3, iface: null, data: Buffer.alloc(512) };
  out.data[2] = 255;
  d.sendOut(out);
  const m = await got;
  assert.equal(m.length, 638); assert.equal(m[126 + 2], 255); assert.equal(m.readUInt16BE(113), 8);
  rx.close(); d.close(); for (const s of d.sockets.values()) s.close();
});
