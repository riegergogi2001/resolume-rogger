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
    await addChip.click();
    await page.waitForSelector('.overlay');
    await page.waitForTimeout(250);
    assert(/COLOR TARGET 6/.test(await page.locator('.overlay .panel-head').innerText()),
      'adding one opens its editor straight away');
    assert(await page.locator('#set-target-delete').count() === 1, 'and it can be deleted again');
    await page.click('#set-target-delete');
    await page.waitForTimeout(350);
    assert(await page.locator('.lab-chips .target-pick').count() === chipsBefore,
      'delete puts the row back where it was');
    await page.click('#edit-toggle');
    await page.waitForTimeout(150);

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
