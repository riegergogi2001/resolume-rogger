#!/usr/bin/env node
'use strict';
// Builds the over-the-air payload bundle published with each release.
//
//   node tools/build-payload.js
//     -> dist-payload/rogger-payload-<version>.tar.gz
//        dist-payload/rogger-payload-<version>.json
//
// The tarball is the app itself (src/ + configs/) plus a payload.json stamped
// with the version. The manifest carries the sha256 the app checks before it
// unpacks anything, and minShell — the oldest exe that can run this payload.
//
// Deterministic: the same source tree always produces the same bytes, so a
// rebuilt release asset keeps its checksum.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tar = require('../src/main/tarball.js');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist-payload');
const INCLUDE = ['src', 'configs'];
// Editor droppings and OS metadata must never reach a show machine.
const SKIP = new Set(['.DS_Store', 'Thumbs.db', '__pycache__', '.gitkeep']);

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = pkg.version;
  const minShell = pkg.rogger?.minShell ?? version;

  const files = INCLUDE.flatMap(d => walk(path.join(ROOT, d)));
  if (!files.includes('src/main/main.js') || !files.includes('src/renderer/index.html')) {
    throw new Error('refusing to build: the payload would not be bootable');
  }

  const entries = files.map(name => ({
    name,
    data: fs.readFileSync(path.join(ROOT, name)),
    // Only the shell scripts need to stay executable; everything else is data.
    mode: name.endsWith('.sh') ? 0o755 : 0o644,
  }));
  entries.push({
    name: 'payload.json',
    data: JSON.stringify({ version, minShell, files: files.length }, null, 2),
  });

  const tarball = tar.packGzip(entries);
  const sha256 = crypto.createHash('sha256').update(tarball).digest('hex');

  // Prove the bundle round-trips before it is ever published.
  const back = tar.unpack(tarball);
  if (back.length !== entries.length) throw new Error('payload failed its own round-trip check');

  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tarPath = path.join(OUT_DIR, `rogger-payload-${version}.tar.gz`);
  const manifestPath = path.join(OUT_DIR, `rogger-payload-${version}.json`);
  fs.writeFileSync(tarPath, tarball);
  fs.writeFileSync(manifestPath, `${JSON.stringify({
    version, sha256, size: tarball.length, minShell,
  }, null, 2)}\n`);

  console.log(`payload  ${path.relative(ROOT, tarPath)}`);
  console.log(`  version  ${version}  (minShell ${minShell})`);
  console.log(`  files    ${entries.length}`);
  console.log(`  size     ${(tarball.length / 1024).toFixed(1)} KB`);
  console.log(`  sha256   ${sha256}`);
}

main();
