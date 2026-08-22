#!/bin/bash
# Installs dist-ma3/ROGGER_MA3.xml as the active Resolume Arena DMX shortcut
# preset: copies the file into ~/Documents/Resolume Arena/Shortcuts/DMX/ and
# points activePresets.xml's DMXShortcutPreset attribute at it.
#
# Refuses to run while Resolume Arena is open — it reads its Shortcuts
# files at startup and holds them in memory, so editing them under a live
# process would either be ignored or get clobbered on next save. Quit
# Arena first.
#
# Usage: tools/install-resolume-preset.sh [path-to-ROGGER_MA3.xml] [--composition <file.avc>]
#   (defaults to dist-ma3/ROGGER_MA3.xml next to this script's repo root)
#
#   --composition <file.avc>  Also point a saved Resolume composition at the
#     installed preset by rewriting its DmxShortcutPreset Param, instead of
#     (or in addition to) selecting the preset by hand in Shortcuts > Edit
#     DMX. A Resolume composition stores its own
#     <Param name="DmxShortcutPreset" T="STRING" default="" value="..."/>
#     (plus separate Keyboard/Midi/Osc shortcut-preset Params, which this
#     flag never touches) and that value overrides
#     Shortcuts/activePresets.xml on load — so without this flag (or the
#     manual Shortcuts > Edit DMX > preset dropdown + Composition > Save
#     step) opening the composition can silently revert the DMX preset
#     selection made above. Backs up the file to <file.avc>.bak-<timestamp>
#     first and refuses to touch anything if the Param line isn't found.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SRC=""
COMPOSITION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --composition)
      COMPOSITION="${2:-}"
      if [ -z "$COMPOSITION" ]; then
        echo "error: --composition requires a path argument" >&2
        exit 1
      fi
      shift 2
      ;;
    --composition=*)
      COMPOSITION="${1#--composition=}"
      shift
      ;;
    *)
      if [ -z "$SRC" ]; then
        SRC="$1"
      fi
      shift
      ;;
  esac
done
SRC="${SRC:-$REPO_ROOT/dist-ma3/ROGGER_MA3.xml}"

RESOLUME_DIR="$HOME/Documents/Resolume Arena"
SHORTCUTS_DMX_DIR="$RESOLUME_DIR/Shortcuts/DMX"
ACTIVE_PRESETS="$RESOLUME_DIR/Shortcuts/activePresets.xml"
DMX_PREFS="$RESOLUME_DIR/Preferences/dmx.xml"

# Real process name, confirmed against /Applications/Resolume Arena/Arena.app/Contents/MacOS/Arena.
if pgrep -x "Arena" >/dev/null 2>&1 || pgrep -f "Resolume Arena" >/dev/null 2>&1; then
  echo "error: Resolume Arena is running — quit it first, then re-run this script." >&2
  echo "       (Arena reads Shortcuts/*.xml at startup; editing them live won't take effect" >&2
  echo "       and Arena's own autosave could overwrite these changes.)" >&2
  exit 1
fi

if [ ! -f "$SRC" ]; then
  echo "error: preset file not found: $SRC" >&2
  echo "       run 'python3 tools/gen-resolume-dmx-preset.py' first." >&2
  exit 1
fi

if [ ! -d "$SHORTCUTS_DMX_DIR" ]; then
  echo "error: $SHORTCUTS_DMX_DIR does not exist — is Resolume Arena installed for this user?" >&2
  exit 1
fi

if [ ! -f "$ACTIVE_PRESETS" ]; then
  echo "error: $ACTIVE_PRESETS not found." >&2
  exit 1
fi

PRESET_NAME="$(basename "$SRC" .xml)"
DEST="$SHORTCUTS_DMX_DIR/$(basename "$SRC")"

cp "$SRC" "$DEST"
echo "copied $SRC -> $DEST"

