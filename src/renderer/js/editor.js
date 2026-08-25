// Button editor overlay: label / icon / color / mode / OSC address & values /
// repeat / macro for FX buttons; range settings for faders; color presets.
// Includes the OSC command library browser and OSC Learn.
import { rogger } from './bridge.js';
import * as state from './state.js';
import { showToast } from './toast.js';
import { placeholders, expand, search } from './osc-library.js';
import { BUTTON_NAMES, armGamepadLearn, disarmGamepadLearn } from './gamepad.js';
import { bindingLabel, stealBinding } from './gamepad-resolve.js';
import { h, field, textInput, numInput, textArea, checkRow, seg } from './dom.js';

const GLYPHS = ['◆', '●', '▲', '▼', '■', '◉', '✕', '⚡', '⏱', '↻', '⊘', '⏻',
  '★', '♪', '☰', '◐', '▶', '◀', '⏸', '⏹', '✦', '☄', '♦', '▩'];
const PALETTE = ['#00e0ff', '#ffb400', '#ff4757', '#2ee66b', '#b46bff',
  '#ff7a1a', '#eaeef5', '#3aa0ff', '#ff3df0', '#ffd93d'];
const KIND_TITLES = { fxButtons: 'FX BUTTON', fxButtons2: 'FX BUTTON P2', fxButtons3: 'DJ INTRO', utilButtons: 'UTILITY', faders: 'FADER', groupFaders: 'GROUP FADER', colorButtons: 'COLOR PRESET', colorTargets: 'COLOR TARGET' };

// int-family library kinds — anything else (event/int/bool/choice) becomes
// a plain int-typed FX button; only 'float' switches the button to float.
const INT_LIKE_KINDS = new Set(['event', 'int', 'bool', 'choice']);

