// Browser-mode UI check for Settings -> Updates: the version block, a check
// that finds nothing, a check that offers a download, the download + restart
// path, the "needs a new exe" path, and the stage-safe LIVE restart guard.
// Standalone, like the other specs: `node test/ui/updates.spec.mjs`
// (it spawns its own test/serve.js).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5197;
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

/** Reopen Settings on the Updates tab with a given mocked updater state. */
async function openUpdates(page, { info, result }) {
  await page.evaluate(([i, r]) => {
    window.__updateInfo = i;
    window.__updateResult = r;
    document.querySelector('#settings-overlay')?.remove();
  }, [info, result]);
  await page.click('#settings-open');
  await page.waitForSelector('#settings-overlay');
  await page.getByRole('button', { name: 'Updates', exact: true }).click();
  await page.waitForSelector('#upd-check');
}

const status = page => page.locator('#settings-overlay .test-result').last().innerText();

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
    page.on('pageerror', err => console.log('[page error]', err.message));
    // The restart guard uses confirm(); accept unless a test says otherwise.
    page.on('dialog', d => d.accept());

    await page.goto(URL);
    await page.waitForFunction(() => document.body.dataset.ready === '1');

    const OTA = { supported: true, source: 'ota', payloadVersion: '2.1.0', shellVersion: '2.1.0',
      autoCheck: true, installed: [], quarantined: [], lastCheck: 0, staged: null };

    // ---------------------------------------------------------------
    console.log('\n[updates] the tab exists and shows what is running');
    await openUpdates(page, { info: OTA, result: { status: 'up-to-date' } });
    const body = await page.locator('#settings-overlay .panel-body').innerText();
    assert(/running version/i.test(body), 'the running version is shown');
    assert(/2\.1\.0/.test(body) && /OTA/.test(body), 'version and source badge are rendered');
    assert(/check for updates on launch/i.test(body), 'the auto-check toggle is present');

    // ---------------------------------------------------------------
    console.log('\n[updates] Check now with nothing new reports up to date');
    await page.click('#upd-check');
    await page.waitForFunction(() => /Up to date/.test(document.body.innerText));
    assert(/Up to date/.test(await status(page)), 'an up-to-date check says so');
    assert(await page.locator('#upd-download').count() === 0, 'nothing is offered to download');

    // ---------------------------------------------------------------
    console.log('\n[updates] an available release offers a download with its notes');
    await openUpdates(page, {
      info: OTA,
      result: { status: 'available', version: '2.2.0', size: 81920, notes: '### 2.2.0\n- faster fader redraw' },
    });
    await page.click('#upd-check');
    await page.waitForSelector('#upd-download');
    const offer = await page.locator('#settings-overlay .panel-body').innerText();
    assert(/2\.2\.0 is available/.test(offer), 'the new version is announced');
    assert(/faster fader redraw/.test(offer), 'release notes are shown');
    assert(/80 KB/.test(await page.locator('#upd-download').innerText()), 'the download size is on the button');

    // ---------------------------------------------------------------
    console.log('\n[updates] downloading installs it and offers a restart');
    await page.click('#upd-download');
    await page.waitForSelector('#upd-restart');
    assert(await page.evaluate(() => window.__updateDownloaded === true), 'the download went through the bridge');
    assert(/starts on the next launch/.test(await status(page)), 'the install is reported as pending a restart');
    await page.click('#upd-restart');
    await page.waitForFunction(() => window.__relaunchCalled === true);
    assert(true, 'Restart triggers the relaunch bridge call');

    // ---------------------------------------------------------------
    console.log('\n[updates] a staged version is offered on reopen, without re-checking');
    await page.evaluate(() => { window.__updateChecked = 0; });
    await openUpdates(page, {
      info: { ...OTA, staged: '2.2.0', installed: ['2.2.0'] },
      result: { status: 'up-to-date' },
    });
    await page.waitForSelector('#upd-restart');
    assert(await page.evaluate(() => window.__updateChecked === 0),
      'an already-installed update needs no network call to be offered');
    assert(await page.locator('#upd-reset').count() === 1, 'the back-to-bundled escape hatch is offered');

    // ---------------------------------------------------------------
    console.log('\n[updates] removing downloads falls back to the bundled version');
    await page.click('#upd-reset');
    await page.waitForFunction(() => window.__updateReset === true);
    assert(/bundled version starts on the next launch/.test(await status(page)), 'the reset is confirmed');

    // ---------------------------------------------------------------
    console.log('\n[updates] a release needing a new exe links out instead of installing');
    await openUpdates(page, {
      info: OTA,
      result: { status: 'shell-required', version: '3.0.0', minShell: '3.0.0',
        message: 'Version 3.0.0 needs the ROGGER 3.0.0 exe or newer.',
        htmlUrl: 'https://github.com/riegergogi2001/resolume-rogger/releases/tag/v3.0.0' },
    });
    await page.click('#upd-check');
    await page.waitForSelector('#upd-releases');
    assert(await page.locator('#upd-download').count() === 0, 'no over-the-air install is offered');
    await page.click('#upd-releases');
    await page.waitForFunction(() => typeof window.__releasesOpened === 'string');
    assert(/releases\/tag\/v3\.0\.0$/.test(await page.evaluate(() => window.__releasesOpened)),
      'the releases page for that version is opened');

    // ---------------------------------------------------------------
    console.log('\n[updates] a failed download reports the reason and re-arms the button');
    await openUpdates(page, {
      info: OTA,
      result: { status: 'available', version: '2.2.0', size: 4096, notes: '' },
    });
    await page.evaluate(() => {
      window.__updateDownloadResult = { ok: false, message: 'checksum mismatch — the download does not match the manifest' };
    });
    await page.click('#upd-check');
    await page.waitForSelector('#upd-download');
    await page.click('#upd-download');
    await page.waitForFunction(() => /checksum mismatch/.test(document.body.innerText));
    assert(/checksum mismatch/.test(await status(page)), 'the failure reason is shown verbatim');
    assert(await page.locator('#upd-download').isEnabled(), 'the operator can retry');
    assert(await page.locator('#upd-restart').count() === 0, 'a failed download offers no restart');
    await page.evaluate(() => { delete window.__updateDownloadResult; });

    // ---------------------------------------------------------------
    console.log('\n[updates] a rolled-back payload is reported on the tab');
    await openUpdates(page, {
      info: { ...OTA, source: 'bundled', quarantined: ['2.2.0'] },
      result: { status: 'up-to-date' },
    });
    assert(/2\.2\.0 failed to start and was rolled back/.test(
      await page.locator('#settings-overlay .panel-body').innerText()),
    'a rollback is surfaced to the operator');

    // ---------------------------------------------------------------
    console.log('\n[updates] safe mode says why updates are being ignored');
    await openUpdates(page, {
      info: { ...OTA, source: 'bundled', safeMode: true },
      result: { status: 'up-to-date' },
    });
    assert(/Safe mode/.test(await page.locator('#settings-overlay .panel-body').innerText()),
      'safe mode is explained rather than silently ignoring updates');

    // ---------------------------------------------------------------
    console.log('\n[updates] restarting while OSC is LIVE asks first');
    page.removeAllListeners('dialog');
    let dialogMessage = null;
    page.on('dialog', d => { dialogMessage = d.message(); d.dismiss(); });
    await page.evaluate(() => { window.__relaunchCalled = false; });
    await openUpdates(page, { info: { ...OTA, staged: '2.2.0', installed: ['2.2.0'] }, result: null });
    await page.evaluate(() => window.__emitStatus('live'));
    await page.waitForSelector('#upd-restart');
    await page.click('#upd-restart');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(150);
    assert(dialogMessage !== null && /LIVE/.test(dialogMessage), 'a LIVE link makes the restart ask first');
    assert(await page.evaluate(() => window.__relaunchCalled === false),
      'declining the confirm leaves the show running');

    console.log('\n[updates] confirming the LIVE restart goes through');
    page.removeAllListeners('dialog');
    page.on('dialog', d => d.accept());
    await page.click('#upd-restart');
    await page.waitForFunction(() => window.__relaunchCalled === true);
    assert(true, 'accepting the confirm restarts');

    console.log('\n[updates] restarting while the link is idle does not ask at all');
    page.removeAllListeners('dialog');
    let askedWhenIdle = false;
    page.on('dialog', d => { askedWhenIdle = true; d.accept(); });
    await page.evaluate(() => { window.__relaunchCalled = false; });
    await openUpdates(page, { info: { ...OTA, staged: '2.2.0', installed: ['2.2.0'] }, result: null });
    await page.evaluate(() => window.__emitStatus('ready'));
    await page.waitForSelector('#upd-restart');
    await page.click('#upd-restart');
    await page.waitForFunction(() => window.__relaunchCalled === true);
    assert(!askedWhenIdle, 'no needless confirm when nothing is live');

    await browser.close();
    console.log('\nALL UPDATES UI CHECKS PASSED');
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('\nUPDATES UI CHECK FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    server.kill();
  }
}

main();
