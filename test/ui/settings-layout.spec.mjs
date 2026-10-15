// Headless layout audit of every Settings tab and the button / safety / panic
// editors: clipped text, elements sticking out of the panel, overlapping
// controls, horizontal scroll. Filled with realistic DMX content (long safety
// names, banks, sACN buttons) so the new tabs are measured full, not empty.
// Run by hand: `PW_CHANNEL=chrome node test/ui/settings-layout.spec.mjs`
// (spawns test/serve.js). LAYOUT_SHOTS=<dir> also writes a screenshot per view.
// Browser fonts differ from Electron's, so this is the quick check;
// tools/audit-layout.js in the real app stays the authority.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5195;
const URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..', '..');
const SHOTS = process.env.LAYOUT_SHOTS;
// 1840x1035 = the ROG Ally: 1280x720 DIP at 150% scaling, zoomed 0.6956 by fitZoom.
const SIZES = [[1704, 1035], [1760, 1040], [1840, 1035], [1920, 1080]];
// WIDE_FONT=1: stress pass with a wider font, standing in for Windows' Segoe UI metrics.
const WIDE = !!process.env.WIDE_FONT;
const TABS = ['Network', 'Controller', 'Safety', 'DMX', 'Pages', 'Updates', 'Backup', 'About'];

