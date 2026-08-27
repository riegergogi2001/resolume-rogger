// Browser-mode UI check for the v2 "complete remote" surface: tabbed
// Settings (Controller save, Pages visibility, Backup export/import),
// editor completeness (fader orientation, color-target editor, library
// search), and the inbound /rogger OSC API. Same standalone pattern as
// combos.spec.mjs — run by hand: `node test/ui/editor-settings.spec.mjs`
// (it spawns its own test/serve.js).
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5198;
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..', '..');

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

async function twoFrames(page) {
  await page.evaluate(() => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res))));
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

    const defaults = await page.evaluate(() => fetch('/__defaults').then(r => r.json()));
    const flashM = defaults.fxButtons[1];
    const master = defaults.faders[0];
    assert(flashM.label === 'FLASH M', `sanity: fxButtons[1] is FLASH M (got ${flashM.label})`);
    assert(master.address === '/composition/master', 'sanity: faders[0] is MASTER');

    // ---------------------------------------------------------------
    // Settings -> Controller: edit LT label, Save -> persisted config.
    // ---------------------------------------------------------------
    console.log('\n[settings] Controller tab: edit LT label, Save');
    await page.click('#settings-open');
    await page.waitForSelector('#settings-overlay');
    await page.getByRole('button', { name: 'Controller', exact: true }).click();
    const ltLabelInput = page.locator('#settings-overlay .field')
      .filter({ has: page.locator('label', { hasText: /^Label$/ }) })
      .first().locator('input');
    await ltLabelInput.fill('LT CUSTOM LABEL');
    await page.click('#set-ctrl-save');
    await page.waitForTimeout(500); // persist() debounce
    let saved = await page.evaluate(() => window.__savedConfig);
    assert(saved?.triggers?.lt?.label === 'LT CUSTOM LABEL',
      `Controller Save persisted the LT label (got ${saved?.triggers?.lt?.label})`);

    // screenshot the Controller tab before moving on
    const outDir = path.join(ROOT, 'test-artifacts');
    fs.mkdirSync(outDir, { recursive: true });
    await page.screenshot({ path: path.join(outDir, 'v2-settings.png') });
    console.log(`\n[screenshot] saved ${path.join(outDir, 'v2-settings.png')}`);

    // ---------------------------------------------------------------
    // Settings -> Pages: hide DJ Intro -> its tab disappears live.
    // ---------------------------------------------------------------
    console.log('\n[settings] Pages tab: hide DJ Intro');
    await page.getByRole('button', { name: 'Pages', exact: true }).click();
    assert((await page.locator('#fx-grid .page-tab', { hasText: 'DJ Intro' }).count()) === 1,
      'DJ Intro tab present before hiding');
    await page.locator('#settings-overlay .check-row', { hasText: 'Show DJ Intro' }).locator('.toggle').click();
    assert((await page.locator('#fx-grid .page-tab', { hasText: 'DJ Intro' }).count()) === 0,
      'DJ Intro tab disappeared after hiding it');
    // put it back so later steps (none currently need it) aren't surprised
    await page.locator('#settings-overlay .check-row', { hasText: 'Show DJ Intro' }).locator('.toggle').click();

    // ---------------------------------------------------------------
    // Settings -> Backup: Export sets __exportedConfig.
    // ---------------------------------------------------------------
    console.log('\n[settings] Backup tab: Export');
    await page.getByRole('button', { name: 'Backup', exact: true }).click();
    await page.click('#set-export');
    const exported = await page.evaluate(() => window.__exportedConfig);
    assert(typeof exported === 'string' && exported.includes('fxButtons'),
      'Export produced a JSON string containing "fxButtons"');

    // ---------------------------------------------------------------
    // Settings -> Backup: Import merges a JSON string onto current config.
    // ---------------------------------------------------------------
    console.log('\n[settings] Backup tab: Import changes fxButtons[0].label');
    const importJson = JSON.stringify({ fxButtons: [{ label: 'REMOTE LABEL' }] });
    await page.evaluate(json => { window.__importJson = json; }, importJson);
    await page.click('#set-import');
    await page.waitForTimeout(50);
    await page.click('#set-close');
    const btn0Label = await page.locator('.fx-btn[data-kind="fxButtons"][data-index="0"] .fx-label').textContent();
    assert(btn0Label === 'REMOTE LABEL', `imported fxButtons[0].label re-rendered on the button (got "${btn0Label}")`);

    // ---------------------------------------------------------------
    // Edit mode: fader editor shows the orientation seg.
    // ---------------------------------------------------------------
    console.log('\n[edit] fader editor shows orientation seg');
    await page.click('#edit-toggle');
    await page.click('#fader-rack .fader[data-index="0"] .fader-track');
    await page.waitForSelector('#editor-overlay');
    const orientField = page.locator('#editor-overlay .field')
      .filter({ has: page.locator('label', { hasText: /^Orientation$/ }) });
    assert(await orientField.count() === 1, 'fader editor has an Orientation field');
    assert(await orientField.locator('.seg button').count() === 2, 'Orientation seg has V/H buttons');
    await page.click('#ed-cancel');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });

    // ---------------------------------------------------------------
    // Edit mode: tap a color target square -> COLOR TARGET editor opens.
    // ---------------------------------------------------------------
    console.log('\n[edit] color target square opens the COLOR TARGET editor');
    // Colors page owns its own chips too, but the always-visible color row
    // at the bottom of the screen is simplest to reach without page-switching.
    await page.click('#color-row .color-target-switch .target-pick >> nth=0');
    await page.waitForSelector('#editor-overlay');
    const head = await page.locator('#editor-overlay .panel-head').textContent();
    assert(head.includes('COLOR TARGET'), `editor header reads COLOR TARGET (got "${head}")`);
    await page.click('#ed-cancel');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });

    // ---------------------------------------------------------------
    // Library search narrows results.
    // ---------------------------------------------------------------
    console.log('\n[edit] library search "tempo tap" narrows to the tempotap entry');
    await page.click('.fx-btn[data-kind="fxButtons"][data-index="2"]'); // any fx button
    await page.waitForSelector('#editor-overlay');
    await page.locator('#editor-overlay .field').filter({ has: page.locator('label', { hasText: /^OSC address$/ }) })
      .locator('button', { hasText: 'Library' }).click();
    await page.fill('#editor-overlay .field input[type="text"]', 'tempo tap');
    const entries = page.locator('#editor-overlay .lib-entry');
    assert(await entries.count() === 1, `search narrows to exactly one entry (got ${await entries.count()})`);
    assert((await entries.first().textContent()).includes('Tempo tap'), 'the one entry is Tempo tap');
    await page.click('#ed-cancel');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });
    await page.click('#edit-toggle'); // leave edit mode

    // ---------------------------------------------------------------
    // Inbound /rogger OSC API.
    // ---------------------------------------------------------------
    console.log('\n[remote] /rogger/fx/1/2 presses then releases FLASH M');
    async function clearLog() { await page.evaluate(() => { window.__oscLog.length = 0; }); }
    async function readLog() { return page.evaluate(() => window.__oscLog); }
    function has(log, address, value) {
      return log.some(m => m.address === address && m.args?.[0]?.value === value);
    }

    await clearLog();
    await page.evaluate(() => window.__emitOscIn({ address: '/rogger/fx/1/2', args: [{ type: 'i', value: 1 }] }));
    await page.waitForTimeout(30);
    let log = await readLog();
    assert(has(log, flashM.address, 1), `/rogger/fx/1/2 value 1 fires ${flashM.address} with value 1`);

    await page.evaluate(() => window.__emitOscIn({ address: '/rogger/fx/1/2', args: [{ type: 'i', value: 0 }] }));
    await page.waitForTimeout(30);
    log = await readLog();
    assert(has(log, flashM.address, 0), `/rogger/fx/1/2 value 0 releases ${flashM.address} with value 0`);

    console.log('\n[remote] /rogger/page switches the active page tab');
    await page.evaluate(() => window.__emitOscIn({ address: '/rogger/page', args: [{ type: 'i', value: 2 }] }));
    await page.waitForTimeout(30);
    const page2On = await page.locator('#fx-grid .page-tab', { hasText: 'Page 2' }).evaluate(el => el.classList.contains('on'));
    assert(page2On, '/rogger/page 2 switches to Page 2 (tab .on)');

    console.log('\n[remote] /rogger/page past the last tab is ignored');
    const tabCount = await page.locator('#fx-grid .page-tab').count();
    const pageBefore = await page.evaluate(() => document.body.dataset.page);
    const activeBefore = await page.locator('.fx-page.active').count();
    await page.evaluate(n => window.__emitOscIn({ address: '/rogger/page', args: [{ type: 'i', value: n }] }), tabCount + 1);
    await page.waitForTimeout(30);
    assert(await page.evaluate(() => document.body.dataset.page) === pageBefore,
      `/rogger/page ${tabCount + 1} (beyond ${tabCount} tabs) leaves body.dataset.page at ${pageBefore}`);
    assert(await page.locator('.fx-page.active').count() === activeBefore,
      `/rogger/page ${tabCount + 1} leaves the .fx-page.active count at ${activeBefore}`);

    console.log('\n[remote] /rogger/fader/1 sets the MASTER fader value');
    await clearLog();
    await page.evaluate(() => window.__emitOscIn({ address: '/rogger/fader/1', args: [{ type: 'f', value: 0.5 }] }));
    await twoFrames(page);
    await page.waitForTimeout(30);
    log = await readLog();
    assert(has(log, master.address, 0.5), `/rogger/fader/1 0.5 sends ${master.address} 0.5`);

    // ---------------------------------------------------------------
    // Settings -> Network: the link test reports three legs separately.
    // ---------------------------------------------------------------
    console.log('\n[settings] Network tab: three-leg link diagnostic');
    await page.evaluate(() => document.querySelector('#settings-overlay')?.remove());
    await page.click('#settings-open');
    await page.waitForSelector('#settings-overlay');
    await page.getByRole('button', { name: 'Network', exact: true }).click();
    await page.click('#set-test');
    await page.waitForSelector('#set-test-result .link-leg', { timeout: 5000 });
    const legs = await page.locator('#set-test-result .link-leg').count();
    assert(legs === 3, `the link test reports all three legs separately (got ${legs})`);
    const failing = await page.locator('#set-test-result .link-leg.fail').count();
    assert(failing === 1, `a failing leg is marked as such (got ${failing})`);
    const fixText = await page.locator('#set-test-result .link-leg.fail .link-leg-fix').innerText();
    assert(/Preferences/i.test(fixText) && /:7001/.test(fixText),
      'the failing leg says exactly what to change and where to point it');
    const okLegs = await page.locator('#set-test-result .link-leg.ok').count();
    assert(okLegs === 2, 'the legs that work are still reported as working');
    // The whole thing must fit the panel — this is the surface, not a console.
    const overflow = await page.locator('#set-test-result').evaluate(el => el.scrollWidth - el.clientWidth);
    assert(overflow <= 1, `the diagnostic fits its panel (overflows by ${overflow}px)`);

    // ---------------------------------------------------------------
    // Colour presets light from what was sent, per target. Resolume never
    // echoes a colour back, so this is the only feedback there can be.
    // ---------------------------------------------------------------
    console.log('\n[colours] preset highlight follows the active target');
    await page.evaluate(() => document.querySelector('#settings-overlay')?.remove());
    const selected = () => page.locator('#color-row .color-btn.selected');
    const selectedLabel = async () => (await selected().locator('.color-label').allInnerTexts()).join(',');
    assert(await selected().count() === 0, 'nothing is highlighted before anything is sent');

    const targets = page.locator('#color-row .target-pick');
    await targets.nth(0).click();                       // BG
    await page.locator('#color-row .color-btn').nth(0).click();   // RED
    await page.waitForTimeout(150);
    assert(await selectedLabel() === 'RED', 'the preset just pressed lights up');

    await targets.nth(1).click();                       // LOGO — nothing sent there
    await page.waitForTimeout(150);
    assert(await selected().count() === 0, 'switching to an untouched target clears the highlight');

    await page.locator('#color-row .color-btn').nth(4).click();   // CYAN on LOGO
    await page.waitForTimeout(150);
    assert(await selectedLabel() === 'CYAN', 'the new target gets its own highlight');

    await targets.nth(0).click();                       // back to BG
    await page.waitForTimeout(150);
    assert(await selectedLabel() === 'RED', 'each target remembers its own colour');

    await page.locator('#color-row .color-btn').nth(9).click();   // OFF
    await page.waitForTimeout(150);
    assert(await selected().count() === 0, 'OFF clears the highlight');

    // ---------------------------------------------------------------
    // The picker is not limited to the targets it ships with.
    // ---------------------------------------------------------------
    console.log('\n[colours] targets can be added and removed');
    await page.locator('#fx-grid .page-tab').nth(3).click();       // COLORS
    await page.waitForTimeout(250);
    const addChip = page.locator('#lab-add-target');
    assert(!await addChip.isVisible(), '+ TARGET stays out of the way outside edit mode');
    await page.click('#edit-toggle');
    await page.waitForTimeout(200);
    assert(await addChip.isVisible(), '+ TARGET appears in edit mode');

    const chipsBefore = await page.locator('.lab-chips .target-pick').count();
    const targetsBefore = await page.locator('.lab-chips .target-pick[data-target]').count(); // real targets, not OFF / + TARGET
    await addChip.click();
    await page.waitForSelector('.overlay');
    await page.waitForTimeout(250);
    assert(new RegExp(`COLOR TARGET ${targetsBefore + 1}`).test(await page.locator('.overlay .panel-head').innerText()),
      'adding one opens its editor straight away');
    assert(await page.locator('#set-target-delete').count() === 1, 'and it can be deleted again');
    await page.click('#set-target-delete');
    await page.waitForTimeout(350);
    assert(await page.locator('.lab-chips .target-pick').count() === chipsBefore,
      'delete puts the row back where it was');
    await page.click('#edit-toggle');
    await page.waitForTimeout(150);

    // ---------------------------------------------------------------
    // Each colour target is on the page exactly once. The ColorMorph strip
    // used to repeat MORPH 1 / MORPH 2 as "Color 1" / "Color 3" wells.
    // ---------------------------------------------------------------
    console.log('\n[colours] every target appears once; the morph strip is speed + on/off only');
    // Back to COLORS: the delete above re-rendered the surface.
    await page.locator('#fx-grid .page-tab').nth(3).click();
    await page.waitForTimeout(250);
    const targetIds = defaults.colorTargets.items.map(t => t.id);
    const chipIds = await page.locator('.lab-chips .target-pick[data-target]').evaluateAll(
      els => els.map(e => e.dataset.target));
    assert(JSON.stringify([...chipIds].sort()) === JSON.stringify([...targetIds].sort()),
      `chip row lists each configured target once (${chipIds.join(', ')})`);
    // ALL leads both chip rows: it is the one chip that gets hit blind
    // mid-show, so it is first and widest. Config order is untouched.
    assert(chipIds[0] === 'all', `ALL is the first chip (${chipIds.join(', ')})`);
    assert(await page.locator('.morph-well').count() === 0, 'no duplicate morph wells');
    // The footer target switch exists on every page but is hidden on COLORS
    // (the lab has its own chip row), so count what is actually on screen.
    assert(await page.locator('[data-target="morph1"]:visible').count() === 1 &&
      await page.locator('[data-target="morph2"]:visible').count() === 1,
      'the morph colours are reachable through exactly one visible control each');
    assert(await page.locator('.lab-morph').isVisible(), 'the morph strip is shown while the config has a ColorMorph');
    assert(await page.locator('.lab-morph .speed-track').count() === 1 &&
      await page.locator('.lab-morph .morph-toggle').count() === 1,
      'the strip carries the speed slider and the on/off toggle');
    const stripBox = await page.locator('.lab-morph').boundingBox();
    const labBox = await page.locator('.color-lab').boundingBox();
    assert(stripBox && labBox && stripBox.x + stripBox.width <= labBox.x + labBox.width + 1,
      'the strip fits inside the lab');

    // ---------------------------------------------------------------
    // A busy listen port must be visible for the whole show, not for the
    // 2.6 s of a toast: commands still land, feedback does not.
    // ---------------------------------------------------------------
    console.log('\n[topbar] a busy listen port stays announced on the surface');
    const warn = page.locator('#listen-warn');
    assert(!await warn.isVisible(), 'no warning while the configured port is bound');
    await page.evaluate(() => window.__emitListen({ port: 54321, configured: 7001, fallback: true }));
    await page.waitForTimeout(60);
    assert(await warn.isVisible() && /7001/.test(await warn.textContent()),
      `the badge names the busy port (${await warn.textContent()})`);
    // Measured at the window floor (src/window-size.js), the smallest surface
    // the app allows; this spec's default viewport is narrower than that.
    const before = page.viewportSize();
    await page.setViewportSize({ width: 1704, height: 1035 });
    await page.waitForTimeout(60);
    const topbarFits = await page.evaluate(() => {
      const t = document.getElementById('topbar');
      const r = t.getBoundingClientRect();
      const last = t.lastElementChild.getBoundingClientRect();
      return t.scrollWidth <= t.clientWidth + 1 && last.right <= r.right + 1;
    });
    assert(topbarFits, 'the topbar still fits at the window floor with the badge shown');
    await page.setViewportSize(before);
    await page.evaluate(() => window.__emitListen({ port: 7001, configured: 7001, fallback: false }));
    await page.waitForTimeout(60);
    assert(!await warn.isVisible(), 'and it clears once the port is bound again');

    // ---------------------------------------------------------------
    // A rebuild of the surface keeps the operator where they were. The whole
    // surface is re-rendered after a fader orientation edit, a colour target
    // edit/add/delete, a hidden page and an import; that must not drop them
    // back on Page 1, leave edit mode, or show a latched toggle as off while
    // the effect it switched on is still running.
    // ---------------------------------------------------------------
    console.log('\n[rerender] page, edit mode and latched toggles survive a rebuild');
    const pageNow = () => page.evaluate(() => document.body.dataset.page);
    const latchedUtil = () => page.locator('#util-strip .fx-btn[data-index="1"]').evaluate(el => el.classList.contains('latched'));
    const util1 = defaults.utilButtons[1];
    await page.click('#util-strip .fx-btn[data-index="1"]');
    await page.waitForTimeout(50);
    assert(await latchedUtil(), `utility toggle "${util1.label}" latches on a tap`);
    await page.locator('#fx-grid .page-tab').nth(1).click(); // Page 2
    await page.waitForTimeout(150);
    await page.click('#edit-toggle');
    await page.waitForTimeout(100);
    const orientationSeg = () => page.locator('#editor-overlay .field')
      .filter({ has: page.locator('label', { hasText: /^Orientation$/ }) }).locator('.seg button');
    async function flipGroupFader(to) {
      await page.click('.fx-page.active .page-fader-zone .fader[data-index="0"] .fader-track');
      await page.waitForSelector('#editor-overlay');
      await orientationSeg().filter({ hasText: to }).click();
      await page.click('#ed-save');
      await page.waitForSelector('#editor-overlay', { state: 'detached' });
      await page.waitForTimeout(150);
    }
    await flipGroupFader('V');
    assert(await pageNow() === 'page-2', `saving a group fader on Page 2 keeps Page 2 up (got "${await pageNow()}")`);
    assert(await page.evaluate(() => document.body.classList.contains('edit-mode')), 'edit mode is still on after the rebuild');
    assert(await page.locator('#edit-toggle').evaluate(el => el.classList.contains('latched')), 'and the EDIT button still shows it');
    assert(await latchedUtil(), `"${util1.label}" is still shown on after the rebuild`);
    await flipGroupFader('H'); // put it back
    await page.click('#edit-toggle');
    await page.waitForTimeout(100);
    await clearLog();
    await page.click('#util-strip .fx-btn[data-index="1"]');
    await page.waitForTimeout(50);
    log = await readLog();
    assert(has(log, util1.address, util1.offValue) && !has(log, util1.address, util1.value),
      'tapping the still-on toggle sends its OFF value, not ON again');

    console.log('\n[rerender] hiding another page keeps the current one up');
    await page.evaluate(() => document.querySelector('#settings-overlay')?.remove());
    await page.click('#settings-open');
    await page.waitForSelector('#settings-overlay');
    await page.getByRole('button', { name: 'Pages', exact: true }).click();
    const bpmToggle = page.locator('#settings-overlay .check-row', { hasText: 'Show BPM' }).locator('.toggle');
    await bpmToggle.click();
    await page.waitForTimeout(100);
    assert(await pageNow() === 'page-2', `hiding BPM while on Page 2 keeps Page 2 up (got "${await pageNow()}")`);
    await bpmToggle.click();
    await page.waitForTimeout(100);
    assert(await pageNow() === 'page-2' && await page.locator('#fx-grid .page-tab', { hasText: 'BPM' }).count() === 1,
      'showing it again brings the tab back without moving');

    // ---------------------------------------------------------------
    // Destructive buttons ask first. Reload sits next to Import and Exit next
    // to Close; one mis-tap used to wipe every edit or take the show down.
    // ---------------------------------------------------------------
    console.log('\n[settings] destructive buttons ask first (in-page, never a native dialog), and there are no dead toggles');
    page.on('dialog', d => { throw new Error(`native dialog opened: ${d.message()}`); });
    await page.getByRole('button', { name: 'Backup', exact: true }).click();
    const labelBeforeReset = await page.locator('.fx-btn[data-kind="fxButtons"][data-index="0"] .fx-label').textContent();
    await page.click('#set-reset');
    await page.waitForSelector('#confirm-overlay');
    assert(/default/i.test(await page.locator('#confirm-overlay .confirm-text').textContent()), 'Reload default mapping asks for confirmation');
    await page.click('#confirm-cancel');
    await page.waitForSelector('#confirm-overlay', { state: 'detached' });
    assert(await page.locator('.fx-btn[data-kind="fxButtons"][data-index="0"] .fx-label').textContent() === labelBeforeReset,
      'declining leaves the surface as it was');
    await page.click('#set-exit');
    await page.waitForSelector('#confirm-overlay');
    assert(/exit/i.test(await page.locator('#confirm-overlay .confirm-text').textContent()), 'Exit app asks for confirmation');
    await page.click('#confirm-cancel');
    await page.waitForSelector('#confirm-overlay', { state: 'detached' });
    assert(!(await page.evaluate(() => window.__quitCalled)), 'declining does not quit');

    console.log('\n[settings] confirming Exit writes the config and quits — even when the save hangs');
    await page.evaluate(() => { window.__savedConfig = null; window.__quitCalled = false; });
    await page.click('#set-exit');
    await page.waitForSelector('#confirm-overlay');
    await page.click('#confirm-ok');
    await page.waitForFunction(() => window.__quitCalled === true, null, { timeout: 3000 });
    assert(await page.evaluate(() => window.__savedConfig !== null), 'the last edits are written before quitting');
    await page.evaluate(() => { window.__quitCalled = false; window.__saveHang = true; });
    await page.click('#set-exit');
    await page.waitForSelector('#confirm-overlay');
    const t0 = Date.now();
    await page.click('#confirm-ok');
    await page.waitForFunction(() => window.__quitCalled === true, null, { timeout: 4000 });
    const waited = Date.now() - t0;
    assert(waited >= 1000 && waited < 3500, `a hanging save is given ~1.5 s, then the app quits anyway (took ${waited} ms)`);
    await page.evaluate(() => { window.__quitCalled = false; window.__saveHang = false; });
    page.removeAllListeners('dialog');
    await page.getByRole('button', { name: 'Network', exact: true }).click();
    assert(await page.locator('#settings-overlay .check-row', { hasText: 'Dark theme' }).count() === 0,
      'no Dark theme toggle (nothing reads it — it flipped and did nothing)');
    await page.click('#set-close');
    await page.waitForSelector('#settings-overlay', { state: 'detached' });

    // ---------------------------------------------------------------
    // Colour target edits reach every chip row. The chips only track which
    // target is active, so a saved label or a new target needs a rebuild.
    // ---------------------------------------------------------------
    console.log('\n[edit] colour target edits show up on every chip row, without leaving the page');
    await page.click('#edit-toggle');
    await page.waitForTimeout(100);
    await page.click('#color-row .target-pick >> nth=1');
    await page.waitForSelector('#editor-overlay');
    await page.locator('#editor-overlay .field').filter({ has: page.locator('label', { hasText: /^Label$/ }) })
      .first().locator('input').fill('LOGO X');
    await page.click('#ed-save');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });
    await page.waitForTimeout(150);
    assert(await page.locator('#color-row .target-pick').nth(1).textContent() === 'LOGO X',
      'the footer chip shows the saved label');
    assert(await page.locator('.lab-chips .target-pick[data-target]').nth(1).textContent() === 'LOGO X',
      'the COLORS page chip shows the saved label');
    await page.locator('#fx-grid .page-tab').nth(3).click(); // COLORS
    await page.waitForTimeout(150);
    await page.click('#lab-add-target');
    await page.waitForSelector('#editor-overlay');
    await page.click('#ed-save');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });
    await page.waitForTimeout(150);
    assert(await pageNow() === 'colors', `saving a new target keeps COLORS up (got "${await pageNow()}")`);
    const labCount = await page.locator('.lab-chips .target-pick[data-target]').count();
    const footerCount = await page.locator('#color-row .target-pick').count();
    assert(footerCount === labCount, `the footer switch carries the new target too (${footerCount} of ${labCount})`);
    await page.locator('.lab-chips .target-pick[data-target]').last().click();
    await page.waitForSelector('#editor-overlay');
    await page.click('#set-target-delete');
    await page.waitForTimeout(300);
    assert(await pageNow() === 'colors', `deleting a target keeps COLORS up (got "${await pageNow()}")`);
    assert(await page.evaluate(() => document.body.classList.contains('edit-mode')), 'and edit mode stays on');
    assert(await page.locator('#color-row .target-pick').count() === labCount - 1, 'the footer switch shrank with it');

    // ---------------------------------------------------------------
    // Every button in a panel is finger-sized. A big-btn dropped straight into
    // the column-flex panel body used to collapse to its 20px text line.
    // ---------------------------------------------------------------
    console.log('\n[edit] buttons placed straight into a panel body keep their height');
    await page.locator('#fx-grid .page-tab').nth(0).click();
    await page.waitForTimeout(150);
    await page.click('.fx-btn[data-kind="fxButtons"][data-index="0"]');
    await page.waitForSelector('#editor-overlay');
    const learnBox = await page.locator('#editor-overlay .learn-btn', { hasText: /gamepad learn/i }).boundingBox();
    assert(learnBox && learnBox.height >= 44, `Gamepad learn is finger-sized (${Math.round(learnBox?.height ?? 0)}px tall)`);
    await page.locator('#editor-overlay .field').filter({ has: page.locator('label', { hasText: /^OSC address$/ }) })
      .locator('button', { hasText: 'Library' }).click();
    const backBox = await page.locator('#editor-overlay .big-btn', { hasText: 'Back' }).boundingBox();
    assert(backBox && backBox.height >= 44, `the library's Back is finger-sized (${Math.round(backBox?.height ?? 0)}px tall)`);
    await page.click('#ed-cancel');
    await page.waitForSelector('#editor-overlay', { state: 'detached' });
    await page.click('#edit-toggle');

    // ---------------------------------------------------------------
    // Touch: a finger that lands on a control and scrolls the panel must not
    // press it. The surface reacts on pointerdown for latency (nothing scrolls
    // there); inside a scrolling panel that fired before the browser knew it
    // was a scroll, flipping toggles and picking library entries.
    // ---------------------------------------------------------------
    console.log('\n[touch] a scroll gesture does not press the control it started on');
    const touch = await browser.newPage({ hasTouch: true, viewport: { width: 1920, height: 1080 } });
    await touch.goto(URL);
    await touch.waitForFunction(() => document.body.dataset.ready === '1');
    const cdp = await touch.context().newCDPSession(touch);
    async function swipeUp(locator) {
      const b = await locator.boundingBox();
      await cdp.send('Input.synthesizeScrollGesture', {
        x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2),
        yDistance: -400, gestureSourceType: 'touch', speed: 1200,
      });
      await touch.waitForTimeout(300);
    }
    await touch.tap('#settings-open');
    await touch.waitForSelector('#settings-overlay');
    await touch.getByRole('button', { name: 'Controller', exact: true }).tap();
    const firstToggle = touch.locator('#settings-overlay .check-row .toggle').first();
    const wasOn = await firstToggle.evaluate(el => el.classList.contains('on'));
    await swipeUp(firstToggle);
    const scrolledBy = await touch.evaluate(() => document.querySelector('#settings-overlay .panel-body').scrollTop);
    assert(scrolledBy > 0, `the panel scrolled under the finger (${scrolledBy}px)`);
    assert(await firstToggle.evaluate(el => el.classList.contains('on')) === wasOn,
      'the toggle the finger landed on did not flip');
    await touch.evaluate(() => { document.querySelector('#settings-overlay .panel-body').scrollTop = 0; });
    await firstToggle.tap();
    assert(await firstToggle.evaluate(el => el.classList.contains('on')) === !wasOn, 'a plain tap still flips it');
    await touch.tap('#set-close');
    await touch.waitForSelector('#settings-overlay', { state: 'detached' });
    await touch.tap('#edit-toggle');
    await touch.locator('.fx-btn[data-kind="fxButtons"][data-index="2"]').tap();
    await touch.waitForSelector('#editor-overlay');
    await touch.locator('#editor-overlay .field').filter({ has: touch.locator('label', { hasText: /^OSC address$/ }) })
      .locator('button', { hasText: 'Library' }).tap();
    await touch.waitForSelector('#editor-overlay .lib-entry');
    // The Library button sits far down the FX form, so the body arrives here
    // scrolled; the library must open at its top, not at whatever entry
    // happens to be 700px down, with the search field and Back out of sight.
    const searchBox = await touch.locator('#editor-overlay .field input[type="text"]').boundingBox();
    const bodyBox = await touch.locator('#editor-overlay .panel-body').boundingBox();
    assert(searchBox && searchBox.y >= bodyBox.y && searchBox.y + searchBox.height <= bodyBox.y + bodyBox.height,
      'the library opens with its search field in view');
    const entriesBefore = await touch.locator('#editor-overlay .lib-entry').count();
    await swipeUp(touch.locator('#editor-overlay .lib-entry').first());
    assert(await touch.locator('#editor-overlay .lib-entry').count() === entriesBefore,
      'scrolling the library did not pick the entry under the finger');
    await touch.fill('#editor-overlay .field input[type="text"]', 'tempo tap');
    await touch.locator('#editor-overlay .lib-entry').first().tap();
    await touch.waitForSelector('#ed-address');
    assert(await touch.locator('#ed-address').inputValue() === '/composition/tempocontroller/tempotap',
      'a plain tap on an entry still picks it');
    const longPressRefused = await touch.evaluate(() => {
      const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
      document.querySelector('.fx-btn').dispatchEvent(ev);
      return ev.defaultPrevented;
    });
    assert(longPressRefused, 'a long-press context menu is refused (it would cancel a held button)');
    await touch.close();

    await browser.close();
    console.log('\nALL EDITOR/SETTINGS/REMOTE-API UI CHECKS PASSED');
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('\nEDITOR/SETTINGS UI CHECK FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
}

main();
