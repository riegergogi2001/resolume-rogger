// Settings overlay: OSC target, ports, auto connect/reconnect, test, save.
import { rogger } from './bridge.js';
import * as state from './state.js';
import { showToast } from './toast.js';

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function openSettings() {
  const root = document.getElementById('overlay-root');
  if (root.querySelector('.overlay')) return;
  const n = state.get().network;

  const overlay = el(`
    <div class="overlay" id="settings-overlay">
      <div class="panel">
        <div class="panel-head u-caps">Settings</div>
        <div class="panel-body">
          <div class="field"><label>OSC target IP</label><input type="text" id="set-ip"></div>
          <div class="row">
            <div class="field"><label>Target port</label><input type="number" id="set-port"></div>
            <div class="field"><label>Listen port (learn / feedback)</label><input type="number" id="set-listen"></div>
          </div>
          <div class="check-row"><span>Auto connect on launch</span><button class="toggle" id="set-autoconnect"></button></div>
          <div class="check-row"><span>Auto reconnect</span><button class="toggle" id="set-autoreconnect"></button></div>
          <div class="check-row"><span>Dark theme</span><button class="toggle on" id="set-theme" disabled></button></div>
          <div class="row"><button class="big-btn" id="set-test">Test connection</button></div>
          <div class="test-result" id="set-test-result"></div>
          <div class="row"><button class="big-btn danger" id="set-reset">Reload default mapping</button></div>
        </div>
        <div class="panel-foot">
          <button class="big-btn danger" id="set-exit">Exit app</button>
          <button class="big-btn" id="set-close">Close</button>
          <button class="big-btn primary" id="set-save">Save</button>
        </div>
      </div>
    </div>`);
  root.appendChild(overlay);
  const q = s => overlay.querySelector(s);

  q('#set-ip').value = n.targetIp;
  q('#set-port').value = n.targetPort;
  q('#set-listen').value = n.listenPort;

  const tstate = { autoConnect: n.autoConnect, autoReconnect: n.autoReconnect };
  for (const [key, id] of [['autoConnect', '#set-autoconnect'], ['autoReconnect', '#set-autoreconnect']]) {
    const btn = q(id);
    btn.classList.toggle('on', tstate[key]);
    btn.addEventListener('pointerdown', () => {
      tstate[key] = !tstate[key];
      btn.classList.toggle('on', tstate[key]);
    });
  }

  q('#set-test').addEventListener('pointerdown', async () => {
    const res = q('#set-test-result');
    res.textContent = 'Testing…';
    res.className = 'test-result';
    const { ok, detail } = await rogger.testConnection();
    res.textContent = detail;
    res.className = 'test-result ' + (ok ? 'ok' : 'fail');
  });

  q('#set-reset').addEventListener('pointerdown', async () => {
    const cfg = await rogger.resetConfig();
    state.setAll(cfg);
    showToast('Default mapping restored');
    overlay.remove();
  });

  q('#set-save').addEventListener('pointerdown', async () => {
    const patch = {
      targetIp: q('#set-ip').value.trim(),
      targetPort: Number(q('#set-port').value) || 7000,
      listenPort: Number(q('#set-listen').value) || 7001,
      autoConnect: tstate.autoConnect,
      autoReconnect: tstate.autoReconnect,
    };
    state.updateNetwork(patch);
    await rogger.applyNetwork(patch);
    showToast('Settings saved');
    overlay.remove();
  });

  q('#set-close').addEventListener('pointerdown', () => overlay.remove());
  q('#set-exit').addEventListener('pointerdown', () => rogger.quit());
}