async function waitForServer(url) {
  for (let i = 0; i < 100; i += 1) {
    try { await fetch(url); return; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
}

// Runs in the page: every problem inside `rootSel`'s panel.
function audit(rootSel) {
  const panel = document.querySelector(rootSel + ' .panel') ?? document.querySelector(rootSel);
  if (!panel) return ['no panel'];
  const pr = panel.getBoundingClientRect();
  const out = [];
  const name = el => {
    const t = (el.innerText || el.value || el.placeholder || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}.${String(el.className).split(' ').filter(Boolean).slice(0, 2).join('.')}${t ? ` "${t}"` : ''}`;
  };
  // what is actually on screen: the box clipped by the scrolling panel body
  const bodyEl = panel.querySelector('.panel-body');
  const br = bodyEl?.getBoundingClientRect();
  const clip = el => {
    const r = el.getBoundingClientRect();
    if (!bodyEl || !bodyEl.contains(el)) return r;
    const top = Math.max(r.top, br.top), bottom = Math.min(r.bottom, br.bottom);
    return { left: r.left, right: r.right, top, bottom, width: r.width, height: bottom - top };
  };
  const visible = el => {
    const s = getComputedStyle(el);
    const r = clip(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 1;
  };
  const els = [...panel.querySelectorAll('*')].filter(visible);
  for (const el of els) {
    const r = el.getBoundingClientRect();
    // sticking out of the panel sideways (vertical overflow scrolls in .panel-body)
    if (r.left < pr.left - 1 || r.right > pr.right + 1) out.push(`OUTSIDE panel: ${name(el)} (${Math.round(r.left - pr.left)}..${Math.round(r.right - pr.left)} of ${Math.round(pr.width)})`);
    // text cut: content wider than the box, and the box hides it
    const s = getComputedStyle(el);
    const textual = el.childNodes.length && [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (textual && el.scrollWidth > el.clientWidth + 1 && (s.overflowX === 'hidden' || s.textOverflow === 'ellipsis' || s.overflow === 'hidden')) {
      out.push(`CLIPPED text: ${name(el)} (${el.scrollWidth}>${el.clientWidth})`);
    }
    if (textual && el.scrollHeight > el.clientHeight + 2 && s.overflowY === 'hidden' && !s.webkitLineClamp) {
      out.push(`CLIPPED height: ${name(el)} (${el.scrollHeight}>${el.clientHeight})`);
    }
    // squeezed: content taller than the box although nothing scrolls or clips it
    // (a flex row crushed, a fixed-height row whose label wrapped)
    if (s.overflowY === 'visible' && el.scrollHeight > el.clientHeight + 2 && el.clientHeight > 0 && !el.matches('.panel-body, .panel')) {
      out.push(`SQUEEZED: ${name(el)} (${el.scrollHeight}>${el.clientHeight})`);
    }
  }
  // overlapping controls within the same row
  const ctrls = els.filter(el => el.matches('button, input, textarea, select, .seg, .toggle, .safety-info, .dmx-chan'));
  for (let i = 0; i < ctrls.length; i += 1) {
    for (let j = i + 1; j < ctrls.length; j += 1) {
      const a = ctrls[i], b = ctrls[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = clip(a), rb = clip(b);
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 1 && oy > 1) out.push(`OVERLAP: ${name(a)} × ${name(b)} (${Math.round(ox)}×${Math.round(oy)})`);
    }
  }
  // touching: two stacked blocks with no air between them (each pair of
  // visible blocks that overlap horizontally and sit within 3 px vertically)
  const blocks = els.filter(el => el.matches('.field, .row, .check-row, .big-btn, .test-result, .hint, pre, .safety-row, .dmx-chan, .dmx-stream-head, .link-leg, .update-progress, .seg, textarea, input, .glyph-row, .swatch-row'));
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = 0; j < blocks.length; j += 1) {
      const a = blocks[i], b2 = blocks[j];
      if (i === j || a.contains(b2) || b2.contains(a)) continue;
      const ra = clip(a), rb = clip(b2);
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const gap = rb.top - ra.bottom;
      if (ox > 4 && gap >= -1 && gap < 3 && rb.top > ra.top) out.push(`TOUCHING: ${name(a)} above ${name(b2)} (gap ${Math.round(gap)}px)`);
    }
  }
  const body = panel.querySelector('.panel-body');
  if (body && body.scrollWidth > body.clientWidth + 1) out.push(`H-SCROLL in panel-body (${body.scrollWidth}>${body.clientWidth})`);
  return [...new Set(out)];
}

const server = spawn(process.execPath, ['test/serve.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
let browser;
let problems = 0;
try {
  await waitForServer(URL + '/__defaults');
  browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
  for (const [w, hgt] of SIZES) {
    const page = await browser.newPage({ viewport: { width: w, height: hgt } });
    const errors = [];
    page.on('pageerror', err => errors.push(err.message));
    await page.goto(URL);
    await page.waitForFunction(() => document.body.dataset.ready === '1');
    if (process.env.LAYOUT_EXTRA_CSS) await page.addStyleTag({ content: process.env.LAYOUT_EXTRA_CSS });
    if (WIDE) await page.addStyleTag({ content: '*, *::before, *::after { font-family: Verdana, sans-serif !important; }' });
    const baseTb = await page.evaluate(() => { const b = document.getElementById('topbar'); return [b.scrollWidth, b.clientWidth]; });
    console.log(`${w}x${hgt} topbar baseline (no safeties): scrollWidth ${baseTb[0]} / clientWidth ${baseTb[1]}`);
    // realistic DMX content
    await page.evaluate(async () => {
      const st = await import('/js/state.js');
      const { applySacn } = await import('/js/sacn-button.js');
      const cfg = st.get();
      const mk = (id, label, ch, extra, over = {}) => ({ id, label, universe: 8, channel: ch, armedValue: 255, safeValue: 0, priority: 150,
        extra, host: '', iface: '', mode: 'toggle', twoHand: true, armHoldMs: 1000, gamepadButton: 8, gamepadModifier: 9, ...over });
      st.replaceList('safeties', [
        mk('s1', 'CO2 STAGE LEFT + RIGHT ARM', 1, ['8/11', '8/21', '8/31', '8/41', '8/51', '8/61', '8/71']),
        mk('s2', 'FLAMES', 101, ['9/1', '9/11'], { twoHand: false, mode: 'hold', gamepadButton: -1, gamepadModifier: -1 }),
        mk('s3', 'SPARKULAR DOWNSTAGE', 201, [], { gamepadButton: 4, gamepadModifier: 5 }),
      ]);
      const fx = structuredClone(cfg.fxButtons);
      for (let i = 0; i < 3; i += 1) {
        fx[i] = applySacn({ ...fx[i], output: 'sacn', mode: ['toggle', 'hold', 'shot'][i], value: 255, fill: true, icon: 'CO₂',
          label: ['CO2 BIG BLAST LEFT', 'FLAME', 'SPARK'][i],
          sacn: { ...fx[i].sacn, universe: 8, channel: 3 + i, defaultValue: 0, safety: ['s1', 's2', 's3'][i], maxMs: 3000, shotMs: 500, priority: 150 } });
      }
      st.replaceList('fxButtons', fx);
      st.requestRerender();
      const rogger = (await import('/js/bridge.js')).rogger;
      for (const b of fx.slice(0, 3)) rogger.sendTyped(b.address, [{ type: 'i', value: 0 }]);
    });
    await page.waitForTimeout(200);
    const views = [];
    for (const tab of TABS) views.push({ name: `settings:${tab}`, open: async () => {
      await page.click('#settings-open');
      await page.getByRole('button', { name: tab, exact: true }).click();
      await page.waitForTimeout(350);
    }, root: '#settings-overlay' });
    // the Updates tab in its busier states
    const updatesWith = (info, result) => async () => {
      await page.evaluate(([i, r]) => { window.__updateInfo = i; window.__updateResult = r; }, [info, result]);
      await page.click('#settings-open');
      await page.getByRole('button', { name: 'Updates', exact: true }).click();
      await page.waitForTimeout(250);
      if (result) { await page.click('#upd-check'); await page.waitForTimeout(250); }
    };
    const baseInfo = { supported: true, source: 'ota', payloadVersion: '2.2.21', shellVersion: '2.1.0', autoCheck: true, lastCheck: Date.now() };
    views.push({ name: 'settings:Updates available', root: '#settings-overlay',
      open: updatesWith(baseInfo, { status: 'available', version: '2.2.22', size: 127000, notes: 'Line one of the notes\n- a bullet\n- another bullet' }) });
    views.push({ name: 'settings:Updates staged+installed+rolled back', root: '#settings-overlay',
      open: updatesWith({ ...baseInfo, staged: '2.2.22', installed: ['2.2.22'], quarantined: ['2.2.20'] }, null) });
    views.push({ name: 'settings:Updates shell-required', root: '#settings-overlay',
      open: updatesWith(baseInfo, { status: 'shell-required', version: '3.0.0', message: 'Version 3.0.0 needs a new app shell.', htmlUrl: 'https://example.invalid' }) });
    const edit = (kind, i, prep) => async () => {
      await page.evaluate(([k, ix]) => import('/js/editor.js').then(m => m.openEditor(k, ix)), [kind, i]);
      await page.waitForSelector('#editor-overlay');
      if (prep) await prep();
      await page.waitForTimeout(150);
    };
    views.push({ name: 'editor:fx OSC', open: edit('fxButtons', 5), root: '#editor-overlay' });
    for (const [i, mode] of [[0, 'toggle'], [1, 'hold'], [2, 'shot']]) {
      views.push({ name: `editor:fx sACN ${mode}`, open: edit('fxButtons', i), root: '#editor-overlay' });
    }
    views.push({ name: 'editor:safety two-hand bank', open: edit('safeties', 0), root: '#editor-overlay' });
    views.push({ name: 'editor:panic', open: edit('panicButtons', 0), root: '#editor-overlay' });

    for (const v of views) {
      await v.open();
      // audit the whole scroll height of the panel body, a screen at a time
      const found = new Set();
      const bodySel = `${v.root} .panel-body`;
      const total = await page.evaluate(s => document.querySelector(s)?.scrollHeight ?? 0, bodySel);
      const step = await page.evaluate(s => document.querySelector(s)?.clientHeight ?? 1, bodySel);
      for (let y = 0; y <= Math.max(0, total - step); y += step) {
        await page.evaluate(([s, top]) => { const b = document.querySelector(s); if (b) b.scrollTop = top; }, [bodySel, y]);
        await page.waitForTimeout(40);
        for (const p of await page.evaluate(audit, v.root)) found.add(p);
        if (SHOTS) await page.locator(`${v.root} .panel`).screenshot({ path: `${SHOTS}/${w}x${hgt}-${v.name.replace(/[^a-z0-9]+/gi, '_')}-${y}.png` });
      }
      const list = [...found];
      problems += list.length;
      console.log(`${WIDE ? 'WIDE ' : ''}${w}x${hgt} ${v.name}: ${list.length ? '\n    ' + list.join('\n    ') : 'ok'}`);
      await page.evaluate(() => { document.getElementById('settings-overlay')?.remove(); document.getElementById('editor-overlay')?.remove(); });
    }
    // topbar with the longest safety state
    await page.evaluate(async () => {
      const s = await import('/js/safety.js'); const st = await import('/js/state.js'); const { rogger } = await import('/js/bridge.js');
      for (const x of st.get().safeties) s.setArmed(x.id, true, st.get(), rogger);
      await s.setPreview(true, rogger);
    });
    const tb = await page.evaluate(() => {
      const bar = document.getElementById('topbar'); const br = bar.getBoundingClientRect();
      const out = [];
      for (const el of bar.children) {
        const r = el.getBoundingClientRect();
        if (r.right > br.right + 1) out.push(`TOPBAR outside: ${el.className}`);
      }
      const kids = [...bar.children].filter(e => e.getBoundingClientRect().width > 0);
      for (let i = 0; i < kids.length; i += 1) for (let j = i + 1; j < kids.length; j += 1) {
        const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) out.push(`TOPBAR overlap: ${kids[i].className} × ${kids[j].className}`);
      }
      if (bar.scrollWidth > bar.clientWidth + 1) out.push(`TOPBAR h-scroll ${bar.scrollWidth}>${bar.clientWidth}`);
      return out;
    });
    problems += tb.length;
    console.log(`${w}x${hgt} topbar (3 armed + preview): ${tb.length ? '\n    ' + tb.join('\n    ') : 'ok'}`);
    if (SHOTS) await page.locator('#topbar').screenshot({ path: `${SHOTS}/${w}x${hgt}-topbar.png` });
    if (errors.length) { problems += errors.length; console.log('  page errors: ' + errors.join(' | ')); }
    await page.close();
  }
  console.log(problems ? `\nLAYOUT_PROBLEMS ${problems}` : '\nLAYOUT_OK');
} finally {
  await browser?.close();
  server.kill();
}
process.exitCode = problems ? 1 : 0;
