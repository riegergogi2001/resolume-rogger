// Settings → Updates: over-the-air payload updates from GitHub releases.
//
// Stage-safe by construction. Checking is cheap and may happen on launch, but
// downloading and restarting are always an explicit tap, and a restart while
// the OSC link is LIVE asks first. Nothing here ever swaps code under a
// running show — an installed payload is picked up by the shell next launch.
import { rogger } from './bridge.js';
import { showToast } from './toast.js';
import { h, checkRow, field, btnRow } from './dom.js';

const RELEASES_HINT = 'Updates are downloaded from the project\'s GitHub releases and verified '
  + 'against a sha256 checksum before they are installed. A downloaded update starts on the next launch.';

function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  return n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function stamp(ms) {
  if (!ms) return 'never';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

/** Release notes are markdown; show them as plain text rather than pretend to render it. */
function notesBlock(notes) {
  const text = String(notes ?? '').trim();
  if (!text) return null;
  const pre = document.createElement('pre');
  pre.className = 'api-cheatsheet';
  pre.textContent = text.length > 1200 ? `${text.slice(0, 1200)}\n…` : text;
  return pre;
}

/**
 * Render the Updates tab into `body`.
 * @param {HTMLElement} body     the settings panel body, already emptied
 * @param {() => string} oscStatus  current OSC status, for the LIVE guard
 */
export function renderUpdates(body, { oscStatus = () => 'offline' } = {}) {
  let info = null;
  let result = null;
  let progress = null;
  let offProgress = null;

  const versions = h('div');
  const controls = h('div');
  const status = h('div', 'test-result');
  const detail = h('div');
  body.append(versions, controls, status, detail);

  // The panel can be torn down mid-download; drop the listener with it.
  const observer = new MutationObserver(() => {
    if (!body.isConnected) { offProgress?.(); observer.disconnect(); }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  function setStatus(text, kind) {
    status.textContent = text ?? '';
    status.className = 'test-result' + (kind ? ` ${kind}` : '');
  }

  function renderVersions() {
    versions.innerHTML = '';
    if (!info) return;
    const badge = info.source === 'ota' ? 'OTA' : info.source === 'bundled' ? 'BUNDLED' : 'DEV';
    versions.append(field('Running version', h('div', 'hint', `${info.payloadVersion ?? 'unknown'}  ·  ${badge}`)));
    if (info.shellVersion && info.shellVersion !== info.payloadVersion) {
      versions.append(field('App shell (exe)', h('div', 'hint', info.shellVersion)));
    }
    versions.append(field('Last checked', h('div', 'hint', stamp(info.lastCheck))));

    if (info.safeMode) {
      versions.append(h('div', 'test-result fail',
        'Safe mode: the bundled version is running and updates are ignored. Restart without --safe to use them.'));
    }
    if (info.quarantined?.length) {
      versions.append(h('div', 'test-result fail',
        `Version ${info.quarantined.join(', ')} failed to start and was rolled back.`));
    }
    if (!info.supported) {
      versions.append(h('div', 'hint',
        'This build has no update payload directory — updates are only available in the packaged app.'));
    }
  }

  function renderControls() {
    controls.innerHTML = '';
    if (!info) return;

    controls.append(checkRow('Check for updates on launch', info.autoCheck !== false, async v => {
      info = await rogger.updateSetAuto(v);
      showToast(v ? 'Update check on launch enabled' : 'Update check on launch disabled');
    }));

    const checkBtn = h('button', 'big-btn u-caps', 'Check now');
    checkBtn.id = 'upd-check';
    checkBtn.disabled = !info.supported;
    checkBtn.addEventListener('click', () => runCheck());
    controls.append(btnRow(checkBtn));
  }

  function restartButton(label) {
    const btn = h('button', 'big-btn primary u-caps', label);
    btn.id = 'upd-restart';
    btn.addEventListener('click', () => {
      // Restarting drops the OSC socket. If anything is still talking to us,
      // make the operator confirm rather than going dark mid-cue.
      if (oscStatus() === 'live' && !confirm('OSC is LIVE. Restart ROGGER now to apply the update?')) return;
      rogger.relaunch?.();
    });
    return btn;
  }

  function releasesButton(url, label = 'Open releases page') {
    const btn = h('button', 'big-btn u-caps', label);
    btn.id = 'upd-releases';
    btn.addEventListener('click', () => rogger.openReleases?.(url));
    return btn;
  }

  function downloadButton(version, size) {
    const bar = h('div', 'update-progress');
    const fill = h('div', 'update-progress-fill');
    bar.appendChild(fill);
    bar.hidden = true;

    const btn = h('button', 'big-btn primary u-caps', size ? `Download ${version} (${bytes(size)})` : `Download ${version}`);
    btn.id = 'upd-download';
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      bar.hidden = false;
      fill.style.width = '0%';
      setStatus(`Downloading ${version}…`);
      offProgress?.();
      offProgress = rogger.onUpdateProgress?.(p => {
        progress = p;
        // GitHub always sends content-length, but fall back to an indeterminate
        // sliver rather than a bar that jumps to 100% and sits there.
        const pct = p.total ? Math.min(100, Math.round((p.received / p.total) * 100)) : 5;
        fill.style.width = `${pct}%`;
      });
      const next = await rogger.updateDownload();
      offProgress?.();
      offProgress = null;
      info = next;
      if (next?.download?.ok) {
        fill.style.width = '100%';
        result = { status: 'ready', version: next.download.version };
        showToast(`Version ${next.download.version} installed — restart to use it`);
      } else {
        bar.hidden = true;
        btn.disabled = false;
        setStatus(next?.download?.message ?? 'Download failed.', 'fail');
        return;
      }
      render();
    });
    const wrap = h('div');
    wrap.append(btnRow(btn), bar);
    return wrap;
  }

  function renderDetail() {
    detail.innerHTML = '';
    if (!info) return;

    // A payload already sitting on disk outranks whatever the last check said:
    // it is the thing that will actually boot next.
    const staged = result?.status === 'ready' ? result.version : info.staged;
    if (staged) {
      setStatus(`Version ${staged} is installed and starts on the next launch.`, 'ok');
      detail.append(btnRow(restartButton(`Restart into ${staged}`)));
    } else if (result) {
      renderResult();
    }

    if (info.installed?.length) {
      const resetBtn = h('button', 'big-btn danger u-caps', 'Remove updates, run the bundled version');
      resetBtn.id = 'upd-reset';
      resetBtn.addEventListener('click', async () => {
        info = await rogger.updateReset();
        result = null;
        setStatus('Downloaded updates removed. The bundled version starts on the next launch.', 'ok');
        render();
      });
      detail.append(btnRow(resetBtn));
    }

    detail.append(h('div', 'hint', RELEASES_HINT));
  }

  function renderResult() {
    switch (result.status) {
      case 'up-to-date':
        setStatus(`Up to date — running ${info.payloadVersion}.`, 'ok');
        break;
      case 'available': {
        setStatus(`Version ${result.version} is available.`, 'ok');
        const notes = notesBlock(result.notes);
        if (notes) detail.append(notes);
        detail.append(downloadButton(result.version, result.size));
        break;
      }
      case 'shell-required': {
        setStatus(result.message, 'fail');
        detail.append(h('div', 'hint',
          'This one changes the app shell, so it ships as a new exe instead of an over-the-air payload.'));
        detail.append(btnRow(releasesButton(result.htmlUrl, `Get ROGGER ${result.version}`)));
        break;
      }
      case 'no-payload':
        setStatus(result.message ?? `Version ${result.version} is available as a download.`, 'ok');
        detail.append(btnRow(releasesButton(result.htmlUrl, `Get ROGGER ${result.version}`)));
        break;
      case 'unsupported':
        setStatus('Updates are only available in the packaged app.', null);
        break;
      case 'error':
      default:
        setStatus(result.message ?? 'Update check failed.', 'fail');
        break;
    }
  }

  function render() {
    renderVersions();
    renderControls();
    renderDetail();
  }

  async function runCheck() {
    setStatus('Checking GitHub…');
    const next = await rogger.updateCheck();
    info = next;
    result = next?.result ?? null;
    render();
  }

  (async () => {
    info = await rogger.updateInfo?.() ?? { supported: false, source: 'dev' };
    render();
  })();

  return { runCheck };
}

/**
 * Quiet check at boot. Only speaks up when there is something to act on, so a
 * console that lives on a venue's captive Wi-Fi stays silent about failures.
 */
export async function autoCheckOnLaunch() {
  try {
    const info = await rogger.updateInfo?.();
    if (!info?.supported || info.autoCheck === false || info.safeMode) return;
    if (info.quarantined?.length) {
      showToast(`Update ${info.quarantined.join(', ')} failed to start — rolled back`, { error: true });
    }
    if (info.staged) {
      showToast(`Version ${info.staged} is installed — restart to use it`);
      return;
    }
    const next = await rogger.updateCheck();
    const r = next?.result;
    if (r?.status === 'available') showToast(`ROGGER ${r.version} is available — Settings → Updates`);
    else if (r?.status === 'shell-required' || r?.status === 'no-payload') {
      showToast(`ROGGER ${r.version} is available as a download — Settings → Updates`);
    }
  } catch {
    // An update check must never be the reason the surface fails to come up.
  }
}
