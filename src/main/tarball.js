'use strict';
// Minimal deterministic USTAR tar + gzip, used for the OTA payload bundle.
//
// Node ships zlib but no archive reader, and the whole point of a payload
// update is that it must not drag a dependency tree onto the show machine.
// USTAR is the smallest format that survives a round trip through GitHub
// release assets: 512-byte headers, octal numbers, no central directory to
// disagree with the entry stream.
//
// Both sides live here so `tools/build-payload.js` and the updater can never
// drift apart, and so the unpacker's guards are exercised by the same tests
// that pack the archive.
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

// Extraction guards. A payload is a few hundred KB of hand-written JS; these
// ceilings are two orders of magnitude above that, so they only ever fire on
// a corrupt or hostile archive.
const DEFAULT_LIMITS = { maxFiles: 2000, maxTotalBytes: 32 * 1024 * 1024 };

function octal(value, width) {
  // width-1 octal digits, NUL terminated — the conservative USTAR spelling
  // that every reader accepts.
  const digits = value.toString(8);
  if (digits.length > width - 1) throw new Error(`value ${value} does not fit ${width} octal bytes`);
  return digits.padStart(width - 1, '0') + '\0';
}

function parseOctal(buf) {
  // Trailing NUL/space padding is legal and common; an all-blank field is 0.
  const text = buf.toString('ascii').replace(/[\0 ]+$/, '').trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new Error('malformed octal field in tar header');
  return parseInt(text, 8);
}

function checksum(header) {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    // The checksum field itself counts as eight spaces.
    sum += (i >= 148 && i < 156) ? 0x20 : header[i];
  }
  return sum;
}

function splitName(name) {
  if (Buffer.byteLength(name) <= NAME_MAX) return { prefix: '', rest: name };
  // USTAR splits long paths on a directory boundary into prefix + name.
  const cut = name.lastIndexOf('/', PREFIX_MAX);
  const prefix = cut > 0 ? name.slice(0, cut) : '';
  const rest = cut > 0 ? name.slice(cut + 1) : name;
  if (!prefix || Buffer.byteLength(rest) > NAME_MAX || Buffer.byteLength(prefix) > PREFIX_MAX) {
    throw new Error(`path too long for USTAR: ${name}`);
  }
  return { prefix, rest };
}

function header({ name, size, mode, type }) {
  const buf = Buffer.alloc(BLOCK);
  const { prefix, rest } = splitName(name);
  buf.write(rest, 0, NAME_MAX, 'utf8');
  buf.write(octal(mode, 8), 100, 8, 'ascii');
  buf.write(octal(0, 8), 108, 8, 'ascii');            // uid
  buf.write(octal(0, 8), 116, 8, 'ascii');            // gid
  buf.write(octal(size, 12), 124, 12, 'ascii');
  buf.write(octal(0, 12), 136, 12, 'ascii');          // mtime: fixed, for reproducible bundles
  buf.write(type, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  buf.write(prefix, 345, PREFIX_MAX, 'utf8');
  const sum = checksum(buf);
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

function pad(size) {
  const rem = size % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

/**
 * Pack entries into an uncompressed tar buffer.
 * Entries are sorted and stamped with a fixed mtime/uid/gid so the same input
 * always produces byte-identical output (the manifest sha256 depends on it).
 * @param {Array<{name: string, data: Buffer|string, mode?: number}>} entries
 */
function pack(entries) {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const chunks = [];
  for (const entry of sorted) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const name = entry.name.replace(/\\/g, '/');
    chunks.push(header({ name, size: data.length, mode: entry.mode ?? 0o644, type: '0' }), data, pad(data.length));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // two zero blocks close the archive
  return Buffer.concat(chunks);
}

function packGzip(entries) {
  // level 9 with a zeroed gzip mtime keeps the bundle reproducible.
  return zlib.gzipSync(pack(entries), { level: 9 });
}

/**
 * A payload path must be a plain relative POSIX path. Anything that could
 * escape the extraction root, or that the platform would reinterpret, is
 * refused outright rather than sanitized — a payload we cannot read literally
 * is a payload we do not trust.
 */
function safeEntryName(name) {
  if (!name || name.includes('\0')) return null;
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) return null; // absolute
  if (name.includes('\\')) return null;                             // windows separator
  const parts = name.split('/');
  if (parts.some(p => p === '..' || p === '.' || p === '')) return null;
  return parts.join('/');
}

/**
 * Read a tar (or tar.gz) buffer into entries.
 * @returns {Array<{name: string, mode: number, data: Buffer}>}
 */
function unpack(buffer, limits = {}) {
  const { maxFiles, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  let buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // gzip magic — accept both the compressed and the raw form.
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    buf = zlib.gunzipSync(buf, { maxOutputLength: maxTotalBytes });
  }
  if (buf.length % BLOCK !== 0) throw new Error('tar length is not a multiple of 512');

  const entries = [];
  let total = 0;
  let offset = 0;
  while (offset + BLOCK <= buf.length) {
    const head = buf.subarray(offset, offset + BLOCK);
    if (head.every(b => b === 0)) break; // end-of-archive marker
    offset += BLOCK;

    const stored = parseOctal(head.subarray(148, 156));
    if (stored !== checksum(head)) throw new Error('tar header checksum mismatch');

    const type = String.fromCharCode(head[156]);
    const prefix = head.subarray(345, 345 + PREFIX_MAX).toString('utf8').replace(/\0.*$/, '');
    const rest = head.subarray(0, NAME_MAX).toString('utf8').replace(/\0.*$/, '');
    const raw = prefix ? `${prefix}/${rest}` : rest;
    const size = parseOctal(head.subarray(124, 136));

    if (size < 0 || offset + size > buf.length) throw new Error('tar entry runs past end of archive');
    const data = buf.subarray(offset, offset + size);
    offset += size + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK));

    if (type === '5') continue;                       // directories are implied by file paths
    if (type !== '0' && type !== '\0') throw new Error(`unsupported tar entry type ${JSON.stringify(type)}`);

    const name = safeEntryName(raw);
    if (!name) throw new Error(`unsafe path in tar: ${JSON.stringify(raw)}`);

    total += size;
    if (entries.length >= maxFiles) throw new Error(`tar holds more than ${maxFiles} files`);
    if (total > maxTotalBytes) throw new Error(`tar expands past ${maxTotalBytes} bytes`);

    entries.push({ name, mode: parseOctal(head.subarray(100, 108)) & 0o777, data: Buffer.from(data) });
  }
  return entries;
}

/**
 * Extract into destDir. destDir must not already exist — callers stage into a
 * fresh directory and rename it into place, so a half-written extraction can
 * never be mistaken for an installed payload.
 */
function extractTo(buffer, destDir, limits = {}) {
  const entries = unpack(buffer, limits);
  const root = path.resolve(destDir);
  fs.mkdirSync(root, { recursive: true });
  for (const entry of entries) {
    const target = path.resolve(root, entry.name);
    // Belt and braces: safeEntryName already rejected traversal, but the
    // resolved path is what actually gets written.
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error(`tar entry escapes destination: ${entry.name}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data, { mode: entry.mode & 0o777 });
  }
  return entries.map(e => e.name);
}

module.exports = { pack, packGzip, unpack, extractTo, safeEntryName, DEFAULT_LIMITS };
