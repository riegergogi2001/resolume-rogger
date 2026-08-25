// Layout regression check: at the declared minimum window size (and at the
// target device's 1920x1080) nothing on any page or in any overlay may be
// clipped, wrapped out of its box, or pushed outside the viewport.
//
// The surface is deliberately non-adaptive — fixed chrome is sized to its
// longest label and never shrinks — so the only way it stays honest is to
// pin the floor and check against it. Run: `node test/ui/min-window.spec.mjs`
// (it spawns its own test/serve.js).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const { MIN_WIDTH, MIN_HEIGHT } = require(path.join(ROOT, 'src', 'window-size.js'));

const PORT = 5191;
const URL = `http://127.0.0.1:${PORT}`;
const SIZES = [
  { name: 'minimum', width: MIN_WIDTH, height: MIN_HEIGHT },
  { name: 'ally-x', width: 1920, height: 1080 },
];

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log('  ok - ' + msg); return; }
  failures += 1;
  console.log('  FAIL - ' + msg);
}

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

// Returns a list of offences; empty means the screen is clean.
const OFFENCES = () => {
  const out = [];
  const name = el => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
    const txt = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 26);
    return `${el.tagName.toLowerCase()}${id}${cls}${txt ? ` "${txt}"` : ''}`;
  };
  const vw = window.innerWidth, vh = window.innerHeight;
  if (document.body.scrollWidth > vw + 1) out.push(`body scrolls horizontally (+${document.body.scrollWidth - vw}px)`);
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (cs.overflowY === 'hidden' && el.scrollHeight - el.clientHeight > 1) {
      out.push(`${name(el)} clipped vertically (+${el.scrollHeight - el.clientHeight}px)`);
    }
    if (cs.overflowX === 'hidden' && el.scrollWidth - el.clientWidth > 1 && cs.textOverflow !== 'ellipsis') {
      out.push(`${name(el)} clipped horizontally (+${el.scrollWidth - el.clientWidth}px)`);
    }
    if (r.right > vw + 1.5 || r.bottom > vh + 1.5 || r.left < -1.5 || r.top < -1.5) {
      let p = el.parentElement, scrolls = false;
      while (p && !scrolls) {
        const pcs = getComputedStyle(p);
        scrolls = /auto|scroll/.test(pcs.overflowY) || /auto|scroll/.test(pcs.overflowX);
        p = p.parentElement;
      }
      if (!scrolls) out.push(`${name(el)} outside the viewport`);
    }
  }
  return out;
};

async function screen(page, label) {
  const found = await page.evaluate(OFFENCES);
  check(found.length === 0, `${label} fits${found.length ? ` — ${found.slice(0, 4).join('; ')}` : ''}`);
}

async function main() {
  const server = spawn(process.execPath, ['test/serve.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', d => process.stderr.write(`[serve] ${d}`));
  let browser;
  try {
    await waitForServer(`${URL}/__defaults`);
    browser = await chromium.launch();

    for (const size of SIZES) {
      console.log(`\n[${size.name}] ${size.width}x${size.height}`);
      const page = await browser.newPage({ viewport: { width: size.width, height: size.height } });
      await page.goto(URL);
      await page.waitForFunction(() => document.body.dataset.ready === '1');
      await page.waitForTimeout(300);

      const tabs = await page.locator('#fx-grid .page-tab').allInnerTexts();
      for (let i = 0; i < tabs.length; i += 1) {
        await page.locator('#fx-grid .page-tab').nth(i).click();
        await page.waitForTimeout(200);
        await screen(page, `page "${tabs[i]}"`);
      }
      await page.locator('#fx-grid .page-tab').nth(0).click();
      await page.waitForTimeout(150);

      await page.click('#edit-toggle');
      await page.waitForTimeout(200);
      await screen(page, 'edit mode');

      const editors = [
        ['#fx-grid .fx-btn', 'FX button editor'],
        ['#fader-rack .fader', 'fader editor'],
        ['#color-row .color-btn', 'colour preset editor'],
        ['#color-row .target-pick', 'colour target editor'],
      ];
      for (const [sel, label] of editors) {
        if (!await page.locator(sel).count()) continue;
        await page.locator(sel).first().click();
        await page.waitForSelector('.overlay');
        await page.waitForTimeout(250);
        await screen(page, label);
        await page.evaluate(() => document.querySelector('.overlay')?.remove());
      }
      await page.click('#edit-toggle');
      await page.waitForTimeout(150);

      await page.click('#settings-open');
      await page.waitForSelector('#settings-overlay');
      const stabs = await page.locator('#settings-overlay .settings-tab').allInnerTexts();
      for (let i = 0; i < stabs.length; i += 1) {
        await page.locator('#settings-overlay .settings-tab').nth(i).click();
        await page.waitForTimeout(280);
        await screen(page, `settings "${stabs[i]}"`);
      }
      // Every settings tab must be reachable — a wrapped tab bar that pushes a
      // tab out of the panel is exactly the kind of break this guards against.
      check(stabs.length === 6, `all six settings tabs present (${stabs.join(', ')})`);
      await page.evaluate(() => document.querySelector('.overlay')?.remove());
      await page.close();
    }
    await browser.close();
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('\nMIN-WINDOW CHECK ERRORED:', err.message);
    process.exitCode = 1;
    server.kill();
    return;
  } finally {
    server.kill();
  }

  console.log(failures === 0
    ? '\nALL MIN-WINDOW LAYOUT CHECKS PASSED'
    : `\nMIN-WINDOW LAYOUT CHECK FAILED: ${failures} problem(s)`);
  process.exitCode = failures === 0 ? 0 : 1;
}
main();
