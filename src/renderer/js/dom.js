// Shared DOM builders for the overlay panels (editor, settings, updates).
// These were duplicated verbatim in editor.js and settings.js; keeping one
// copy means a touch-target or styling fix lands everywhere at once.

export function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function field(label, input) {
  const f = h('div', 'field');
  f.append(h('label', null, label), input);
  return f;
}

export function textInput(value, oninput, placeholder) {
  const i = h('input');
  i.type = 'text';
  i.value = value ?? '';
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener('input', () => oninput(i.value));
  return i;
}

export function numInput(value, oninput, step = 'any') {
  const i = h('input');
  i.type = 'number';
  i.step = step;
  i.value = value ?? 0;
  i.addEventListener('input', () => oninput(Number(i.value)));
  return i;
}

export function textArea(value, oninput, placeholder) {
  const t = document.createElement('textarea');
  t.value = value ?? '';
  if (placeholder) t.placeholder = placeholder;
  t.addEventListener('input', () => oninput(t.value));
  return t;
}

export function checkRow(label, on, onchange) {
  const r = h('div', 'check-row');
  const t = h('button', 'toggle');
  t.classList.toggle('on', on);
  t.addEventListener('pointerdown', () => {
    const v = !t.classList.contains('on');
    t.classList.toggle('on', v);
    onchange(v);
  });
  r.append(h('span', null, label), t);
  return r;
}

export function seg(options, current, onpick) {
  const s = h('div', 'seg');
  const btns = options.map(o => {
    const b = h('button', null, o.label);
    b.classList.toggle('on', o.v === current);
    b.addEventListener('pointerdown', () => {
      btns.forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      onpick(o.v);
    });
    s.appendChild(b);
    return b;
  });
  return s;
}

export function row2(a, b) {
  const r = h('div', 'row');
  r.append(a, b);
  return r;
}

export function btnRow(...btns) {
  const r = h('div', 'row');
  r.append(...btns);
  return r;
}

/**
 * Full-panel list picker, used where a native <select> would be wrong: it
 * matches the console chrome, gives every row a finger-sized target, and shows
 * long entries (audio device names run to 40+ characters) in full instead of
 * cutting them off inside a fixed-width control.
 *
 * @param {object} opts
 * @param {string} opts.title    panel heading
 * @param {Array<{value: string, label: string, detail?: string}>} opts.items
 * @param {string} [opts.current] value to mark as selected
 * @param {string} [opts.empty]   message shown when there is nothing to pick
 * @returns {Promise<string|null>} the chosen value, or null if dismissed
 */
export function pickFromList({ title, items, current, empty }) {
  return new Promise(resolve => {
    const root = document.getElementById('overlay-root');
    const overlay = h('div', 'overlay');
    overlay.classList.add('overlay--pick');
    const panel = h('div', 'panel');
    const body = h('div', 'panel-body');
    const foot = h('div', 'panel-foot');
    panel.append(h('div', 'panel-head u-caps', title), body, foot);
    overlay.appendChild(panel);

    let settled = false;
    const close = value => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(value);
    };

    if (!items.length) {
      body.append(h('div', 'hint', empty ?? 'Nothing to choose from.'));
    }
    for (const item of items) {
      const row = h('button', 'pick-row');
      row.classList.toggle('on', item.value === current);
      row.append(h('span', 'pick-row-label', item.label));
      if (item.detail) row.append(h('span', 'pick-row-detail', item.detail));
      row.addEventListener('pointerdown', () => close(item.value));
      body.appendChild(row);
    }

    const cancel = h('button', 'big-btn u-caps', 'Cancel');
    cancel.addEventListener('pointerdown', () => close(null));
    foot.appendChild(cancel);
    // Tapping the scrim is the same as cancelling — the panel itself must not
    // pass the tap through.
    overlay.addEventListener('pointerdown', e => { if (e.target === overlay) close(null); });

    root.appendChild(overlay);
  });
}
