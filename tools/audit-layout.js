#!/usr/bin/env node
'use strict';
// Layout audit inside the real app: real Electron, real fonts, the operator's
// own config, the actual window.
//
//   node tools/audit-layout.js [1704x979 ...]
//
// This is the authority, not test/ui/min-window.spec.mjs. That spec runs in a
// headless browser, which resolves a different font than Electron does, and
// font metrics decide whether a label fits. It also cannot see that the window
// frame eats into the content box — which is exactly how the Page 2 FX labels
// ended up clipped by 4px while every browser check said the layout was clean.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { MIN_WIDTH, MIN_HEIGHT, DEV_WIDTH, DEV_HEIGHT } = require('../src/window-size.js');

const ROOT = path.join(__dirname, '..');
const sizes = process.argv.slice(2).filter(a => /^\d+x\d+$/.test(a));
const TARGETS = sizes.length ? sizes : [`${MIN_WIDTH}x${MIN_HEIGHT}`, `${DEV_WIDTH}x${DEV_HEIGHT}`, '1920x1080'];

function runOnce(size) {
  return new Promise(resolve => {
    const child = spawn('npx', ['electron', '.'], {
      cwd: ROOT,
      env: { ...process.env, ROGGER_LAYOUT_AUDIT: size },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    child.on('close', () => {
      const cuts = out.split('\n').filter(l => l.startsWith('LAYOUT_CUT'));
      const header = out.split('\n').find(l => l.startsWith('LAYOUT_AUDIT window')) ?? '';
      const actual = /window=(\d+x\d+)/.exec(header)?.[1] ?? '?';
      const font = /-> (.*)$/.exec(header)?.[1] ?? '?';
      resolve({ size, actual, font, cuts });
    });
  });
}

async function main() {
  let total = 0;
  for (const size of TARGETS) {
    const r = await runOnce(size);
    // The window can be clamped from below by the declared floor, or from
    // above by the screen it is on — either way, report what was measured.
    const clamped = r.actual !== size ? `  (actually measured at ${r.actual})` : '';
    console.log(`\n=== requested ${size}${clamped} ===`);
    console.log(`    font: ${r.font}`);
    if (!r.cuts.length) {
      console.log('    nothing clipped');
    } else {
      total += r.cuts.length;
      for (const c of r.cuts) console.log(`    ${c.replace(/^LAYOUT_CUT /, '')}`);
    }
  }
  console.log(`\n${total} clipped element(s) across ${TARGETS.length} size(s).`);
  process.exitCode = total ? 1 : 0;
}
main();
