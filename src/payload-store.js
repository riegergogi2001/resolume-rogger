'use strict';
// On-disk layout of the OTA payload directory, shared by the shell bootstrap
// and the in-payload updater.
//
//   <userData>/payloads/
//     state.json          { active, attempts, quarantine[], lastCheck }
//     2.1.0/              an installed payload (src/, configs/, payload.json)
//     .staging-2.1.1/     an extraction in progress; never booted
//     .tmp/               downloads in flight
//
// Only whole directories are ever promoted: extraction happens under
// .staging-<v> and is renamed into place once it has been checked, so an
// interrupted install cannot leave a half-written payload that looks bootable.
const fs = require('node:fs');
const path = require('node:path');
const { isValidVersion, normaliseState } = require('./payload-resolve.js');

const STATE_FILE = 'state.json';

function stateFile(payloadsDir) {
  return path.join(payloadsDir, STATE_FILE);
}

function readState(payloadsDir) {
  try {
    return normaliseState(JSON.parse(fs.readFileSync(stateFile(payloadsDir), 'utf8')));
  } catch {
    return normaliseState(null); // missing or corrupt: start clean
  }
}

function writeState(payloadsDir, state) {
  const next = normaliseState(state);
  try {
    fs.mkdirSync(payloadsDir, { recursive: true });
    const tmp = `${stateFile(payloadsDir)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, stateFile(payloadsDir)); // atomic swap
  } catch {
    // A read-only or full disk must not stop the app from starting; the worst
    // case is that the crash counter forgets a boot.
  }
  return next;
}

/** A directory only counts as a payload if it can actually be booted. */
function isBootable(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'src', 'main', 'main.js'))) return false;
    if (!fs.existsSync(path.join(dir, 'src', 'renderer', 'index.html'))) return false;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'payload.json'), 'utf8'));
    return isValidVersion(meta?.version) ? meta.version : false;
  } catch {
    return false;
  }
}

/** Installed payloads, newest first is the caller's business — order is by name. */
function listInstalled(payloadsDir) {
  let names;
  try {
    names = fs.readdirSync(payloadsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of names) {
    // dot-prefixed names are staging/temp scratch, never bootable
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!isValidVersion(entry.name)) continue;
    const dir = path.join(payloadsDir, entry.name);
    const version = isBootable(dir);
    // The directory name and the manifest inside it must agree, or we do not
    // know what we are booting.
    if (version && version === entry.name) out.push({ version, dir });
  }
  return out;
}

function removePayload(payloadsDir, version) {
  if (!isValidVersion(version)) return false;
  try {
    fs.rmSync(path.join(payloadsDir, version), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Drop every downloaded payload and reset the state — the "back to bundled" escape hatch. */
function removeAll(payloadsDir) {
  for (const { version } of listInstalled(payloadsDir)) removePayload(payloadsDir, version);
  cleanScratch(payloadsDir);
  return writeState(payloadsDir, { active: null, attempts: 0, quarantine: [], lastCheck: 0 });
}

/** Remove leftover staging/temp directories from an interrupted install. */
function cleanScratch(payloadsDir) {
  try {
    for (const entry of fs.readdirSync(payloadsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('.')) {
        fs.rmSync(path.join(payloadsDir, entry.name), { recursive: true, force: true });
      }
    }
  } catch { /* nothing to clean */ }
}

module.exports = {
  readState, writeState, listInstalled, isBootable, removePayload, removeAll, cleanScratch, stateFile,
};
