// App bootstrap: load config, render surface, wire edit mode + overlays.
import { rogger } from './bridge.js';
import * as state from './state.js';
import { showToast } from './toast.js';
import { renderTopbar } from './topbar.js';
import { renderFxGrid, fxHandles, setPage } from './fx-grid.js';
import { startGamepad } from './gamepad.js';
import { renderFaders, faderHandles } from './faders.js';
import { renderColorRow, colorHandles } from './color-row.js';
import { openSettings } from './settings.js';
import { openEditor } from './editor.js';
import { startRemoteApi } from './remote-api.js';
import * as beat from './beat-clock.js';

let editMode = false;
const isEditMode = () => editMode;
const opts = { isEditMode, onEdit: (kind, i) => openEditor(kind, i) };

// Full-surface rebuild — used at boot, and any time something invalidates
// more than a single control's rendered label/value (fader orientation,
// hidden-pages toggle, a config import/reset). Re-registered as the state
// module's rerender hook so editor.js/settings.js can trigger it without
// importing app.js (which would create an import cycle).
function renderAll() {
  renderFxGrid(document.getElementById('fx-grid'), opts);
  renderFaders(document.getElementById('fader-rack'), opts);
  renderColorRow(document.getElementById('color-row'), opts);
}
export function rerender() { renderAll(); }

function tapAction() {
  rogger.sendTyped('/composition/tempocontroller/tempotap', [{ type: 'i', value: 1 }]);
  beat.tap();
  setTimeout(() => rogger.sendTyped('/composition/tempocontroller/tempotap', [{ type: 'i', value: 0 }]), 50);
}
function resyncAction() {
  rogger.sendTyped('/composition/tempocontroller/resync', [{ type: 'i', value: 1 }]);
  setTimeout(() => rogger.sendTyped('/composition/tempocontroller/resync', [{ type: 'i', value: 0 }]), 50);
}

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

  renderAll();
  state.setRerenderHandler(renderAll);

  startGamepad(fxHandles);
  startRemoteApi({ fxHandles, faderHandles, colorHandles, setPage, tap: tapAction, resync: resyncAction });
  rogger.onOscError(msg => showToast(msg, { error: true }));
  document.body.dataset.ready = '1';
}

boot();