cp "$ACTIVE_PRESETS" "$ACTIVE_PRESETS.bak"
sed -i '' -E "s/DMXShortcutPreset=\"[^\"]*\"/DMXShortcutPreset=\"$PRESET_NAME\"/" "$ACTIVE_PRESETS"
echo "backed up $ACTIVE_PRESETS -> $ACTIVE_PRESETS.bak"
echo "set DMXShortcutPreset=\"$PRESET_NAME\" in $ACTIVE_PRESETS"

# Optionally make sure an Art-Net input exists in Preferences > DMX (live-
# verified on Resolume Arena 7.26: Preferences > DMX > New Input creates
# <Input Interface="ArtNet"/> under <Inputs>; a fresh/never-configured
# install has an empty self-closed <Inputs/>). We only ever ADD the input
# element here — bindAdapter (the "Network Adapter" dropdown) is never
# touched, since that has to be a real NIC on the LD's subnet and picking
# the wrong one silently breaks receiving (Resolume only listens on UDP
# 6454 once an input exists AND a valid adapter is selected).
if [ -f "$DMX_PREFS" ]; then
  if grep -q 'Interface="ArtNet"' "$DMX_PREFS"; then
    echo "Art-Net input already present in $DMX_PREFS — left it alone."
  elif grep -q '<Inputs/>' "$DMX_PREFS"; then
    cp "$DMX_PREFS" "$DMX_PREFS.bak"
    sed -i '' 's#<Inputs/>#<Inputs><Input Interface="ArtNet"/></Inputs>#' "$DMX_PREFS"
    echo "backed up $DMX_PREFS -> $DMX_PREFS.bak"
    echo "added an Art-Net input to $DMX_PREFS"
  else
    echo "note: $DMX_PREFS has a non-empty <Inputs> without Interface=\"ArtNet\" — left it alone, add it by hand in Preferences > DMX > New Input if needed."
  fi
else
  echo "note: $DMX_PREFS not found — Resolume will create it once you open Preferences > DMX."
fi
echo "IMPORTANT: in Resolume, Preferences > DMX > Network Adapter must still be set by hand"
echo "           to the NIC on the MA3's subnet (or \"Localhost\" for same-machine testing)."
echo "           Resolume only listens on UDP 6454 once an input exists AND a valid adapter is picked."

# Optionally rewrite a saved composition's own DmxShortcutPreset Param so it
# doesn't override activePresets.xml back to whatever preset it last had
# selected when the composition was saved.
if [ -n "$COMPOSITION" ]; then
  if [ ! -f "$COMPOSITION" ]; then
    echo "error: composition file not found: $COMPOSITION" >&2
    exit 1
  fi
  if ! grep -q 'name="DmxShortcutPreset"' "$COMPOSITION"; then
    echo "error: no <Param name=\"DmxShortcutPreset\" .../> found in $COMPOSITION" >&2
    echo "       is this a Resolume .avc composition file? refusing to touch it." >&2
    exit 1
  fi

  TS="$(date +%Y%m%d-%H%M%S)"
  COMPOSITION_BAK="$COMPOSITION.bak-$TS"
  cp "$COMPOSITION" "$COMPOSITION_BAK"
  echo "backed up $COMPOSITION -> $COMPOSITION_BAK"

  BEFORE_LINE="$(grep 'name="DmxShortcutPreset"' "$COMPOSITION" | head -1)"
  echo "before: $BEFORE_LINE"

  # Anchored to the DmxShortcutPreset Param line only (matched by the exact
  # name="DmxShortcutPreset" attribute) so the sibling Keyboard/Midi/Osc
  # shortcut-preset Params are never touched, and only that line's
  # value="..." attribute is rewritten.
  sed -i '' -E '/name="DmxShortcutPreset"/ s/value="[^"]*"/value="'"$PRESET_NAME"'"/' "$COMPOSITION"

  AFTER_LINE="$(grep 'name="DmxShortcutPreset"' "$COMPOSITION" | head -1)"
  echo "after:  $AFTER_LINE"
  echo "set DmxShortcutPreset value=\"$PRESET_NAME\" in $COMPOSITION"
fi

echo "done — start Resolume Arena, then Shortcuts > DMX should show \"$PRESET_NAME\" selected."
