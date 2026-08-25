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
//   4. Stuck-state safety: a held button, engaged trigger and deflected
//      stick all release when the pad vanishes or the window blurs, and a
//      pad + touch press on the same button leaves no orphaned repeat chain.
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

    // --- pad disconnect mid-hold: everything the pad was driving lets go ---
    // The Ally's pad vanishes from navigator.getGamepads() on an Armoury
    // Crate mode switch / firmware reconnect. A hold button, an engaged
    // trigger and a deflected stick must all release at that moment, not
    // stay latched until the pad happens to come back.
    const trig = defaults.triggers.rt;
    const stickX = defaults.sticks.ls.x;
    assert(trig.enabled && trig.engageAddress && trig.analogAddress, 'defaults: RT trigger enabled with engage + analog addresses');
    assert(defaults.sticks.ls.enabled && stickX.address, 'defaults: LS stick enabled with an X address');
    function argOf(log, addr) {
      const m = [...log].reverse().find(x => x.address === addr);
      return m?.args?.[0]?.value;
    }

    const flashM2 = defaults.fxButtons[2];
    assert(flashM2.gamepadButton === 2 && flashM2.mode === 'hold' && flashM2.address !== trig.engageAddress,
      'defaults: fxButtons[2] is a hold binding on X, separate from the RT engage clip');
    console.log('\n[pad] hold X + engage RT + deflect LS, then the pad disconnects');
    await setPad(idleButtons());
    await clearLog();
    await page.evaluate(() => {
      window.__gamepadOverride = {
        buttons: Array.from({ length: 16 }, (_, i) => (
          i === 2 ? { pressed: true, value: 1 } : i === 7 ? { pressed: true, value: 0.6 } : { pressed: false, value: 0 })),
        axes: [0.5, 0, 0, 0],
      };
    });
    await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
    await page.waitForTimeout(30);
    log = await readLog();
    assert(argOf(log, flashM2.address) === flashM2.value, 'X held: press message sent');
    assert(argOf(log, trig.engageAddress) === trig.engageValue, 'RT engaged: engage message sent');
    assert(typeof argOf(log, stickX.address) === 'number' && argOf(log, stickX.address) !== stickX.center, 'LS deflected: axis message sent');

    await clearLog();
    await page.evaluate(() => { window.__gamepadOverride = null; }); // pad gone
    await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
    await page.waitForTimeout(30);
    log = await readLog();
    assert(argOf(log, flashM2.address) === flashM2.releaseValue, 'pad disconnect releases the held X binding');
    assert(argOf(log, trig.engageAddress) === trig.engageReleaseValue, 'pad disconnect disengages RT (engage release message)');
    assert(argOf(log, trig.analogAddress) === trig.releaseValue, 'pad disconnect snaps the RT analog param back');
    assert(argOf(log, stickX.address) === stickX.center, 'pad disconnect re-centers the deflected stick axis');

    console.log('\n[pad] hold A (repeating PUSH WHT), then the pad disconnects');
    await setPad(idleButtons());
    await setPad(withButtons([[0, { pressed: true, value: 1 }]]));
    await clearLog();
    await page.evaluate(() => { window.__gamepadOverride = null; }); // pad gone
    await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
    await page.waitForTimeout(30);
    log = await readLog();
    assert(argOf(log, pushWhtAddr) === pushWht.releaseValue, 'pad disconnect releases the held A binding');
    await clearLog();
    await page.waitForTimeout(700); // PUSH WHT repeats every 200ms while held
    log = await readLog();
    assert(!hasAddr(log, pushWhtAddr), 'no repeat messages keep flowing after the pad disconnected');

    console.log('\n[pad] pad comes back with nothing held -> quiet');
    await clearLog();
    await setPad(idleButtons());
    log = await readLog();
    assert(log.length === 0, `reconnect with nothing held sends nothing (got ${log.length} messages)`);

    // --- window blur mid-hold: release, and stay quiet afterwards ----------
    const flashM = defaults.fxButtons[1];
    assert(flashM.gamepadButton === 1 && flashM.mode === 'hold', 'defaults: fxButtons[1] is a hold binding on B');
    console.log('\n[pad] hold B, then the window loses focus');
    await clearLog();
    await setPad(withButtons([[1, { pressed: true, value: 1 }]]));
    log = await readLog();
    assert(argOf(log, flashM.address) === flashM.value, 'B held: press message sent');
    await clearLog();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(30);
    log = await readLog();
    assert(argOf(log, flashM.address) === flashM.releaseValue, 'window blur releases the held B binding');
    await clearLog();
    await setPad(idleButtons()); // physical release after the blur
    log = await readLog();
    assert(!hasAddr(log, flashM.address), 'releasing B after the blur does not send a second release');

    // --- window blur while RT is physically held: one release pair, then
    // stay released until the trigger idles once ---------------------------
    // Focus theft (Armoury Crate overlay, a confirm() from settings, an OS
    // popup) fires releaseAll() while the operator is still standing on RT.
    // The engine must send exactly one engage-release + analog-release pair
    // and then ignore the still-down trigger: re-engaging on the next tick
    // would be an unrequested OFF/ON blip of the strobe clip. Like a held
    // button, RT only goes live again after it has read idle once.
    const rtDown = depth => withButtons([[7, { pressed: true, value: depth }]]);
    const rtDepth = depth => trig.from + (trig.to - trig.from) * depth;
    function countAddr(log, addr) { return log.filter(m => m.address === addr).length; }
    console.log('\n[pad] engage RT, then the window loses focus while RT stays down');
    await setPad(idleButtons());
    await clearLog();
    await setPad(rtDown(0.6));
    log = await readLog();
    assert(argOf(log, trig.engageAddress) === trig.engageValue, 'RT engaged: engage message sent');
    assert(argOf(log, trig.analogAddress) === rtDepth(0.6), 'RT engaged: analog depth sent');

    await clearLog();
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await setPad(rtDown(0.6)); // the pad keeps reporting RT down on the frames after the blur
    await setPad(rtDown(0.6));
    log = await readLog();
    assert(countAddr(log, trig.engageAddress) === 1 && argOf(log, trig.engageAddress) === trig.engageReleaseValue,
      `blur sends exactly one engage-release and no re-engage while RT stays down (got ${countAddr(log, trig.engageAddress)} engage messages)`);
    assert(countAddr(log, trig.analogAddress) === 1 && argOf(log, trig.analogAddress) === trig.releaseValue,
      `blur sends exactly one analog release and no re-applied depth while RT stays down (got ${countAddr(log, trig.analogAddress)} analog messages)`);

    await clearLog();
    await setPad(rtDown(0.9)); // depth changes without ever idling -> still quiet
    log = await readLog();
    assert(!hasAddr(log, trig.engageAddress) && !hasAddr(log, trig.analogAddress),
      'changing RT depth after the blur (never idled) sends nothing');

    await clearLog();
    await setPad(idleButtons()); // physical release after the blur
    log = await readLog();
    assert(!hasAddr(log, trig.engageAddress) && !hasAddr(log, trig.analogAddress),
      'releasing RT after the blur does not send a second release pair');

    await clearLog();
    await setPad(rtDown(0.6)); // fresh press -> normal behaviour resumes
    log = await readLog();
    assert(argOf(log, trig.engageAddress) === trig.engageValue, 'pressing RT again after it idled re-engages normally');
    assert(argOf(log, trig.analogAddress) === rtDepth(0.6), 'pressing RT again after it idled sends its depth again');
    await setPad(idleButtons());

    // Same guarantee on the pad-loss path (Armoury Crate mode switch): the
    // pad vanishes and comes back while RT is still down.
    console.log('\n[pad] engage RT, the pad vanishes, then returns with RT still down');
    await clearLog();
    await setPad(rtDown(0.6));
    await clearLog();
    await page.evaluate(() => { window.__gamepadOverride = null; }); // pad gone
    await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
    await setPad(rtDown(0.6)); // pad is back, RT never idled
    await setPad(rtDown(0.6));
    log = await readLog();
    assert(countAddr(log, trig.engageAddress) === 1 && argOf(log, trig.engageAddress) === trig.engageReleaseValue,
      `pad loss + return with RT still down: one engage-release, no re-engage (got ${countAddr(log, trig.engageAddress)} engage messages)`);
    assert(countAddr(log, trig.analogAddress) === 1 && argOf(log, trig.analogAddress) === trig.releaseValue,
      `pad loss + return with RT still down: one analog release, no re-applied depth (got ${countAddr(log, trig.analogAddress)} analog messages)`);
    await clearLog();
    await setPad(idleButtons());
    await setPad(rtDown(0.6));
    log = await readLog();
    assert(argOf(log, trig.engageAddress) === trig.engageValue, 'RT idles then presses again after the reconnect -> engages normally');
    await setPad(idleButtons());

    // --- pad + touch on the same button: one repeat chain, not two ---------
    // Two press() calls without a matching pair of releases used to leave a
    // self-rescheduling repeat timer running forever.
    console.log('\n[pad+touch] press A on the pad and touch PUSH WHT at the same time');
    const pushWhtBtn = page.locator('.fx-btn[data-kind="fxButtons"][data-index="14"]');
    await pushWhtBtn.scrollIntoViewIfNeeded();
    const box = await pushWhtBtn.boundingBox();
    assert(box, 'PUSH WHT button is on screen');
    await setPad(withButtons([[0, { pressed: true, value: 1 }]]));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(30);
    await setPad(idleButtons());
    await page.mouse.up();
    await page.waitForTimeout(30);
    await clearLog();
    await page.waitForTimeout(700);
    log = await readLog();
    assert(!hasAddr(log, pushWhtAddr), `no orphaned repeat chain after pad+touch double press (got ${log.filter(m => m.address === pushWhtAddr).length} extra messages)`);

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
