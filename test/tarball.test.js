'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const tar = require('../src/main/tarball.js');

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rogger-tar-'));
});

test('round trips names, contents and modes', () => {
  const entries = [
    { name: 'src/main/main.js', data: 'module.exports = 1;\n' },
    { name: 'payload.json', data: '{"version":"2.1.0"}' },
    { name: 'tools/run.sh', data: '#!/bin/sh\n', mode: 0o755 },
  ];
  const out = tar.unpack(tar.packGzip(entries));
  assert.equal(out.length, 3);
  const byName = Object.fromEntries(out.map(e => [e.name, e]));
  assert.equal(byName['src/main/main.js'].data.toString(), 'module.exports = 1;\n');
  assert.equal(byName['payload.json'].data.toString(), '{"version":"2.1.0"}');
  assert.equal(byName['tools/run.sh'].mode, 0o755);
  assert.equal(byName['payload.json'].mode, 0o644);
});

test('round trips binary content and empty files byte for byte', () => {
  const blob = Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256));
  const out = tar.unpack(tar.packGzip([
    { name: 'blob.bin', data: blob },
    { name: 'empty.txt', data: '' },
  ]));
  const byName = Object.fromEntries(out.map(e => [e.name, e.data]));
  assert.deepEqual(byName['blob.bin'], blob);
  assert.equal(byName['empty.txt'].length, 0);
});

test('round trips utf-8 content across the 512-byte block boundary', () => {
  // Sizes either side of a block edge catch off-by-one padding bugs.
  for (const size of [511, 512, 513, 1023, 1024]) {
    const data = 'x'.repeat(size);
    const [entry] = tar.unpack(tar.packGzip([{ name: 'f.txt', data }]));
    assert.equal(entry.data.toString(), data, `size ${size}`);
  }
  const [utf] = tar.unpack(tar.packGzip([{ name: 'á.txt', data: 'árvíztűrő tükörfúrógép' }]));
  assert.equal(utf.data.toString('utf8'), 'árvíztűrő tükörfúrógép');
});

test('output is deterministic — same entries, same bytes', () => {
  const entries = [{ name: 'b.js', data: 'b' }, { name: 'a.js', data: 'a' }];
  const first = tar.packGzip(entries);
  const second = tar.packGzip([...entries].reverse());
  assert.deepEqual(first, second, 'entry order must not change the archive');
});

test('accepts an uncompressed tar as well as gzip', () => {
  const raw = tar.pack([{ name: 'a.js', data: 'a' }]);
  assert.equal(tar.unpack(raw)[0].data.toString(), 'a');
});

test('safeEntryName rejects anything that could escape the root', () => {
  for (const bad of [
    '../evil.js', 'src/../../evil.js', '/etc/passwd', 'C:/windows/x.dll',
    'src\\main\\x.js', 'a//b.js', './a.js', 'a/./b.js', '', 'a\0b',
  ]) {
    assert.equal(tar.safeEntryName(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
  assert.equal(tar.safeEntryName('src/main/main.js'), 'src/main/main.js');
});

test('unpack refuses a traversal path even when the header is well formed', () => {
  // Hand-build a valid archive whose entry name climbs out of the root.
  const good = tar.pack([{ name: 'aaaaaaaa.js', data: 'x' }]);
  const evil = Buffer.from(good);
  const name = '../../evil.js';
  evil.fill(0, 0, 100);
  evil.write(name, 0, 100, 'utf8');
  // rewrite the checksum so it is the path guard that rejects it, not the sum
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : evil[i];
  evil.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  assert.throws(() => tar.unpack(evil), /unsafe path/);
});

test('unpack rejects a corrupted header', () => {
  const buf = tar.pack([{ name: 'a.js', data: 'a' }]);
  buf.write('zzzzzzzz', 0, 8, 'ascii'); // changes the name, invalidates the checksum
  assert.throws(() => tar.unpack(buf), /checksum mismatch/);
});

test('unpack rejects symlinks and other non-regular entries', () => {
  const buf = tar.pack([{ name: 'a.js', data: 'a' }]);
  buf.write('2', 156, 1, 'ascii'); // typeflag 2 = symlink
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  assert.throws(() => tar.unpack(buf), /unsupported tar entry type/);
});

test('unpack enforces the file-count and total-size ceilings', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.js`, data: 'x' }));
  assert.throws(() => tar.unpack(tar.packGzip(many), { maxFiles: 10 }), /more than 10 files/);
  // Raw tar: the ceiling is enforced entry by entry as the archive is read.
  const big = [{ name: 'big.bin', data: Buffer.alloc(4096, 1) }];
  assert.throws(() => tar.unpack(tar.pack(big), { maxTotalBytes: 1024 }), /expands past/);
  // Gzipped: zlib refuses to inflate past the ceiling in the first place.
  assert.throws(() => tar.unpack(tar.packGzip(big), { maxTotalBytes: 1024 }));
});

test('unpack rejects a gzip bomb before it is fully inflated', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x41));
  assert.throws(() => tar.unpack(bomb, { maxTotalBytes: 64 * 1024 }));
});

test('unpack rejects a truncated archive', () => {
  const buf = tar.pack([{ name: 'a.js', data: 'a'.repeat(600) }]);
  assert.throws(() => tar.unpack(buf.subarray(0, 512 + 512)), /past end of archive|not a multiple/);
});

test('extractTo writes the tree and reports the file list', () => {
  const dest = path.join(dir, 'staging');
  const written = tar.extractTo(tar.packGzip([
    { name: 'src/main/main.js', data: 'start' },
    { name: 'configs/show.json', data: '{}' },
  ]), dest);
  assert.deepEqual(written.sort(), ['configs/show.json', 'src/main/main.js']);
  assert.equal(fs.readFileSync(path.join(dest, 'src', 'main', 'main.js'), 'utf8'), 'start');
  assert.equal(fs.readFileSync(path.join(dest, 'configs', 'show.json'), 'utf8'), '{}');
});

test('extractTo leaves nothing outside the destination', () => {
  const dest = path.join(dir, 'staging');
  const sentinel = path.join(dir, 'evil.js');
  const buf = tar.pack([{ name: 'aaaaaaaaaaa.js', data: 'pwned' }]);
  buf.fill(0, 0, 100);
  buf.write('../evil.js', 0, 100, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += (i >= 148 && i < 156) ? 0x20 : buf[i];
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  assert.throws(() => tar.extractTo(buf, dest));
  assert.equal(fs.existsSync(sentinel), false, 'nothing may be written outside dest');
});

test('long paths survive the USTAR prefix split', () => {
  const deep = `src/renderer/js/${'nested/'.repeat(12)}component.js`;
  assert.ok(deep.length > 100, 'the fixture must actually exceed the 100-byte name field');
  const [entry] = tar.unpack(tar.packGzip([{ name: deep, data: 'deep' }]));
  assert.equal(entry.name, deep);
  assert.equal(entry.data.toString(), 'deep');
});
