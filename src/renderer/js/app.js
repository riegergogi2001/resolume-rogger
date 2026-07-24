// App bootstrap: load config, render surface, wire edit mode + overlays.
import { rogger } from './bridge.js';
import * as state from './state.js';
import { showToast } from './toast.js';
import { renderTopbar } from './topbar.js';
import { renderFxGrid } from './fx-grid.js';
import { renderFaders } from './faders.js';
import { renderColorRow } from './color-row.js';
import { openSettings } from './settings.js';
import { openEditor } from './editor.js';

let editMode = false;
const isEditMode = () => editMode;

async function boot() {
  await state.init();

  renderTopbar(document.getElementById('topbar'), {
    onToggleEdit: () => {
      editMode = !editMode;
      document.body.classList.toggle('edit-mode', editMode);
      return editMode;
    },
    onOpenSettings: () => openSettings(),
  });

  const opts = { isEditMode, onEdit: (kind, i) => openEditor(kind, i) };
  renderFxGrid(document.getElementById('fx-grid'), opts);
  renderFaders(document.getElementById('fader-rack'), opts);
  renderColorRow(document.getElementById('color-row'), opts);

  rogger.onOscError(msg => showToast(msg, { error: true }));
  document.body.dataset.ready = '1';
}

boot();
