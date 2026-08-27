// In-page confirmation. window.confirm() is a native modal: inside a
// fullscreen kiosk window on a touch handheld it is exactly the thing that
// fails to appear or to return, and the operator is left with a dead button.
// This one is DOM, uses `click` like every panel control, and resolves a
// boolean. Test hooks: #confirm-overlay, .confirm-text, #confirm-ok,
// #confirm-cancel.
import { h } from './dom.js';

export function confirmDialog(message, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const root = document.getElementById('overlay-root') ?? document.body;
    const overlay = h('div', 'overlay confirm-overlay');
    overlay.id = 'confirm-overlay';
    const panel = h('div', 'confirm-panel');
    const text = h('div', 'confirm-text', message);
    const row = h('div', 'row');
    const no = h('button', 'big-btn u-caps', cancel);
    no.id = 'confirm-cancel';
    const yes = h('button', `big-btn u-caps ${danger ? 'danger' : 'primary'}`, ok);
    yes.id = 'confirm-ok';
    const done = v => { overlay.remove(); resolve(v); };
    no.addEventListener('click', () => done(false));
    yes.addEventListener('click', () => done(true));
    row.append(no, yes);
    panel.append(text, row);
    overlay.appendChild(panel);
    root.appendChild(overlay);
  });
}
