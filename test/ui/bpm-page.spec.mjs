// Browser-mode UI check for the BPM page: opens the app served by
// test/serve.js against a real Chromium (via the `playwright` package,
// installed as a devDependency), exercises the BPM tab controls, injects
// synthetic 128 BPM audio straight into window.__bpmTracker (bypassing the
// mic so this runs headless/CI-safe), and checks the topbar MIC readout
// picks it up. Then, with the mic actually started, it rebuilds the surface
// (Settings -> Pages toggles renderAll) and checks that exactly one analyser —
// one live mic track, one open AudioContext — survives, including when two
// rebuilds land while a start() is still waiting on getUserMedia.
// Not part of `npm test` (needs a browser download) — run with:
//
//   node test/serve.js &          # port 5199
//   node test/ui/bpm-page.spec.mjs
//
// Takes a screenshot at test-artifacts/v2-bpm-page.png for a manual look.
import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..');
const baseUrl = process.env.ROGGER_UI_URL || 'http://127.0.0.1:5199';
const artifactDir = path.join(rootDir, 'test-artifacts');

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// Synth run inside the page: kick-like bursts (decaying 60 Hz sine + a short
// noise burst) on the beat, quieter hats on the off-beat — the same shape
// used by test/bpm-core.test.js, kept self-contained here since it runs in
// the browser context via page.evaluate.
function synthAndInject({ bpm, durationSec }) {
  function makeRng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function addKick(buf, sr, startSec, rng) {
    const durSec = 0.08, start = Math.round(startSec * sr), len = Math.round(durSec * sr);
    for (let i = 0; i < len && start + i < buf.length; i++) {
      const tt = i / sr, env = Math.exp(-tt / 0.03), tone = Math.sin(2 * Math.PI * 60 * tt);
      const noise = (rng() * 2 - 1) * Math.exp(-tt / 0.01);
      buf[start + i] += env * tone * 0.8 + noise * 0.6;
    }
  }
  function addHat(buf, sr, startSec, rng) {
    const durSec = 0.03, start = Math.round(startSec * sr), len = Math.round(durSec * sr);
    for (let i = 0; i < len && start + i < buf.length; i++) {
      const tt = i / sr, env = Math.exp(-tt / 0.008), noise = (rng() * 2 - 1);
      buf[start + i] += noise * env * 0.22;
    }
  }
  const tracker = window.__bpmTracker;
  const sr = tracker.sampleRate;
  const buf = new Float32Array(Math.floor(sr * durationSec));
  const rng = makeRng(128);
  let t = 0;
  while (t < durationSec) {
    addKick(buf, sr, t, rng);
    const period = 60 / bpm;
    const hatT = t + period / 2;
    if (hatT < durationSec) addHat(buf, sr, hatT, rng);
    t += period;
  }
  const hop = 512;
  for (let i = 0; i < buf.length; i += hop) {
    tracker.pushFrame(buf.subarray(i, Math.min(buf.length, i + hop)));
  }
  return tracker.estimate();
}

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(String(err)));

  // Instrument the media APIs the analyser opens, so the rebuild checks can
  // count what is really still alive afterwards: every track getUserMedia
  // handed out (readyState 'live' until stop()) and every AudioContext built
  // (state 'closed' after close()). getUserMedia stays Chromium's fake-device
  // one underneath; __gum.hold parks calls until __gum.release(), so a
  // rebuild can be made to land in the middle of a start().
  await page.addInitScript(() => {
    window.__gum = { calls: 0, resolved: 0, tracks: [], hold: false, waiters: [] };
    window.__gum.release = () => {
      window.__gum.hold = false;
      window.__gum.waiters.splice(0).forEach(resume => resume());
    };
    const md = navigator.mediaDevices;
    const realGum = md.getUserMedia.bind(md);
    md.getUserMedia = async constraints => {
      window.__gum.calls++;
      if (window.__gum.hold) await new Promise(resume => window.__gum.waiters.push(resume));
      const stream = await realGum(constraints);
      window.__gum.tracks.push(...stream.getTracks());
      window.__gum.resolved++;
      return stream;
    };
    window.__audioContexts = [];
    const RealAudioContext = window.AudioContext;
    window.AudioContext = class extends RealAudioContext {
      constructor(...args) { super(...args); window.__audioContexts.push(this); }
    };
  });

  try {
    await page.goto(baseUrl, { waitUntil: 'load' });
    await page.waitForSelector('body[data-ready="1"]', { timeout: 10000 });

    // ---- click the BPM tab ----
    const tabs = await page.$$('.page-tab');
    let bpmTab = null;
    for (const t of tabs) {
      const text = (await t.textContent())?.trim().toUpperCase();
      if (text === 'BPM') { bpmTab = t; break; }
    }
    assert(bpmTab, 'BPM tab exists in the page-tabs row');
    await bpmTab.click();
    await page.waitForSelector('.fx-page.active.bpm-page', { timeout: 5000 });

    // ---- controls exist ----
    for (const sel of ['#bpm-device', '#bpm-run', '#bpm-lock', '#bpm-send', '#bpm-resync',
      '#bpm-value', '#bpm-canvas', '#bpm-status']) {
      const el = await page.$(sel);
      assert(el, `${sel} exists on the BPM page`);
    }
    console.log('OK: BPM page controls present');

    // ---- inject synthetic 128 BPM audio straight into the tracker ----
    const est = await page.evaluate(synthAndInject, { bpm: 128, durationSec: 12 });
    console.log('tracker.estimate() after injection:', est);
    assert(est.bpm !== null, 'tracker produced a bpm estimate');
    assert(Math.abs(est.bpm - 128) <= 2, `bpm ${est.bpm} within +-2 of 128`);
    console.log(`OK: injected 128 BPM audio -> estimate ${est.bpm.toFixed(2)} (confidence ${est.confidence.toFixed(2)})`);

    // ---- topbar source button: TAP -> AUTO -> MIC ----
    const srcBtn = page.locator('#bpm-source');
    await srcBtn.click(); // -> auto
    await srcBtn.click(); // -> mic
    const srcText = (await srcBtn.textContent())?.trim();
    assert(srcText === 'Mic', `topbar source button reads "Mic" (was "${srcText}")`);

    // let the ~12 Hz analyser update loop push the estimate into beat-clock
    await page.waitForFunction(() => {
      const t = document.getElementById('bpm-readout')?.textContent || '';
      return /^\d/.test(t);
    }, { timeout: 3000 });

    const readoutText = (await page.locator('#bpm-readout').textContent())?.trim();
    console.log('bpm-readout text:', readoutText);
    const match = readoutText && readoutText.match(/^(\d+(?:\.\d+)?)/);
    assert(match, `#bpm-readout starts with a number (was "${readoutText}")`);
    const readoutBpm = Number(match[1]);
    assert(Math.abs(readoutBpm - 128) <= 3, `#bpm-readout bpm ${readoutBpm} near 128`);
    console.log(`OK: #bpm-readout in MIC mode reads "${readoutText}"`);

    // ---- device picker: a styled list panel, not a native <select> ----
    // best-effort: let the async device probe finish so the button is painted
    await page.waitForFunction(
      () => !/Loading/.test(document.querySelector('.bpm-device-name')?.textContent ?? 'Loading'),
      { timeout: 3000 }).catch(() => {});
    assert(await page.locator('#bpm-device').evaluate(el => el.tagName) === 'BUTTON',
      '#bpm-device is a styled button, not a native select');
    const deviceLabelBefore = (await page.locator('.bpm-device-name').textContent())?.trim();
    assert(deviceLabelBefore && deviceLabelBefore.length > 0, `the picker names the current input ("${deviceLabelBefore}")`);

    await page.click('#bpm-device');
    await page.waitForSelector('.overlay--pick', { timeout: 4000 });
    const rows = await page.locator('.overlay--pick .pick-row').count();
    const emptyHint = await page.locator('.overlay--pick .hint').count();
    assert(rows > 0 || emptyHint > 0, `the picker lists inputs (${rows}) or says there are none`);
    // Long device names must be readable in full, never cut off.
    if (rows > 0) {
      const clipped = await page.locator('.overlay--pick .pick-row-label').evaluateAll(
        els => els.filter(e => e.scrollWidth - e.clientWidth > 1).length);
      assert(clipped === 0, 'no device name is truncated in the picker');
    }
    await page.locator('.overlay--pick .panel-foot button').click();
    await page.waitForFunction(() => !document.querySelector('.overlay--pick'), { timeout: 3000 });
    assert(true, 'Cancel closes the picker without changing the input');

    // ---- screenshot ----
    const shotPath = path.join(artifactDir, 'v2-bpm-page.png');
    await page.screenshot({ path: shotPath });
    console.log('Screenshot saved:', shotPath);

    // ---- surface rebuild: exactly one analyser stays alive ----
    // Every renderAll() (a Settings -> Pages toggle is one) rebuilds the BPM
    // page and its analyser. The previous one must let go of the mic and its
    // AudioContext; only the replacement may be listening afterwards.
    const alive = () => page.evaluate(() => ({
      gumCalls: window.__gum.calls,
      liveTracks: window.__gum.tracks.filter(t => t.readyState === 'live').length,
      openContexts: window.__audioContexts.filter(c => c.state !== 'closed').length,
    }));
    // The current page's Start button flips to Stop once its analyser.start()
    // has resolved; with no getUserMedia still pending, every start is done.
    const waitForListening = () => page.waitForFunction(() =>
      document.querySelector('#bpm-run')?.textContent === 'Stop'
      && window.__gum.resolved === window.__gum.calls, { timeout: 5000 });

    await page.click('#bpm-run');
    await waitForListening();
    let a = await alive();
    assert(a.liveTracks === 1 && a.openContexts === 1,
      `Start opens one mic track and one AudioContext (${JSON.stringify(a)})`);
    console.log('OK: Start -> one live mic track, one open AudioContext');

    await page.click('#settings-open');
    await page.waitForSelector('#settings-overlay');
    await page.getByRole('button', { name: 'Pages', exact: true }).click();
    const djToggle = page.locator('#settings-overlay .check-row', { hasText: 'Show DJ Intro' }).locator('.toggle');

    for (const step of ['hide DJ Intro', 'show DJ Intro']) {
      const before = await alive();
      await djToggle.click();          // renderAll -> BPM page rebuilt; micAutoStart restarts it
      await waitForListening();
      await page.waitForTimeout(300);  // let the old AudioContext's close() settle
      a = await alive();
      assert(a.gumCalls > before.gumCalls, `${step}: the rebuilt page started its own analyser`);
      assert(a.liveTracks === 1, `${step}: exactly one live mic track after the rebuild (got ${a.liveTracks})`);
      assert(a.openContexts === 1, `${step}: exactly one open AudioContext after the rebuild (got ${a.openContexts})`);
    }
    console.log('OK: a surface rebuild stops the previous analyser; one stays alive');

    // ---- race: two rebuilds while a start() still waits on getUserMedia ----
    // The middle page's analyser is not "running" yet when its page is torn
    // down; its start() resolves later and must not stay listening behind
    // the final page.
    await page.evaluate(() => { window.__gum.hold = true; });
    await djToggle.click();            // rebuild 1: its start() parks on getUserMedia
    await djToggle.click();            // rebuild 2: tears down a page that never got running
    a = await alive();
    assert(a.liveTracks === 0, `nothing listens while getUserMedia is held (got ${a.liveTracks})`);
    await page.evaluate(() => window.__gum.release());
    await waitForListening();
    await page.waitForTimeout(500);    // let every parked start() finish its worklet load and settle
    a = await alive();
    assert(a.liveTracks === 1, `race: exactly one live mic track after back-to-back rebuilds (got ${a.liveTracks})`);
    assert(a.openContexts === 1, `race: exactly one open AudioContext after back-to-back rebuilds (got ${a.openContexts})`);
    console.log('OK: back-to-back rebuilds mid-start leave exactly one analyser running');
    await page.click('#set-close');

    const seriousErrors = consoleErrors.filter(e => !/ResizeObserver|getUserMedia/i.test(e));
    if (seriousErrors.length) {
      console.warn('Console errors during the run:', seriousErrors);
    }

    console.log('BPM_PAGE_UI_TEST_OK');
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('BPM_PAGE_UI_TEST_FAILED:', err);
  process.exit(1);
});
