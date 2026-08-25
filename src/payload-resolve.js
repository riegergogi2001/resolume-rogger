'use strict';
// Decides which app payload the shell should boot: the copy bundled inside the
// exe, or a newer one downloaded over the air.
//
// This file is part of the SHELL. The bootstrap always loads it from the
// bundled tree, so a broken OTA payload can never take the fallback logic down
// with it. (A copy also rides along inside every payload, purely so the
// updater can share compareVersions; that copy is never loaded by the shell.)
//
// Everything here is pure — the caller does the file IO and hands in what it
// found. That is what makes the crash-loop behaviour testable without ever
// launching Electron.

const MAX_ATTEMPTS = 2;

/**
 * Compare two dotted versions. Prerelease suffixes (2.1.0-beta.1) sort below
 * their release, matching semver closely enough for our own tags.
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
function compareVersions(a, b) {
  const parse = v => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? '').trim());
    return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] ?? null } : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0; // unparseable versions never win a comparison
  for (let i = 0; i < 3; i += 1) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;   // 2.1.0 > 2.1.0-rc.1
  if (pb.pre === null) return -1;
  return pa.pre < pb.pre ? -1 : 1;
}

function isValidVersion(v) {
  return /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(v ?? '').trim());
}

function normaliseState(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    active: isValidVersion(s.active) ? s.active : null,
    attempts: Number.isInteger(s.attempts) && s.attempts >= 0 ? s.attempts : 0,
    quarantine: Array.isArray(s.quarantine) ? s.quarantine.filter(isValidVersion) : [],
    lastCheck: Number.isFinite(s.lastCheck) ? s.lastCheck : 0,
  };
}

/**
 * Pick the payload to boot.
 *
 * A payload is only a candidate if it parses as a version, is not quarantined,
 * and is strictly newer than the copy baked into the shell — an OTA payload at
 * or below the bundled version has nothing to offer.
 *
 * Crash-loop guard: the bootstrap bumps `attempts` before loading and zeroes it
 * once the window has actually rendered. Reaching MAX_ATTEMPTS means the
 * payload failed to reach that point twice, so it is quarantined and the next
 * best candidate (ultimately the bundled tree) takes over.
 *
 * @param {object} args
 * @param {string} args.bundledVersion   version compiled into the shell
 * @param {Array<{version: string, dir: string}>} args.installed  payloads found on disk
 * @param {object} args.state            persisted { active, attempts, quarantine }
 * @param {boolean} [args.safeMode]      force the bundled tree
 * @param {number} [args.maxAttempts]
 * @returns {{source: 'bundled'|'ota', version: string, dir: string|null,
 *            state: object, quarantined: string[]}}
 */
function resolvePayload({ bundledVersion, installed = [], state, safeMode = false, maxAttempts = MAX_ATTEMPTS }) {
  const current = normaliseState(state);
  const quarantined = [];

  if (safeMode) {
    return {
      source: 'bundled',
      version: bundledVersion,
      dir: null,
      state: { ...current, active: null, attempts: 0 },
      quarantined,
    };
  }

  const pool = installed
    .filter(p => p && isValidVersion(p.version) && typeof p.dir === 'string')
    .filter(p => compareVersions(p.version, bundledVersion) > 0);

  const banned = new Set(current.quarantine);
  let attempts = current.attempts;

  for (;;) {
    const candidate = pool
      .filter(p => !banned.has(p.version))
      .sort((a, b) => compareVersions(b.version, a.version))[0];

    if (!candidate) {
      return {
        source: 'bundled',
        version: bundledVersion,
        dir: null,
        state: { ...current, active: null, attempts: 0, quarantine: [...banned] },
        quarantined,
      };
    }

    // Same payload as last boot, and it already burned through its attempts:
    // it never came up healthy, so stop trying it.
    if (candidate.version === current.active && attempts >= maxAttempts) {
      banned.add(candidate.version);
      quarantined.push(candidate.version);
      attempts = 0;
      continue;
    }

    const nextAttempts = (candidate.version === current.active ? attempts : 0) + 1;
    return {
      source: 'ota',
      version: candidate.version,
      dir: candidate.dir,
      state: { ...current, active: candidate.version, attempts: nextAttempts, quarantine: [...banned] },
      quarantined,
    };
  }
}

/** Called once the window has rendered: this boot counts as healthy. */
function markHealthy(state) {
  return { ...normaliseState(state), attempts: 0 };
}

module.exports = { resolvePayload, markHealthy, compareVersions, isValidVersion, normaliseState, MAX_ATTEMPTS };
