#!/usr/bin/env node
'use strict';
// Finds the smallest window the surface fits in with nothing shrinking,
// wrapping or clipped, and reports whether src/window-size.js still covers it.
//
//   node tools/measure-min-window.js
//
// Run this after changing any fixed label (a topbar button, a page tab, a
// fader name in the show config). If the natural minimum has grown past the
// declared floor, raise the numbers in src/window-size.js deliberately.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { chromium } = require('playwright');
const declared = require('../src/window-size.js');

const ROOT = path.join(__dirname, '..');
const PORT = 5192;
const URL = `http://127.0.0.1:${PORT}`;

// Anything that is cut off, hanging outside, or squeezed below its own content.
const FITS = () => {
  if (document.body.scrollWidth > window.innerWidth + 1) return false;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > window.innerWidth + 1.5 || r.bottom > window.innerHeight + 1.5) return false;
    if (cs.overflowY === 'hidden' && el.scrollHeight - el.clientHeight > 1) return false;
    if (cs.overflowX === 'hidden' && el.scrollWidth - el.clientWidth > 1 && cs.textOverflow !== 'ellipsis') return false;
  }
  return true;
};

function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      fetch(url).then(resolve).catch(err => {
        if (Date.now() > deadline) reject(err); else setTimeout(attempt, 100);
      });
    })();
  });
}

async function main() {
  const server = spawn(process.execPath, ['test/serve.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer(`${URL}/__defaults`);
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 2400, height: 1600 } });
    await page.goto(URL);
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    await page.waitForTimeout(400);

    const pageCount = await page.locator('#fx-grid .page-tab').count();
    const fitsAt = async (w, h) => {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(120);
      for (let i = 0; i < pageCount; i += 1) {
        await page.locator('#fx-grid .page-tab').nth(i).click();
        await page.waitForTimeout(130);
        if (!await page.evaluate(FITS)) return false;
      }
      return true;
    };
    const search = async (lo, hi, probe) => {
      while (lo < hi) { const mid = (lo + hi) >> 1; if (await probe(mid)) hi = mid; else lo = mid + 1; }
      return lo;
    };

    const width = await search(800, 2400, w => fitsAt(w, 1600));
    const height = await search(500, 1600, h => fitsAt(width, h));

    console.log(`natural minimum : ${width} x ${height}`);
    console.log(`declared floor  : ${declared.MIN_WIDTH} x ${declared.MIN_HEIGHT}  (src/window-size.js)`);
    const ok = width <= declared.MIN_WIDTH && height <= declared.MIN_HEIGHT;
    console.log(ok
      ? '\n[ok] the declared floor still covers the surface.'
      : `\n[!!] the surface outgrew its floor — raise it to at least ${width} x ${height}.`);
    process.exitCode = ok ? 0 : 1;
    await browser.close();
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('measure failed:', err.message);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
}
main();
