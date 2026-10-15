// README screenshots from the browser build with the shipped config and
// neutral demo DMX content (no real network, show or performer names).
//   node tools/readme-shots.mjs        (PW_CHANNEL=chrome to use system Chrome)
// Writes docs/screenshots/*.png at the ROG Ally's CSS size (1840x1035).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = 5193;
const URL = `http://127.0.0.1:${PORT}`;
fs.mkdirSync(OUT, { recursive: true });

const server = spawn(process.execPath, ['test/serve.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 100; i += 1) {
    try { await fetch(URL + '/__defaults'); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  const page = await browser.newPage({ viewport: { width: 1840, height: 1035 }, deviceScaleFactor: 1 });
  await page.goto(URL);
  await page.waitForFunction(() => document.body.dataset.ready === '1');
  // the clock and battery readouts would date every shot; freeze them
  await page.addStyleTag({ content: '#toast-root, .toast { display: none !important; }' });

  await page.evaluate(async () => {
    const st = await import('/js/state.js');
    const { applySacn } = await import('/js/sacn-button.js');
    const cfg = st.get();
    st.replaceList('safeties', [
      { id: 'arm-co2', label: 'CO2 ARM', universe: 10, channel: 1, armedValue: 255, safeValue: 0, priority: 150,
        extra: ['10/11', '10/21', '10/31'], host: '', iface: '', mode: 'toggle', twoHand: true, armHoldMs: 1000, gamepadButton: 8, gamepadModifier: 9 },
      { id: 'arm-flame', label: 'FLAME ARM', universe: 10, channel: 101, armedValue: 255, safeValue: 0, priority: 150,
        extra: [], host: '', iface: '', mode: 'toggle', twoHand: false, armHoldMs: 1000, gamepadButton: -1, gamepadModifier: -1 },
    ]);
    const fx = structuredClone(cfg.fxButtons);
    const demo = [['CO2 LEFT', 'hold', 3, 'arm-co2', '#00e0ff'], ['CO2 RIGHT', 'hold', 13, 'arm-co2', '#00e0ff'], ['FLAMES', 'shot', 103, 'arm-flame', '#ff7a1a']];
    demo.forEach(([label, mode, ch, safety, color], i) => {
      const k = 12 + i; // bump bank, so the flash bank stays as shipped
      fx[k] = applySacn({ ...fx[k], label, icon: label.startsWith('CO2') ? 'CO₂' : '☄', color, fill: true, output: 'sacn', mode, value: 255,
        sacn: { ...fx[k].sacn, universe: 10, channel: ch, defaultValue: 0, safety, maxMs: 3000, shotMs: 500, priority: 150 } });
    });
    st.replaceList('fxButtons', fx);
    st.requestRerender();
  });
  await page.waitForTimeout(400);
  const shot = async name => { await page.waitForTimeout(250); await page.screenshot({ path: path.join(OUT, name) }); console.log('wrote', name); };

  // 1. main surface, safety armed, CO2 LEFT held
  await page.evaluate(async () => {
    const s = await import('/js/safety.js'); const st = await import('/js/state.js'); const { rogger } = await import('/js/bridge.js');
    s.setArmed('arm-co2', true, st.get(), rogger);
  });
  const co2 = page.locator('.fx-btn[data-kind="fxButtons"][data-index="12"]');
  await co2.dispatchEvent('pointerdown', { pointerId: 1, button: 0 });
  await shot('surface.png');

  // 5. DMX monitor while it fires
  await page.click('#settings-open');
  await page.getByRole('button', { name: 'DMX', exact: true }).click();
  await page.waitForTimeout(500);
  await shot('dmx-monitor.png');
  await page.evaluate(() => document.getElementById('settings-overlay')?.remove());
  await co2.dispatchEvent('pointerup', { pointerId: 1, button: 0 });

  // 4. Settings -> Safety
  await page.click('#settings-open');
  await page.getByRole('button', { name: 'Safety', exact: true }).click();
  await shot('safety.png');
  await page.evaluate(() => document.getElementById('settings-overlay')?.remove());

  // 3. sACN button editor
  await page.evaluate(() => import('/js/editor.js').then(m => m.openEditor('fxButtons', 12)));
  await page.waitForSelector('#editor-overlay');
  await page.evaluate(() => { document.querySelector('#editor-overlay .panel-body').scrollTop = 330; });
  await shot('sacn-editor.png');
  await page.evaluate(() => document.getElementById('editor-overlay')?.remove());

  // 2. Colors page
  await page.locator('#fx-grid .page-tab', { hasText: 'Colors' }).click();
  await shot('colors.png');
} finally {
  await browser?.close();
  server.kill();
}
