'use strict';
// Companion Satellite client against a fake Companion on an ephemeral port.
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { CompanionClient, parseLine } = require('../src/main/companion.js');

test('parseLine handles quoted and bare args', () => {
  const p = parseLine('ADD-DEVICE ERROR DEVICEID=x MESSAGE="bad thing \\"here\\""');
  assert.equal(p.cmd, 'ADD-DEVICE');
  assert.equal(p.args.DEVICEID, 'x');
  assert.equal(p.args.MESSAGE, 'bad thing "here"');
});

test('registers as an XL, renders keys, answers pings, sends presses', async () => {
  const lines = [];
  let sock;
  const server = net.createServer(s => {
    sock = s;
    s.on('data', d => lines.push(...d.toString().split('\n').filter(Boolean)));
    s.write('BEGIN CompanionVersion=4.0.0 ApiVersion=1.7.0\n');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const events = [];
  const c = new CompanionClient({ deviceId: 'TEST', onEvent: e => events.push(e) });
  c.connect('127.0.0.1', server.address().port);
  const until = async fn => { for (let i = 0; i < 100 && !fn(); i++) await new Promise(r => setTimeout(r, 10)); assert.ok(fn()); };

  await until(() => lines.some(l => l.startsWith('ADD-DEVICE')));
  const add = lines.find(l => l.startsWith('ADD-DEVICE'));
  assert.match(add, /KEYS_TOTAL=32 KEYS_PER_ROW=8 BITMAPS=72/);

  sock.write('ADD-DEVICE OK DEVICEID=TEST\nPING abc\n');
  sock.write(`KEY-STATE DEVICEID=TEST KEY=5 TYPE=BUTTON COLOR=#ff0000 TEXT=${Buffer.from('GO').toString('base64')} PRESSED=false\n`);
  sock.write('KEY-STATE DEVICEID=OTHER KEY=6 COLOR=#00ff00\n');
  await until(() => events.some(e => e.type === 'key'));
  assert.equal(c.status, 'connected');
  await until(() => lines.includes('PONG abc'));
  const keyEvents = events.filter(e => e.type === 'key');
  assert.equal(keyEvents.length, 1, 'other device ignored');
  assert.equal(keyEvents[0].key, 5);
  assert.equal(keyEvents[0].text, 'GO');

  c.press(5, true);
  await until(() => lines.includes('KEY-PRESS DEVICEID=TEST KEY=5 PRESSED=true'));

  c.disconnect();
  await until(() => lines.includes('REMOVE-DEVICE DEVICEID=TEST'));
  assert.equal(c.status, 'off');
  server.close();
});
