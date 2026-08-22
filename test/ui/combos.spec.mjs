// Browser-mode UI check for gamepad modifier combos (e.g. RT+A).
// Not part of `npm test` (node:test only runs test/*.test.js) — run by
// hand: `node test/ui/combos.spec.mjs` (it spawns its own test/serve.js).
//
// Flow:
//   1. Load the app in browser (mock-bridge) mode, using the default
//      config's existing A -> PUSH WHT binding as the "plain" baseline.
//   2. Through the real editor UI, bind FE STR (unbound by default) to
//      controller button A with modifier RT — i.e. RT+A.
//   3. Simulate the pad via window.__gamepadOverride and assert: A alone
//      still fires PUSH WHT; RT held + A fires FE STR instead; releasing
//      A (while RT stays held) releases FE STR, not PUSH WHT; the plain
//      A binding is provably untouched by the steal-on-save logic.
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5199;
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..', '..');

function idleButtons() {
  return Array.from({ length: 16 }, () => ({ pressed: false, value: 0 }));
}
function withButtons(overrides) {
  const b = idleButtons();
  for (const [i, v] of overrides) b[i] = v;
  return b;
}

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT FAILED: ' + msg);
  console.log('  ok - ' + msg);
}

function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function attempt() {
      fetch(url).then(() => resolve()).catch(err => {
        if (Date.now() > deadline) reject(err);
        else setTimeout(attempt, 100);
      });
    })();
  });
}

async function main() {
  const server = spawn(process.execPath, ['test/serve.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => process.stdout.write(`[serve] ${d}`));
  server.stderr.on('data', d => process.stderr.write(`[serve] ${d}`));

  let browser;
  try {
    await waitForServer(URL + '/__defaults');

    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log('[page console error]', msg.text());
    });
    page.on('pageerror', err => console.log('[page error]', err.message));

    await page.goto(URL);
    await page.waitForFunction(() => document.body.dataset.ready === '1');

    // --- sanity: read the served defaults to confirm the addresses we're
    // about to assert against (avoids hardcoding brittle assumptions).
    const defaults = await page.evaluate(() => fetch('/__defaults').then(r => r.json()));
    const pushWht = defaults.fxButtons[14];
    const feStr = defaults.fxButtons[5];
    assert(pushWht.label === 'PUSH WHT' && pushWht.gamepadButton === 0,
      'defaults: fxButtons[14] is PUSH WHT bound to A');
    assert(feStr.label === 'FE STR' && feStr.gamepadButton === -1,
      'defaults: fxButtons[5] is FE STR, unbound');
    const pushWhtAddr = pushWht.address;
    const feStrAddr = feStr.address;

    // --- 1. Add an RT+A combo through the real editor UI -----------------
    console.log('\n[UI] enter edit mode, bind FE STR to RT+A, save');
    await page.click('#edit-toggle');
    await page.click('.fx-btn[data-kind="fxButtons"][data-index="5"]'); // FE STR
    await page.waitForSelector('#editor-overlay');

    const ctrlField = page.locator('.field').filter({ has: page.locator('label', { hasText: /^Controller button$/ }) });
    const modField = page.locator('.field').filter({ has: page.locator('label', { hasText: /^Modifier \(hold with\)$/ }) });
    await ctrlField.getByRole('button', { name: 'A', exact: true }).click();
    await modField.getByRole('button', { name: 'RT', exact: true }).click();
    await page.click('#ed-save');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });
    await page.click('#edit-toggle'); // leave edit mode so gamepad presses act

    // --- badge check: FE STR shows "RT+A", PUSH WHT still shows plain "A"
    const feStrBadge = await page.locator('.fx-btn[data-kind="fxButtons"][data-index="5"] .fx-pad').textContent();
    const pushWhtBadge = await page.locator('.fx-btn[data-kind="fxButtons"][data-index="14"] .fx-pad').textContent();
    assert(feStrBadge === 'RT+A', `FE STR badge reads "RT+A" (got "${feStrBadge}")`);
    assert(pushWhtBadge === 'A', `PUSH WHT badge still reads plain "A" (got "${pushWhtBadge}", proves stealBinding left the plain pair alone)`);

    // --- gamepad frame helper: set override, give the rAF-driven tick a
    // couple of frames to observe it, then a small settle buffer.
    async function setPad(buttons) {
      await page.evaluate(btns => {
        window.__gamepadOverride = { buttons: btns, axes: [0, 0, 0, 0] };
      }, buttons);
      await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
      await page.waitForTimeout(30);
    }
    async function clearLog() { await page.evaluate(() => { window.__oscLog.length = 0; }); }
    async function readLog() { return page.evaluate(() => window.__oscLog); }
    function hasAddr(log, addr) { return log.some(m => m.address === addr); }

    console.log('\n[pad] establish idle baseline');
    await setPad(idleButtons());

    console.log('\n[pad] press A alone -> plain PUSH WHT binding');
    await clearLog();
    await setPad(withButtons([[0, { pressed: true, value: 1 }]]));
    let log = await readLog();
    assert(hasAddr(log, pushWhtAddr), `A alone fires the plain address ${pushWhtAddr}`);
    assert(!hasAddr(log, feStrAddr), 'A alone does not fire the combo address');

    console.log('\n[pad] release A -> plain release, no stray combo');
    await clearLog();
    await setPad(idleButtons());
    log = await readLog();
    assert(hasAddr(log, pushWhtAddr), 'releasing plain A sends its release message');
    assert(!hasAddr(log, feStrAddr), 'releasing plain A does not touch the combo address');

    console.log('\n[pad] hold RT (no other button) -> A\'s own action must not fire');
    await clearLog();
    await setPad(withButtons([[7, { pressed: true, value: 1 }]]));
    log = await readLog();
    assert(!hasAddr(log, pushWhtAddr), 'holding RT alone does not fire the plain A binding');
    assert(!hasAddr(log, feStrAddr), 'holding RT alone does not fire the RT+A combo');

    console.log('\n[pad] RT held + press A -> combo (FE STR) fires, not plain');
    await clearLog();
    await setPad(withButtons([[7, { pressed: true, value: 1 }], [0, { pressed: true, value: 1 }]]));
    log = await readLog();
    assert(hasAddr(log, feStrAddr), `RT+A fires the combo address ${feStrAddr}`);
    assert(!hasAddr(log, pushWhtAddr), 'RT+A does not fire the plain A address');

    console.log('\n[pad] release A (RT still held) -> combo release, no stray plain message');
    await clearLog();
    await setPad(withButtons([[7, { pressed: true, value: 1 }]]));
    log = await readLog();
    assert(hasAddr(log, feStrAddr), 'releasing A while RT is held sends the combo release message');
    assert(!hasAddr(log, pushWhtAddr), 'releasing A while RT is held does not send a stray plain message');

    console.log('\n[pad] release RT -> quiet (both buttons already released)');
    await clearLog();
    await setPad(idleButtons());
    log = await readLog();
    assert(!hasAddr(log, pushWhtAddr), 'releasing RT does not refire the plain address');
    assert(!hasAddr(log, feStrAddr), 'releasing RT does not refire the combo address');

    // --- screenshot -------------------------------------------------------
    const outDir = path.join(ROOT, 'test-artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'v2-combos.png');
    await page.screenshot({ path: outFile });
    console.log(`\n[screenshot] saved ${outFile}`);

    await browser.close();
    console.log('\nALL COMBO UI CHECKS PASSED');
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('\nCOMBO UI CHECK FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
}

main();
