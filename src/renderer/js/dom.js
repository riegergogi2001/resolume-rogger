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