function hexToRgb01(hex) {
  const h = String(hex || '#ffffff').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h.padStart(6, '0');
  const n = parseInt(full, 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
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
  const draft = kind === 'colorTargets'
    ? structuredClone(state.get().colorTargets.items[index])
    : structuredClone(state.get()[kind][index]);

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

  function libraryView(onPick, opts = {}) {
    body.innerHTML = '';
    const back = h('button', 'big-btn u-caps', '← Back');
    back.addEventListener('pointerdown', () => buildBody());
    body.appendChild(back);

    const searchWrap = h('div', 'field');
    const searchInput = textInput('', () => renderList());
    searchInput.placeholder = 'Search the command library…';
    searchWrap.append(h('label', null, 'Search'), searchInput);
    body.appendChild(searchWrap);

    const list = h('div', 'lib-list');
    body.appendChild(list);

    function renderList() {
      list.innerHTML = '';
      let entries = search(searchInput.value);
      if (opts.floatOnly) entries = entries.filter(entry => entry.kind === 'float');
      let currentGroup = null;
      for (const entry of entries) {
        if (entry.group !== currentGroup) {
          currentGroup = entry.group;
          list.appendChild(h('div', 'lib-group-title u-caps', currentGroup));
        }
        const e = h('button', 'lib-entry');
        const box = h('div');
        box.append(h('div', null, entry.label), h('div', 'lib-addr u-num', entry.address));
        if (entry.hint) box.append(h('div', 'lib-hint', entry.hint));
        e.appendChild(box);
        list.appendChild(e);
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
      if (!entries.length) list.appendChild(h('div', 'hint', 'No matching commands.'));
    }
    renderList();
  }

  function addressBlock(applyLearn, opts = {}) {
    const wrap = h('div', 'field');
    wrap.append(h('label', null, 'OSC address'));
    const input = textInput(draft.address, v => { draft.address = v; });
    input.id = 'ed-address';
    wrap.appendChild(input);
    const row = h('div', 'row');
    const lib = h('button', 'big-btn u-caps', 'Library');
    lib.addEventListener('pointerdown', () => libraryView((address, entry) => {
      draft.address = address;
      opts.onPickEntry?.(entry);
      buildBody();
    }, { floatOnly: opts.floatOnly }));
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
    }, {
      onPickEntry: entry => {
        if (entry.kind === 'float') draft.type = 'float';
        else if (INT_LIKE_KINDS.has(entry.kind)) draft.type = 'int';
      },
    }));
    const extra = textInput(draft.extraAddress ?? '', v => { draft.extraAddress = v.trim(); });
    extra.placeholder = '/optional/mirror/address';
    body.append(field('Mirror to (optional second address)', extra));
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

    // Modifier: hold this pad button while pressing the one above to fire
    // this binding instead of that button's plain one.
    const modWrap = h('div', 'field');
    modWrap.append(h('label', null, 'Modifier (hold with)'));
    const modRow = h('div', 'glyph-row');
    function modBtn(labelText, val) {
      const mb = h('button', 'pad-pick', labelText);
      mb.classList.toggle('on', (draft.gamepadModifier ?? -1) === val);
      mb.addEventListener('pointerdown', () => {
        draft.gamepadModifier = val;
        modRow.querySelectorAll('.on').forEach(x => x.classList.remove('on'));
        mb.classList.add('on');
      });
      return mb;
    }
    modRow.append(modBtn('NONE', -1), ...BUTTON_NAMES.map((n, bi) => modBtn(n, bi)));
    modWrap.appendChild(modRow);
    body.append(padWrap, modWrap);
    body.append(h('div', 'hint',
      'A modifier held alone still fires its own binding; only the second button changes.'));

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
      armGamepadLearn((bi, modifier) => {
        draft.gamepadButton = bi;
        draft.gamepadModifier = modifier ?? -1;
        disarmGamepadLearn();
        buildBody();
        showToast(`Bound to ${bindingLabel(BUTTON_NAMES, bi, draft.gamepadModifier)}`);
      });
    });
    body.append(padLearn);

    body.append(checkRow('Repeat while held', draft.repeat?.enabled ?? false,
      v => { draft.repeat = { ...draft.repeat, enabled: v }; }));
    body.append(checkRow('Sync repeat to tapped BPM', draft.repeat?.sync ?? false,
      v => { draft.repeat = { ...draft.repeat, sync: v }; }));
    body.append(field('Repeat interval (ms, fallback when unsynced)',
      numInput(draft.repeat?.intervalMs ?? 250, v => { draft.repeat = { ...draft.repeat, intervalMs: v }; }, '1')));

    macroSection(body, draft);
  }

  function faderForm() {
    body.append(field('Label', textInput(draft.label, v => { draft.label = v; })));
    body.append(field('Color', pickRow(PALETTE, 'swatch-pick', draft.color,
      (b, c) => b.style.setProperty('--sw', c), c => { draft.color = c; })));
    body.append(field('Orientation', seg(
      [{ v: 'v', label: 'V' }, { v: 'h', label: 'H' }],
      draft.orientation ?? 'v', v => { draft.orientation = v; })));
    body.append(addressBlock(msg => { draft.address = msg.address; }, { floatOnly: true }));
    const extra = textInput(draft.extraAddress ?? '', v => { draft.extraAddress = v.trim(); });
    extra.placeholder = '/optional/mirror/address';
    body.append(field('Mirror to (optional second address)', extra));
    body.append(field('Further mirror addresses (one per line)',
      textArea((draft.extraAddresses ?? []).join('\n'),
        v => { draft.extraAddresses = v.split('\n').map(s => s.trim()).filter(Boolean); },
        '/composition/.../another/target')));
    const range = h('div', 'row');
    range.append(
      field('Min', numInput(draft.min, v => { draft.min = v; })),
      field('Max', numInput(draft.max, v => { draft.max = v; })),
      field('Default', numInput(draft.defaultValue, v => { draft.defaultValue = v; })));
    body.append(range);
    body.append(checkRow('Invert direction', draft.invert, v => { draft.invert = v; }));
    body.append(field('Sensitivity (1 = absolute, <1 = fine relative)',
      numInput(draft.sensitivity, v => { draft.sensitivity = v; }, '0.05')));
    body.append(checkRow('Beat sync enabled (♪ button)', draft.beatSync?.enabled ?? false,
      v => { draft.beatSync = { ...draft.beatSync, enabled: v }; buildBody(); }));
    if (draft.beatSync?.enabled) {
      body.append(checkRow('Auto-follow every beat change', draft.beatSync?.auto ?? false,
        v => { draft.beatSync = { ...draft.beatSync, auto: v }; }));
      body.append(field('BPM at fader value 1',
        numInput(draft.beatSync?.bpmAt1 ?? 300, v => { draft.beatSync = { ...draft.beatSync, bpmAt1: v }; }, '1')));
    }
  }

  function colorForm() {
    body.append(field('Label', textInput(draft.label, v => { draft.label = v; })));
    body.append(field('Swatch color', pickRow(PALETTE, 'swatch-pick', draft.color,
      (b, c) => b.style.setProperty('--sw', c), c => { draft.color = c; })));
    body.append(field('Custom color (hex)', textInput(draft.color, v => { draft.color = v; })));

    body.append(checkRow('Route through active color target (RGB)', Array.isArray(draft.rgb),
      v => {
        draft.rgb = v ? (draft.rgb ?? hexToRgb01(draft.color)) : null;
        buildBody();
      }));

    if (Array.isArray(draft.rgb)) {
      const useSwatch = h('button', 'big-btn u-caps', 'Use swatch color');
      useSwatch.addEventListener('pointerdown', () => {
        draft.rgb = hexToRgb01(draft.color);
        buildBody();
      });
      body.append(useSwatch);
      const rgbRow = h('div', 'row');
      ['R', 'G', 'B'].forEach((ch, idx) => {
        rgbRow.append(field(ch, numInput(draft.rgb[idx], v => { draft.rgb[idx] = v; }, '0.01')));
      });
      body.append(rgbRow);
    }

    body.append(checkRow('OFF button (fires the active target\'s off steps)', draft.isOff ?? false,
      v => { draft.isOff = v; buildBody(); }));

    if (!Array.isArray(draft.rgb) && !draft.isOff) {
      body.append(addressBlock(msg => {
        draft.address = msg.address;
        if (msg.args?.length) draft.args = msg.args.map(a => a.value);
      }));
      body.append(field('Arguments (comma separated)',
        textInput((draft.args ?? []).join(', '), v => { draft.args = parseCsvValues(v); })));
      macroSection(body, draft);
    }
  }

  function colorTargetForm() {
    body.append(field('Label', textInput(draft.label, v => { draft.label = v; })));
    body.append(field('Swatch color', pickRow(PALETTE, 'swatch-pick', draft.swatch,
      (b, c) => b.style.setProperty('--sw', c), c => { draft.swatch = c; })));
    body.append(field('Custom swatch (hex)', textInput(draft.swatch, v => { draft.swatch = v; })));
    body.append(field('Color bases (one OSC base address per line)',
      textArea((draft.colorBases ?? []).join('\n'),
        v => { draft.colorBases = v.split('\n').map(s => s.trim()).filter(Boolean); },
        '/composition/.../effect/color')));

    function stepsSection(title, key) {
      body.append(h('div', 'lib-group-title u-caps', title));
      const box = h('div');
      body.appendChild(box);
      function renderSteps() {
        box.replaceChildren();
        (draft[key] ?? []).forEach((step, si) => {
          const row = h('div', 'macro-row');
          const addr = textInput(step.address, v => { step.address = v; });
          addr.placeholder = '/address';
          const vals = textInput((step.values ?? []).join(', '), v => { step.values = parseCsvValues(v); });
          vals.placeholder = 'values, comma separated';
          const del = h('button', 'macro-del', '✕');
          del.addEventListener('pointerdown', () => { draft[key].splice(si, 1); renderSteps(); });
          row.append(addr, vals, del);
          box.appendChild(row);
        });
        const add = h('button', 'big-btn u-caps', `+ Add step`);
        add.addEventListener('pointerdown', () => {
          draft[key] = draft[key] ?? [];
          draft[key].push({ address: '/', values: [1] });
          renderSteps();
        });
        box.appendChild(add);
      }
      renderSteps();
    }
    stepsSection('On steps (fired by RGB presets)', 'onSteps');
    stepsSection('Off steps (fired by the OFF preset)', 'offSteps');
  }

  function buildBody() {
    cleanupLearn();
    body.innerHTML = '';
    if (kind.startsWith('fxButtons') || kind === 'utilButtons') fxForm();
    else if (kind === 'faders' || kind === 'groupFaders') faderForm();
    else if (kind === 'colorTargets') colorTargetForm();
    else colorForm();
  }
  buildBody();

  const cancel = h('button', 'big-btn u-caps', 'Cancel');
  cancel.id = 'ed-cancel';
  cancel.addEventListener('pointerdown', close);
  const save = h('button', 'big-btn primary u-caps', 'Save');
  save.id = 'ed-save';
  save.addEventListener('pointerdown', () => {
    if ((kind.startsWith('fxButtons') || kind === 'utilButtons') && draft.gamepadButton >= 0) {
      // one (button, modifier) pair drives one FX button — steal that exact
      // pair across pages; a plain A binding survives adding RT+A elsewhere
      stealBinding(state.get(), kind, index, draft.gamepadButton, draft.gamepadModifier ?? -1);
    }
    if (kind === 'colorTargets') {
      state.replaceColorTarget(index, draft);
    } else {
      state.replaceControl(kind, index, draft);
      // orientation/address changes need the fader rack rebuilt, not just
      // its per-element label/value refreshed — renderFaders/renderFaderSet
      // are re-entrant (they clear their root first), so a full re-render
      // is safe and simplest here.
      if (kind === 'faders' || kind === 'groupFaders') state.requestRerender();
    }
    showToast(`${KIND_TITLES[kind]} ${index + 1} saved`);
    close();
  });
  foot.append(cancel, save);
}
