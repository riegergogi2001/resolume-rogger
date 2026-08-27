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

    // --- LB+RT: an analog trigger as the combo's TARGET ------------------
    // Hold a pad button, pull RT: the combo fires as a hold and RT's own
    // stomp (engage clip + analog master) stays off for that pull. RT alone
    // is still the stomp. LB's own plain binding fires while held, as any
    // modifier's does.
    const rtTrig = defaults.triggers.rt;
    assert(rtTrig.enabled && rtTrig.engageAddress && rtTrig.analogAddress, 'defaults: RT is an enabled analog trigger');
    const suckIt = defaults.fxButtons.find(b => b.label === 'SUCK IT!');
    assert(suckIt.gamepadButton === 4 && (suckIt.gamepadModifier ?? -1) === -1, 'defaults: SUCK IT! is the plain LB binding');

    console.log('\n[UI] rebind FE STR to LB+RT through the editor');
    await page.click('#edit-toggle');
    await page.click('.fx-btn[data-kind="fxButtons"][data-index="5"]'); // FE STR
    await page.waitForSelector('#editor-overlay');
    await ctrlField.getByRole('button', { name: 'RT', exact: true }).click();
    await modField.getByRole('button', { name: 'LB', exact: true }).click();
    await page.click('#ed-save');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });
    await page.click('#edit-toggle');
    const lbRtBadge = await page.locator('.fx-btn[data-kind="fxButtons"][data-index="5"] .fx-pad').textContent();
    assert(lbRtBadge === 'LB+RT', `FE STR badge reads "LB+RT" (got "${lbRtBadge}")`);

    console.log('\n[pad] hold LB -> its own plain binding fires, RT untouched');
    await setPad(idleButtons());
    await clearLog();
    await setPad(withButtons([[4, { pressed: true, value: 1 }]]));
    log = await readLog();
    assert(hasAddr(log, suckIt.address), 'LB held: SUCK IT! (plain LB) fires');
    assert(!hasAddr(log, rtTrig.engageAddress) && !hasAddr(log, feStrAddr), 'nothing on RT yet');

    console.log('\n[pad] LB held + RT at 6% (below the digital edge) -> stomp held back');
    await clearLog();
    await setPad(withButtons([[4, { pressed: true, value: 1 }], [7, { pressed: false, value: 0.06 }]]));
    log = await readLog();
    assert(!hasAddr(log, rtTrig.engageAddress), 'the stomp does not engage under a combo-armed modifier');
    assert(!hasAddr(log, rtTrig.analogAddress), 'no analog value leaks out either');
    assert(!hasAddr(log, feStrAddr), 'and the combo waits for the digital edge');

    console.log('\n[pad] LB held + RT pulled -> LB+RT combo fires, stomp stays off');
    await clearLog();
    await setPad(withButtons([[4, { pressed: true, value: 1 }], [7, { pressed: true, value: 1 }]]));
    log = await readLog();
    assert(hasAddr(log, feStrAddr), `LB+RT fires the combo address ${feStrAddr}`);
    assert(!hasAddr(log, rtTrig.engageAddress), 'RT engage clip is NOT fired by a claimed pull');
    assert(!hasAddr(log, rtTrig.analogAddress), 'RT analog master is NOT driven by a claimed pull');

    console.log('\n[pad] release RT (LB held) -> combo release, no stomp release');
    await clearLog();
    await setPad(withButtons([[4, { pressed: true, value: 1 }]]));
    log = await readLog();
    assert(hasAddr(log, feStrAddr), 'letting go of RT releases the combo');
    assert(!hasAddr(log, rtTrig.engageAddress) && !hasAddr(log, rtTrig.analogAddress), 'no stomp release messages for a pull that never engaged');

    console.log('\n[pad] release LB -> plain LB release');
    await clearLog();
    await setPad(idleButtons());
    log = await readLog();
    assert(hasAddr(log, suckIt.address), 'LB release sends its plain release');

    console.log('\n[pad] RT alone -> the stomp, exactly as before');
    await clearLog();
    await setPad(withButtons([[7, { pressed: true, value: 1 }]]));
    log = await readLog();
    assert(hasAddr(log, rtTrig.engageAddress), 'RT alone engages the stomp');
    assert(!hasAddr(log, feStrAddr), 'RT alone does not fire the LB+RT combo');
    await setPad(idleButtons());

    function argOf(log, addr) {
      const m = [...log].reverse().find(x => x.address === addr);
      return m?.args?.[0]?.value;
    }
    // --- Tap Tempo on a pad button: the big Page 2 button is bindable -------
    const tapCfg = defaults.tempoButtons?.[0];
    assert(tapCfg && tapCfg.address === '/composition/tempocontroller/tempotap' && tapCfg.gamepadButton === -1,
      'defaults: tempoButtons[0] is Tap Tempo, unbound');
    console.log('\n[UI] edit mode: the big Tap Tempo button opens the editor, bind it to LS-click');
    await page.locator('#fx-grid .page-tab', { hasText: 'Page 2' }).click();
    await page.waitForTimeout(100);
    await page.click('#edit-toggle');
    await page.locator('#big-tap').dispatchEvent('pointerdown', { pointerId: 1 });
    await page.waitForSelector('#editor-overlay');
    const tempoHead = await page.locator('#editor-overlay .panel-head').textContent();
    assert(/TEMPO 1/.test(tempoHead), `editor opens on TEMPO 1 (got "${tempoHead}")`);
    await ctrlField.getByRole('button', { name: 'LS', exact: true }).click();
    await page.click('#ed-save');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });
    await page.click('#edit-toggle');
    const tapBadge = await page.locator('#big-tap .fx-pad').textContent();
    assert(tapBadge === 'LS', `Tap Tempo badge reads "LS" (got "${tapBadge}")`);

    console.log('\n[pad] LS-click -> tempotap 1, release -> tempotap 0');
    await setPad(idleButtons());
    await clearLog();
    await setPad(withButtons([[10, { pressed: true, value: 1 }]]));
    log = await readLog();
    assert(argOf(log, tapCfg.address) === 1, 'LS-click sends tempotap 1');
    await clearLog();
    await setPad(idleButtons());
    log = await readLog();
    assert(argOf(log, tapCfg.address) === 0, 'release sends tempotap 0');
    await page.locator('#fx-grid .page-tab', { hasText: 'Page 1' }).click();
    await page.waitForTimeout(100);

    // --- release fade: a ramped FX sweeps back instead of snapping ----------
    const acua = defaults.fxButtons2.find(b => b.label === 'ACUARELA');
    const acuaIdx = defaults.fxButtons2.indexOf(acua);
    assert(acua.mode === 'hold' && acua.ramp?.enabled && acua.ramp.releaseMs > 0 && acua.ramp.durationMs >= 1000,
      'defaults: ACUARELA is a hold ramp with a release fade');
    console.log('\n[touch] hold ACUARELA 600 ms, release -> fades to the release value, no snap');
    await page.locator('#fx-grid .page-tab', { hasText: 'Page 2' }).click();
    await page.waitForTimeout(100);
    const acuaBtn = page.locator(`.fx-btn[data-kind="fxButtons2"][data-index="${acuaIdx}"]`);
    await clearLog();
    await acuaBtn.dispatchEvent('pointerdown', { pointerId: 1 });
    await page.waitForTimeout(600);
    const heldLog = (await readLog()).filter(m => m.address === acua.address).map(m => m.args[0].value);
    assert(heldLog.length >= 5 && heldLog[heldLog.length - 1] > heldLog[0], 'the hold ramp is sweeping up');
    await clearLog();
    await acuaBtn.dispatchEvent('pointerup', { pointerId: 1 });
    await acuaBtn.dispatchEvent('pointercancel', { pointerId: 1 }); // a stray second release must not cut the fade
    await page.waitForTimeout(acua.ramp.releaseMs + 400);
    const fade = (await readLog()).filter(m => m.address === acua.address).map(m => m.args[0].value);
    const releaseValue = acua.releaseValue ?? acua.ramp.from;
    assert(fade.length >= 5, `the release is a sweep, not one message (got ${fade.length})`);
    assert(fade[0] > releaseValue + 0.05, `the first release message starts near the held value (got ${fade[0]})`);
    assert(fade.every((v, i) => i === 0 || v <= fade[i - 1] + 1e-9), 'the fade only goes down');
    assert(fade[fade.length - 1] === releaseValue, `and ends exactly at the release value ${releaseValue}`);
    await page.locator('#fx-grid .page-tab', { hasText: 'Page 1' }).click();
    await page.waitForTimeout(100);

    // --- ALL chip in the footer: one tap recalls every assigned colour --------
    const allT = defaults.colorTargets.items.find(t => t.id === 'all');
    assert(allT && allT.recall === true, 'defaults: ALL is a recall trigger');
    const covered = defaults.colorTargets.items.filter(t => t.id !== 'all' && t.colorBases.length && t.colorBases.every(b => allT.colorBases.includes(b)));
    assert(covered.map(t => t.id).join() === 'bg,logo,flash', `ALL covers bg, logo, flash (got ${covered.map(t => t.id)})`);
    const hex01 = hex => { const n = parseInt(hex.replace('#', ''), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
    console.log('\n[touch] tap ALL in the footer -> every covered target gets its ON steps and its own colour');
    await clearLog();
    await page.locator('#color-row .color-target-switch .target-pick[data-target="all"]').dispatchEvent('pointerdown', { pointerId: 1 });
    await page.waitForTimeout(80);
    log = await readLog();
    for (const t of covered) {
      const rgb = hex01(t.swatch); // nothing picked on these targets yet -> swatch colour
      for (const st of t.onSteps) assert(log.some(m => m.address === st.address && m.values?.[0] === st.values[0]), `${t.id}: ON step ${st.address}`);
      for (const b of t.colorBases) {
        assert(Math.abs(argOf(log, `${b}/red`) - rgb[0]) < 1e-6 && Math.abs(argOf(log, `${b}/green`) - rgb[1]) < 1e-6 && Math.abs(argOf(log, `${b}/blue`) - rgb[2]) < 1e-6,
          `${t.id}: its own colour lands on ${b}`);
      }
    }
    assert(!log.some(m => m.address.includes('colormorph')), 'MORPH is not touched by ALL');
    assert(await page.locator('#color-row .color-target-switch .target-pick.on').getAttribute('data-target') === 'all', 'ALL becomes the active target');
    await page.locator('#color-row .color-target-switch .target-pick[data-target="bg"]').dispatchEvent('pointerdown', { pointerId: 1 });
    await page.waitForTimeout(50);

    // --- HAZE toggle: address + extraAddress + extraAddresses all fire ------
    const haze = defaults.utilButtons.find(b => b.label === 'HAZE');
    const hazeIdx = defaults.utilButtons.indexOf(haze);
    const hazeAll = [haze.address, haze.extraAddress, ...(haze.extraAddresses ?? [])];
    assert(hazeAll.length === 3 && hazeAll.every(Boolean), 'defaults: HAZE reaches three addresses');
    console.log('\n[touch] HAZE toggle on -> all three logo hazes un-bypass');
    await clearLog();
    await page.locator(`.fx-btn[data-kind="utilButtons"][data-index="${hazeIdx}"]`).dispatchEvent('pointerdown', { pointerId: 1 });
    await page.waitForTimeout(50);
    log = await readLog();
    for (const a of hazeAll) assert(argOf(log, a) === haze.value, `HAZE on sends ${haze.value} to ${a}`);
    console.log('\n[touch] HAZE toggle off -> all three bypass again');
    await clearLog();
    await page.locator(`.fx-btn[data-kind="utilButtons"][data-index="${hazeIdx}"]`).dispatchEvent('pointerdown', { pointerId: 1 });
    await page.waitForTimeout(50);
    log = await readLog();
    for (const a of hazeAll) assert(argOf(log, a) === haze.offValue, `HAZE off sends ${haze.offValue} to ${a}`);

    // --- pad disconnect mid-hold: everything the pad was driving lets go ---
    // The Ally's pad vanishes from navigator.getGamepads() on an Armoury
    // Crate mode switch / firmware reconnect. A hold button, an engaged
    // trigger and a deflected stick must all release at that moment, not
    // stay latched until the pad happens to come back.
    const trig = defaults.triggers.rt;
    const stickX = defaults.sticks.ls.x;
    assert(trig.enabled && trig.engageAddress && trig.analogAddress, 'defaults: RT trigger enabled with engage + analog addresses');
    assert(defaults.sticks.ls.enabled && stickX.address, 'defaults: LS stick enabled with an X address');
    // RB (PIXELATE): a plain hold with no RT combo, so it still fires while
    // RT is engaged.
    const flashM2 = defaults.fxButtons.find(b => b.label === 'PIXELATE');
    const PIX = flashM2.gamepadButton;
    assert(PIX === 5 && flashM2.mode === 'hold' && flashM2.address !== trig.engageAddress,
      'defaults: PIXELATE is a hold binding on RB, separate from the RT engage clip');
    console.log('\n[pad] hold RB + engage RT + deflect LS, then the pad disconnects');
    await setPad(idleButtons());
    await clearLog();
    await page.evaluate(pix => {
      window.__gamepadOverride = {
        buttons: Array.from({ length: 16 }, (_, i) => (
          i === pix ? { pressed: true, value: 1 } : i === 7 ? { pressed: true, value: 0.6 } : { pressed: false, value: 0 })),
        axes: [0.5, 0, 0, 0],
      };
    }, PIX);
    await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
    await page.waitForTimeout(30);
    log = await readLog();
    assert(argOf(log, flashM2.address) === flashM2.value, 'RB held: press message sent');
    assert(argOf(log, trig.engageAddress) === trig.engageValue, 'RT engaged: engage message sent');
    assert(typeof argOf(log, stickX.address) === 'number' && argOf(log, stickX.address) !== stickX.center, 'LS deflected: axis message sent');

    await clearLog();
    await page.evaluate(() => { window.__gamepadOverride = null; }); // pad gone
    await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
    await page.waitForTimeout(30);
    log = await readLog();
    assert(argOf(log, flashM2.address) === flashM2.releaseValue, 'pad disconnect releases the held RB binding');
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

    // ---------------------------------------------------------------
    // Gamepad learn captures a combo with a digital modifier: hold LB, press
    // A. The first button is held back until a second one arrives (combo) or
    // it is released alone (plain binding).
    // ---------------------------------------------------------------
    console.log('\n[learn] hold LB + press A binds LB+A; press and release B binds B');
    await setPad(idleButtons());
    await page.click('#edit-toggle');
    await page.click('.fx-btn[data-kind="fxButtons"][data-index="0"]'); // GENERA, unbound
    await page.waitForSelector('#editor-overlay');
    // The gamepad learn button is the last .learn-btn in the form (the OSC
    // Learn comes first); its text changes while listening, so no text filter.
    const learnBtn = page.locator('#editor-overlay .learn-btn').last();
    assert(/gamepad learn/i.test(await learnBtn.textContent()), 'found the Gamepad learn button');
    await learnBtn.click();
    await setPad(withButtons([[4, { pressed: true, value: 1 }]]));                                   // LB down, held
    assert(await page.locator('#editor-overlay .learn-btn').last()
      .evaluate(el => el.classList.contains('listening')),
      'a single held button does not finish the learn (still listening)');
    await setPad(withButtons([[4, { pressed: true, value: 1 }], [0, { pressed: true, value: 1 }]])); // + A
    await page.waitForTimeout(100);
    const ctrlRow = page.locator('.field').filter({ has: page.locator('label', { hasText: /^Controller button$/ }) });
    const modRow = page.locator('.field').filter({ has: page.locator('label', { hasText: /^Modifier \(hold with\)$/ }) });
    assert(await ctrlRow.locator('button.on').textContent() === 'A', 'the second button is the control');
    assert(await modRow.locator('button.on').textContent() === 'LB', 'the held button is the modifier');
    await setPad(idleButtons());
    await page.click('#ed-save');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });
    assert(await page.locator('.fx-btn[data-kind="fxButtons"][data-index="0"] .fx-pad').textContent() === 'LB+A',
      'the badge shows LB+A');

    await page.click('.fx-btn[data-kind="fxButtons"][data-index="0"]');
    await page.waitForSelector('#editor-overlay');
    await page.locator('#editor-overlay .learn-btn').last().click();
    await setPad(withButtons([[1, { pressed: true, value: 1 }]]));   // B down
    await setPad(idleButtons());                                      // B up, alone
    await page.waitForTimeout(100);
    assert(await ctrlRow.locator('button.on').textContent() === 'B', 'a button pressed and released alone binds plainly');
    assert(await modRow.locator('button.on').textContent() === 'NONE', 'with no modifier');
    await page.click('#ed-save');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });
    assert(await page.locator('.fx-btn[data-kind="fxButtons"][data-index="0"] .fx-pad').textContent() === 'B',
      'the badge shows B');
    await page.click('#edit-toggle');

    // ---------------------------------------------------------------
    // Arming learn must not swallow the release of a hold FX that was
    // already down: the repeat chain has to stop when the finger lifts.
    // ---------------------------------------------------------------
    console.log('\n[learn] a hold engaged before arming still releases while learn listens');
    await setPad(idleButtons());
    await setPad(withButtons([[0, { pressed: true, value: 1 }]]));   // A down in live mode: PUSH WHT hold + repeat
    await page.waitForTimeout(60);
    await page.click('#edit-toggle');
    await page.click('.fx-btn[data-kind="fxButtons"][data-index="1"]'); // any editor
    await page.waitForSelector('#editor-overlay');
    await page.locator('#editor-overlay .learn-btn').last().click();    // arm learn, A still held
    await clearLog();
    await setPad(idleButtons());                                        // A released while learn listens
    await page.waitForTimeout(500);
    log = await readLog();
    const pushMsgs = log.filter(m => m.address === pushWhtAddr);
    assert(pushMsgs.some(m => m.args?.[0]?.value === pushWht.releaseValue),
      'the hold sent its release message');
    assert(!pushMsgs.length || pushMsgs.at(-1).args?.[0]?.value === pushWht.releaseValue,
      'and nothing kept firing after it');
    await page.locator('#editor-overlay .learn-btn').last().click();    // cancel learn
    await page.click('#ed-save');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });
    await page.click('#edit-toggle');

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
