// Browser-mode check of safety switches + panic + shot + max fire time.
// Run by hand: `PW_CHANNEL=chrome node test/ui/safety.spec.mjs` (spawns test/serve.js).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5196;
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.env.SAFETY_SHOTS; // folder for screenshots

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
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.goto(URL);
  await page.waitForFunction(() => document.body.dataset.ready === '1');
  const dmx = ch => page.evaluate(c => {
    const m = window.__oscLog.filter(x => x.address.startsWith('sacn://') && x.address.split('?')[0].endsWith('/' + c)).at(-1);
    return m ? m.args[0].value : null;
  }, ch);
  const fieldInput = label => page.locator('#editor-overlay .field').filter({ has: page.locator('label', { hasText: label }) }).locator('input').first();
  const seg = (label, text) => page.locator('#editor-overlay .field').filter({ has: page.locator('label', { hasText: label }) }).locator('.seg button', { hasText: text });
  const btn = page.locator('.fx-btn[data-kind="fxButtons"][data-index="0"]');
  const tap = async () => { await btn.dispatchEvent('pointerdown', { pointerId: 1, button: 0 }); await btn.dispatchEvent('pointerup', { pointerId: 1, button: 0 }); await page.waitForTimeout(60); };
  const save = async () => { await page.click('#ed-save'); await page.waitForSelector('#editor-overlay', { state: 'detached' }); await page.waitForTimeout(100); };

  console.log('[safety] add a safety in Settings');
  await page.click('#settings-open');
  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await page.click('#safety-add');
  await page.waitForSelector('#editor-overlay');
  await page.fill('#editor-overlay .field:has(label:text("Label")) input', 'CO2 ARM');
  await fieldInput(/^Universe/).fill('8');
  await fieldInput(/^Channel/).fill('1');
  await fieldInput(/^ARMED value/).fill('200');
  await fieldInput(/^SAFE value/).fill('5');
  await save();
  assert(await dmx(1) === 5, 'saving the safety sends SAFE on its channel');
  assert((await page.textContent('#target-readout')) === 'SAFE', 'topbar shows SAFE');

  console.log('[button] CO2 button: sACN toggle, linked to CO2 ARM, max 1 s');
  await page.click('#edit-toggle');
  await btn.click();
  await page.waitForSelector('#editor-overlay');
  await page.locator('#editor-overlay .seg button', { hasText: 'sACN (DMX)' }).click();
  await seg('Mode', 'TOGGLE').click();
  await fieldInput(/^Universe/).fill('8');
  await fieldInput(/^Channel/).fill('3');
  await fieldInput(/^Max fire time/).fill('1');
  await seg('Safety', 'CO2 ARM').click();
  if (SHOTS) await page.locator('#editor-overlay .panel').screenshot({ path: `${SHOTS}/editor.png` });
  await save();
  await page.click('#edit-toggle');
  assert(await btn.evaluate(e => e.classList.contains('fx-btn--blocked')), 'button is greyed while SAFE');
  if (SHOTS) await page.locator('#topbar').screenshot({ path: `${SHOTS}/topbar-safe.png` });
  if (SHOTS) await btn.screenshot({ path: `${SHOTS}/blocked.png` });
  await tap();
  assert(await dmx(3) === 0, 'press while SAFE sends nothing but the default');
  assert(await page.locator('.toast').filter({ hasText: 'arm it first' }).count() > 0, 'and says why');

  console.log('[arm] arm from Settings, fire, max time cuts it');
  await page.click('#settings-open');
  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await page.locator('.safety-row .safety-arm').click();
  assert(await dmx(1) === 200, 'ARMED value goes out');
  if (SHOTS) await page.locator('#settings-overlay .panel').screenshot({ path: `${SHOTS}/settings.png` });
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => document.getElementById('settings-overlay')?.remove());
  assert((await page.textContent('#target-readout')).startsWith('ARMED: CO2 ARM'), 'topbar shows ARMED');
  if (SHOTS) await page.locator('#topbar').screenshot({ path: `${SHOTS}/topbar-armed.png` });
  assert(!(await btn.evaluate(e => e.classList.contains('fx-btn--blocked'))), 'button unlocked');
  await tap();
  assert(await dmx(3) === 255, 'toggle on fires');
  await page.waitForTimeout(1200);
  assert(await dmx(3) === 0, 'max fire time (1 s) cuts it back to default');
  assert(!(await btn.evaluate(e => e.classList.contains('latched'))), 'and unlatches the button');

  console.log('[disarm] firing button is forced off on disarm');
  await tap();
  assert(await dmx(3) === 255, 'fires again');
  await page.evaluate(() => window.__rogger_test_disarm?.());
  await page.click('#settings-open');
  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await page.locator('.safety-row .safety-arm').click();
  await page.evaluate(() => document.getElementById('settings-overlay')?.remove());
  assert(await dmx(1) === 5 && await dmx(3) === 0, 'disarm: SAFE out, linked jet at default');

  console.log('[panic] panic from Settings');
  await page.click('#settings-open');
  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await page.locator('.safety-row .safety-arm').click();
  await page.evaluate(() => document.getElementById('settings-overlay')?.remove());
  await tap();
  assert(await dmx(3) === 255, 'armed and firing');
  await page.click('#settings-open');
  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await page.click('#safety-panic');
  await page.evaluate(() => document.getElementById('settings-overlay')?.remove());
  assert(await dmx(1) === 5 && await dmx(3) === 0, 'panic: SAFE + default');
  assert((await page.textContent('#target-readout')) === 'SAFE', 'topbar back to SAFE');

  console.log('[shot] SHOT 300 ms on a free button');
  const b2 = page.locator('.fx-btn[data-kind="fxButtons"][data-index="1"]');
  await page.click('#edit-toggle');
  await b2.click();
  await page.waitForSelector('#editor-overlay');
  await page.locator('#editor-overlay .seg button', { hasText: 'sACN (DMX)' }).click();
  await seg('Mode', 'SHOT').click();
  await fieldInput(/^Universe/).fill('8');
  await fieldInput(/^Channel/).fill('4');
  await fieldInput(/^Shot length/).fill('300');
  await save();
  await page.click('#edit-toggle');
  await b2.dispatchEvent('pointerdown', { pointerId: 1, button: 0 });
  await b2.dispatchEvent('pointerup', { pointerId: 1, button: 0 });
  await page.waitForTimeout(60);
  assert(await dmx(4) === 255, 'shot fires on press even after release');
  await page.waitForTimeout(400);
  assert(await dmx(4) === 0, 'and ends by itself');
  assert(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  console.log('\nSAFETY_SPEC_OK');
} finally {
  await browser?.close();
  server.kill();
}
