// Button editor overlay: label / icon / color / mode / OSC address & values /
// repeat / macro for FX buttons; range settings for faders; color presets.
// Includes the OSC command library browser and OSC Learn.
import { rogger } from './bridge.js';
import * as state from './state.js';
import { showToast } from './toast.js';
import { LIBRARY, placeholders, expand } from './osc-library.js';
import { BUTTON_NAMES, armGamepadLearn, disarmGamepadLearn } from './gamepad.js';

const GLYPHS = ['◆', '●', '▲', '▼', '■', '◉', '✕', '⚡', '⏱', '↻', '⊘', '⏻',
  '★', '♪', '☰', '◐', '▶', '◀', '⏸', '⏹', '✦', '☄', '♦', '▩'];
const PALETTE = ['#00e0ff', '#ffb400', '#ff4757', '#2ee66b', '#b46bff',
  '#ff7a1a', '#eaeef5', '#3aa0ff', '#ff3df0', '#ffd93d'];
const KIND_TITLES = { fxButtons: 'FX BUTTON', fxButtons2: 'FX BUTTON P2', faders: 'FADER', colorButtons: 'COLOR PRESET' };

function h(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function field(label, input) {
  const f = h('div', 'field');
  f.append(h('label', null, label), input);
  return f;
}
function textInput(value, oninput) {
  const i = h('input');
  i.type = 'text';
  i.value = value ?? '';
  i.addEventListener('input', () => oninput(i.value));
  return i;
}
function numInput(value, oninput, step = 'any') {
  const i = h('input');
  i.type = 'number';
  i.step = step;
  i.value = value ?? 0;
  i.addEventListener('input', () => oninput(Number(i.value)));
  return i;
}
function seg(options, current, onpick) {
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
function checkRow(label, on, onchange) {
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
function pickRow(items, cls, current, decorate, onpick) {
  const r = h('div', cls === 'swatch-pick' ? 'swatch-row' : 'glyph-row');
  items.forEach(item => {
    const b = h('button', cls);
    decorate(b, item);
    b.classList.toggle('on', item === current);
    b.addEventListener('pointerdown', () => {
      r.querySelectorAll('.on').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      onpick(item);
    });
    r.appendChild(b);
  });
  return r;
}

function parseCsvValues(text) {
  return text.split(',').map(s => s.trim()).filter(s => s.length)
    .map(s => (Number.isNaN(Number(s)) ? s : Number(s)));
}

function macroSection(body, draft) {
  body.append(h('div', 'lib-group-title u-caps', 'Macro (overrides single message)'));
  const macroBox = h('div');
  body.appendChild(macroBox);
  function renderMacro() {
    macroBox.replaceChildren();
    (draft.macro ?? []).forEach((step, mi) => {
      const row = h('div', 'macro-row');
      const addr = textInput(step.address, v => { step.address = v; });
      addr.placeholder = '/address';
      const vals = textInput((step.values ?? []).join(', '), v => { step.values = parseCsvValues(v); });
      vals.placeholder = 'values, comma separated';
      const del = h('button', 'macro-del', '✕');
      del.addEventListener('pointerdown', () => { draft.macro.splice(mi, 1); renderMacro(); });
      row.append(addr, vals, del);
      macroBox.appendChild(row);
    });
    const add = h('button', 'big-btn u-caps', '+ Add macro step');
    add.addEventListener('pointerdown', () => {
      draft.macro = draft.macro ?? [];
      draft.macro.push({ address: '/', values: [1] });
      renderMacro();
    });
    macroBox.appendChild(add);
  }
  renderMacro();
}

export function openEditor(kind, index) {
  const root = document.getElementById('overlay-root');
  if (root.querySelector('.overlay')) return;
  const draft = structuredClone(state.get()[kind][index]);

  const overlay = h('div', 'overlay');
  overlay.id = 'editor-overlay';
  const panel = h('div', 'panel');
  const head = h('div', 'panel-head u-caps', `Edit — ${KIND_TITLES[kind]} ${index + 1}`);
  const body = h('div', 'panel-body');
  const foot = h('div', 'panel-foot');
  panel.append(head, body, foot);
  overlay.appendChild(panel);
  root.appendChild(overlay);

  let unlearn = null;
  function cleanupLearn() {
    rogger.disarmLearn();
    disarmGamepadLearn();
    if (unlearn) { unlearn(); unlearn = null; }
    body.querySelector('.learn-btn')?.classList.remove('listening');
  }
  function close() {
    cleanupLearn();
    overlay.remove();
  }

  function learnButton(applyMsg) {
    const b = h('button', 'big-btn learn-btn u-caps', 'Learn');
    b.addEventListener('pointerdown', () => {
      if (b.classList.contains('listening')) {
        cleanupLearn();
        b.textContent = 'LEARN';
        return;
      }
      b.classList.add('listening');
      b.textContent = 'LISTENING…';
      rogger.armLearn();
      unlearn = rogger.onLearn(msg => {
        applyMsg(msg);
        cleanupLearn();
        buildBody();
        showToast(`Learned ${msg.address}`);
      });
    });
    return b;
  }

  function libraryView(onPick) {
    body.innerHTML = '';
    const back = h('button', 'big-btn u-caps', '← Back');
    back.addEventListener('pointerdown', () => buildBody());
    body.appendChild(back);
    let currentGroup = null;
    for (const entry of LIBRARY) {
      if (entry.group !== currentGroup) {
        currentGroup = entry.group;
        body.appendChild(h('div', 'lib-group-title u-caps', currentGroup));
      }
      const e = h('button', 'lib-entry');
      const box = h('div');
      box.append(h('div', null, entry.label), h('div', 'lib-addr u-num', entry.address));
      e.appendChild(box);
      body.appendChild(e);
      e.addEventListener('pointerdown', () => {
        const keys = placeholders(entry.address);
        if (!keys.length) { onPick(entry.address, entry); return; }
        // inline placeholder substitution
        e.replaceChildren();
        const subs = {};
        for (const k of keys) {
          const lbl = h('span', 'lib-addr', k);
          const inp = numInput(1, v => { subs[k] = v; }, '1');
          inp.style.width = '80px';
          subs[k] = 1;
          e.append(lbl, inp);
        }
        const apply = h('button', 'big-btn primary', 'APPLY');
        apply.style.maxWidth = '120px';
        apply.addEventListener('pointerdown', ev => {
          ev.stopPropagation();
          onPick(expand(entry.address, subs), entry);
        });
        e.appendChild(apply);
      });
    }
  }

  function addressBlock(applyLearn) {
    const wrap = h('div', 'field');
    wrap.append(h('label', null, 'OSC address'));
    const input = textInput(draft.address, v => { draft.address = v; });
    input.id = 'ed-address';
    wrap.appendChild(input);
    const row = h('div', 'row');
    const lib = h('button', 'big-btn u-caps', 'Library');
    lib.addEventListener('pointerdown', () => libraryView((address, entry) => {
      draft.address = address;
      if (kind === 'fxButtons' && entry.float) draft.type = 'float';
      buildBody();
    }));
    row.append(lib, learnButton(applyLearn));
    wrap.appendChild(row);
    return wrap;
  }

  function fxForm() {
    body.append(field('Label', textInput(draft.label, v => { draft.label = v; })));
    body.append(field('Icon', pickRow(GLYPHS, 'glyph-pick', draft.icon,
      (b, g) => { b.textContent = g; }, g => { draft.icon = g; })));
    body.append(field('Color', pickRow(PALETTE, 'swatch-pick', draft.color,
      (b, c) => b.style.setProperty('--sw', c), c => { draft.color = c; })));
    body.append(field('Mode', seg(
      [{ v: 'tap', label: 'TAP' }, { v: 'toggle', label: 'TOGGLE' }, { v: 'hold', label: 'HOLD' }],
      draft.mode, v => { draft.mode = v; buildBody(); })));
    body.append(field('Value type', seg(
      [{ v: 'command', label: 'COMMAND' }, { v: 'int', label: 'INT' }, { v: 'float', label: 'FLOAT' }],
      draft.type, v => { draft.type = v; buildBody(); })));
    body.append(addressBlock(msg => {
      draft.address = msg.address;
      const a = msg.args?.[0];
      if (a && (a.type === 'i' || a.type === 'f')) {
        draft.type = a.type === 'f' ? 'float' : 'int';
        draft.value = a.value;
      }
    }));
    if (draft.type !== 'command') {
      const vals = h('div', 'row');
      vals.append(field(draft.mode === 'toggle' ? 'On value' : 'Value',
        numInput(draft.value, v => { draft.value = v; })));
      if (draft.mode === 'toggle') {
        vals.append(field('Off value', numInput(draft.offValue, v => { draft.offValue = v; })));
      }
      if (draft.mode === 'hold') {
        vals.append(field('Release value', numInput(draft.releaseValue, v => { draft.releaseValue = v; })));
      }
      body.append(vals);
    }
    if (draft.mode === 'hold') {
      const rel = textInput(draft.releaseAddress ?? '', v => { draft.releaseAddress = v.trim(); });
      rel.placeholder = 'same as OSC address';
      body.append(field('Release address (optional)', rel));
      body.append(checkRow('Ramp while held (value sweep)', draft.ramp?.enabled ?? false,
        v => { draft.ramp = { ...draft.ramp, enabled: v }; }));
      const rrow = h('div', 'row');
      rrow.append(
        field('Ramp from', numInput(draft.ramp?.from ?? 0, v => { draft.ramp = { ...draft.ramp, from: v }; })),
        field('Ramp to', numInput(draft.ramp?.to ?? 1, v => { draft.ramp = { ...draft.ramp, to: v }; })),
        field('Ramp time (ms)', numInput(draft.ramp?.durationMs ?? 1500,
          v => { draft.ramp = { ...draft.ramp, durationMs: v }; }, '1')));
      body.append(rrow);
    }
    // controller binding (ROG Ally X gamepad)
    const padWrap = h('div', 'field');
    padWrap.append(h('label', null, 'Controller button'));
    const padRow = h('div', 'glyph-row');
    function padBtn(labelText, val) {
      const pb = h('button', 'pad-pick', labelText);
      pb.classList.toggle('on', draft.gamepadButton === val);
      pb.addEventListener('pointerdown', () => {
        draft.gamepadButton = val;
        padRow.querySelectorAll('.on').forEach(x => x.classList.remove('on'));
        pb.classList.add('on');
      });
      return pb;
    }
    padRow.append(padBtn('NONE', -1), ...BUTTON_NAMES.map((n, bi) => padBtn(n, bi)));
    padWrap.appendChild(padRow);
    const padLearn = h('button', 'big-btn learn-btn u-caps', 'Gamepad learn');
    padLearn.addEventListener('pointerdown', () => {
      if (padLearn.classList.contains('listening')) {
        disarmGamepadLearn();
        padLearn.classList.remove('listening');
        padLearn.textContent = 'GAMEPAD LEARN';
        return;
      }
      padLearn.classList.add('listening');
      padLearn.textContent = 'PRESS A CONTROLLER BUTTON…';
      armGamepadLearn(bi => {
        draft.gamepadButton = bi;
        disarmGamepadLearn();
        buildBody();
        showToast(`Bound to ${BUTTON_NAMES[bi]}`);
      });
    });
    padWrap.appendChild(padLearn);
    body.append(padWrap);

    body.append(checkRow('Repeat while held', draft.repeat?.enabled ?? false,
      v => { draft.repeat = { ...draft.repeat, enabled: v }; }));
    body.append(field('Repeat interval (ms)',
      numInput(draft.repeat?.intervalMs ?? 250, v => { draft.repeat = { ...draft.repeat, intervalMs: v }; }, '1')));

    macroSection(body, draft);
  }

  function faderForm() {
    body.append(field('Label', textInput(draft.label, v => { draft.label = v; })));
    body.append(field('Color', pickRow(PALETTE, 'swatch-pick', draft.color,
      (b, c) => b.style.setProperty('--sw', c), c => { draft.color = c; })));
    body.append(addressBlock(msg => { draft.address = msg.address; }));
    const range = h('div', 'row');
    range.append(
      field('Min', numInput(draft.min, v => { draft.min = v; })),
      field('Max', numInput(draft.max, v => { draft.max = v; })),
      field('Default', numInput(draft.defaultValue, v => { draft.defaultValue = v; })));
    body.append(range);
    body.append(checkRow('Invert direction', draft.invert, v => { draft.invert = v; }));
    body.append(field('Sensitivity (1 = absolute, <1 = fine relative)',
      numInput(draft.sensitivity, v => { draft.sensitivity = v; }, '0.05')));
  }

  function colorForm() {
    body.append(field('Label', textInput(draft.label, v => { draft.label = v; })));
    body.append(field('Swatch color', pickRow(PALETTE, 'swatch-pick', draft.color,
      (b, c) => b.style.setProperty('--sw', c), c => { draft.color = c; })));
    body.append(field('Custom color (hex)', textInput(draft.color, v => { draft.color = v; })));
    body.append(addressBlock(msg => {
      draft.address = msg.address;
      if (msg.args?.length) draft.args = msg.args.map(a => a.value);
    }));
    body.append(field('Arguments (comma separated)',
      textInput((draft.args ?? []).join(', '), v => { draft.args = parseCsvValues(v); })));
    macroSection(body, draft);
  }

  function buildBody() {
    cleanupLearn();
    body.innerHTML = '';
    if (kind.startsWith('fxButtons')) fxForm();
    else if (kind === 'faders') faderForm();
    else colorForm();
  }
  buildBody();

  const cancel = h('button', 'big-btn u-caps', 'Cancel');
  cancel.id = 'ed-cancel';
  cancel.addEventListener('pointerdown', close);
  const save = h('button', 'big-btn primary u-caps', 'Save');
  save.id = 'ed-save';
  save.addEventListener('pointerdown', () => {
    if (kind.startsWith('fxButtons') && draft.gamepadButton >= 0) {
      // one controller button drives one FX button — steal the binding across pages
      for (const k of ['fxButtons', 'fxButtons2']) {
        state.get()[k]?.forEach((c, j) => {
          if (!(k === kind && j === index) && c.gamepadButton === draft.gamepadButton) {
            c.gamepadButton = -1;
          }
        });
      }
    }
    state.replaceControl(kind, index, draft);
    showToast(`${KIND_TITLES[kind]} ${index + 1} saved`);
    close();
  });
  foot.append(cancel, save);
}
