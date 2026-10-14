// Browser-mode check of the native sACN button: Output -> sACN in the editor,
// fields, Save, the default level going out, hold press/release and toggle.
// Run by hand: `node test/ui/sacn-button.spec.mjs` (spawns its own test/serve.js).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5197;
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..', '..');
const SHOT = process.env.SACN_SHOT;

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ok - ' + msg);
}
async function waitForServer(url) {
  for (let i = 0; i < 100; i += 1) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}

const server = spawn(process.execPath, ['test/serve.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
let browser;
try {
  await waitForServer(URL + '/__defaults');
  browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const page = await browser.newPage({ viewport: { width: 1704, height: 1035 } });
  page.on('pageerror', err => { throw err; });
  await page.goto(URL);
  await page.waitForFunction(() => document.body.dataset.ready === '1');
  const log = () => page.evaluate(() => window.__oscLog.filter(m => m.address.startsWith('sacn://')).map(m => [m.address, m.args?.[0]?.value]));
  const fieldInput = label => page.locator('#editor-overlay .field').filter({ has: page.locator('label', { hasText: label }) }).locator('input');
  const btn = '.fx-btn[data-kind="fxButtons"][data-index="0"]';

  await page.click('#edit-toggle');
  await page.click(btn);
  await page.waitForSelector('#editor-overlay');
  await page.locator('#editor-overlay .seg button', { hasText: 'sACN (DMX)' }).click();
  assert(await page.locator('#ed-address').count() === 0, 'sACN form hides the OSC address');
  assert(await page.locator('#editor-overlay .seg button', { hasText: 'TAP' }).count() === 0, 'no TAP mode for a DMX button');
  await fieldInput(/^Universe/).fill('8');
  await fieldInput(/^Channel/).fill('3');
  await fieldInput(/^Press value/).fill('200');
  await fieldInput(/^Default value/).fill('10');
  await page.fill('#editor-overlay .field:has(label:text("Label")) input', 'CO2');
  if (SHOT) await page.locator('#editor-overlay .panel').screenshot({ path: SHOT });
  const overflow = await page.evaluate(() => [...document.querySelectorAll('#editor-overlay .panel-body *')]
    .filter(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'auto').map(e => e.className).slice(0, 3));
  assert(overflow.length === 0, `nothing in the sACN form overflows (${overflow})`);
  await page.click('#ed-save');
  await page.waitForSelector('#editor-overlay', { state: 'detached' });
  let l = await log();
  assert(l.length && l.at(-1)[0] === 'sacn://8/3?default=10' && l.at(-1)[1] === 10, `Save sends the default level (${JSON.stringify(l.at(-1))})`);
  assert((await page.locator(btn + ' .fx-label').textContent()) === 'CO2', 'label shows');

  await page.click('#edit-toggle');
  const b = page.locator(btn);
  await b.dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true, button: 0 });
  await page.waitForTimeout(60);
  l = await log();
  assert(l.at(-1)[1] === 200, `hold: press sends 200 (${l.at(-1)[1]})`);
  await b.dispatchEvent('pointerup', { pointerId: 1, isPrimary: true, button: 0 });
  await page.waitForTimeout(60);
  l = await log();
  assert(l.at(-1)[1] === 10, `hold: release sends the default 10 (${l.at(-1)[1]})`);

  await page.click('#edit-toggle');
  await page.click(btn);
  await page.locator('#editor-overlay .seg button', { hasText: 'TOGGLE' }).click();
  await page.click('#ed-save');
  await page.waitForSelector('#editor-overlay', { state: 'detached' });
  await page.click('#edit-toggle');
  for (const want of [200, 10, 200]) {
    await b.dispatchEvent('pointerdown', { pointerId: 1, isPrimary: true, button: 0 });
    await b.dispatchEvent('pointerup', { pointerId: 1, isPrimary: true, button: 0 });
    await page.waitForTimeout(60);
    l = await log();
    assert(l.at(-1)[1] === want, `toggle press -> ${want} (${l.at(-1)[1]})`);
  }
  const cfg = await page.evaluate(() => fetch('/__config').then(r => r.ok ? r.json() : null).catch(() => null));
  console.log('\nSACN_SPEC_OK');
} finally {
  await browser?.close();
  server.kill();
}
