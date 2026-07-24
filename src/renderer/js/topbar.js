// Top bar: wordmark, OSC target readout, status lamp, EDIT latch, settings.
import { rogger } from './bridge.js';
import * as state from './state.js';

export function renderTopbar(el, { onToggleEdit, onOpenSettings }) {
  el.innerHTML = '';
  const mark = document.createElement('div');
  mark.className = 'wordmark';
  mark.innerHTML = 'R<b>O</b>GGER';

  const target = document.createElement('div');
  target.className = 'target-readout u-num';

  const spacer = document.createElement('div');
  spacer.className = 'topbar-spacer';

  const pill = document.createElement('div');
  pill.className = 'status-pill u-caps';
  pill.dataset.status = 'offline';
  pill.innerHTML = '<span class="dot"></span><span class="status-text">OFFLINE</span>';

  const edit = document.createElement('button');
  edit.className = 'topbar-btn u-caps';
  edit.id = 'edit-toggle';
  edit.textContent = 'Edit';
  edit.addEventListener('pointerdown', () => {
    const on = onToggleEdit();
    edit.classList.toggle('latched', on);
  });

  const gear = document.createElement('button');
  gear.className = 'topbar-btn';
  gear.id = 'settings-open';
  gear.setAttribute('aria-label', 'Settings');
  gear.textContent = '⚙';
  gear.addEventListener('pointerdown', onOpenSettings);

  el.append(mark, target, spacer, pill, edit, gear);

  function refreshTarget() {
    const n = state.get().network;
    target.textContent = `${n.targetIp}:${n.targetPort}`;
  }
  refreshTarget();
  state.subscribe(refreshTarget);

  function setStatus(s) {
    pill.dataset.status = s;
    pill.querySelector('.status-text').textContent = s.toUpperCase();
  }
  rogger.getStatus().then(setStatus);
  rogger.onStatus(setStatus);
}
