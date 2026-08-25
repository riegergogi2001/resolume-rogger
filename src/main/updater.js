'use strict';
// Over-the-air payload updates from GitHub releases.
//
// A release that carries an update publishes three assets:
//   rogger-payload-<v>.tar.gz   the app payload (src/ + configs/ + payload.json)
//   rogger-payload-<v>.json     manifest: { version, sha256, size, minShell }
//   ROGGER-<v>.exe              the shell, only needed when minShell moves
//
// The manifest is fetched first and the tarball is checked against its sha256
// before a single byte is unpacked, so a truncated download or a mangled asset
// can never become an installed payload. Installs land in a staging directory
// and are renamed into place only after they are proven bootable.
//
// Nothing is ever applied to the running app: an installed payload is picked up
// by the shell on the next launch. That is deliberate — this thing runs shows.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tar = require('./tarball.js');
const store = require('../payload-store.js');
const { compareVersions, isValidVersion } = require('../payload-resolve.js');

const API = 'https://api.github.com';
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA256_RE = /^[a-f0-9]{64}$/i;

const CHECK_TIMEOUT_MS = 10000;
const DOWNLOAD_TIMEOUT_MS = 120000;
// A payload is a few hundred KB; anything near this ceiling is not our bundle.
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

function stripV(tag) {
  return String(tag ?? '').trim().replace(/^v/, '');
}

/** Read a whole response body with a hard size ceiling and progress reporting. */
async function readBody(res, { maxBytes, onProgress }) {
  const declared = Number(res.headers?.get?.('content-length')) || 0;
  if (declared > maxBytes) throw new Error(`download is ${declared} bytes, over the ${maxBytes} limit`);
  if (!res.body?.getReader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('download exceeds the size limit');
    onProgress?.({ received: buf.length, total: declared || buf.length });
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    if (received > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('download exceeds the size limit');
    }
    chunks.push(Buffer.from(value));
    onProgress?.({ received, total: declared || 0 });
  }
  return Buffer.concat(chunks);
}

class Updater {
  /**
   * @param {object} opts
   * @param {string} opts.repo            "owner/name" on github.com
   * @param {string} opts.payloadsDir     <userData>/payloads
   * @param {string} opts.currentVersion  version of the running payload
   * @param {string} opts.shellVersion    version compiled into the exe
   * @param {Function} [opts.fetchImpl]   injectable for tests
   */
  constructor({ repo, payloadsDir, currentVersion, shellVersion, fetchImpl, now }) {
    this.repo = REPO_RE.test(repo ?? '') ? repo : null;
    this.payloadsDir = payloadsDir;
    this.currentVersion = currentVersion;
    this.shellVersion = shellVersion;
    this.fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this.now = now ?? (() => Date.now());
    this.pending = null;   // the last 'available' check result
    this.busy = false;
  }

  _headers() {
    return {
      Accept: 'application/vnd.github+json',
      'User-Agent': `ROGGER/${this.shellVersion ?? '0'}`,
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /** What the Settings page shows without touching the network. */
  info() {
    const state = store.readState(this.payloadsDir);
    const installed = store.listInstalled(this.payloadsDir);
    // A payload newer than the one running is already downloaded and waiting.
    const staged = installed
      .filter(p => compareVersions(p.version, this.currentVersion) > 0 && !state.quarantine.includes(p.version))
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
    return {
      repo: this.repo,
      payloadVersion: this.currentVersion,
      shellVersion: this.shellVersion,
      installed: installed.map(p => p.version),
      quarantine: state.quarantine,
      lastCheck: state.lastCheck,
      staged: staged?.version ?? null,
      pending: this.pending,
      busy: this.busy,
    };
  }

  /**
   * Ask GitHub what the latest release is.
   * Never throws for an expected outcome — the UI wants a status, not a stack.
   * @returns {Promise<object>} { status: 'up-to-date' | 'available' | 'ready' |
   *   'shell-required' | 'no-payload' | 'error', ... }
   */
  async check() {
    if (!this.repo) return { status: 'error', message: 'No update repository configured.' };
    let release;
    try {
      const res = await this.fetch(`${API}/repos/${this.repo}/releases/latest`, {
        headers: this._headers(),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (res.status === 404) return this._stamp({ status: 'up-to-date', current: this.currentVersion, latest: null });
      if ((res.status === 403 || res.status === 429) && res.headers?.get?.('x-ratelimit-remaining') === '0') {
        // 60 unauthenticated calls an hour per public IP — a venue NAT shared
        // with other devices burns through that, and it is not a fault.
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const mins = reset > 0 ? Math.max(1, Math.ceil((reset - this.now()) / 60000)) : null;
        return {
          status: 'error',
          message: `GitHub's rate limit for this network is used up — try again ${mins ? `in about ${mins} minute${mins === 1 ? '' : 's'}` : 'later'}.`,
        };
      }
      if (!res.ok) return { status: 'error', message: `GitHub answered ${res.status}.` };
      release = await res.json();
    } catch (err) {
      return { status: 'error', message: `Could not reach GitHub: ${err?.message ?? err}` };
    }

    const version = stripV(release?.tag_name);
    if (!isValidVersion(version)) {
      return { status: 'error', message: `Latest release has an unusable tag: ${release?.tag_name}` };
    }
    const htmlUrl = typeof release?.html_url === 'string' ? release.html_url : null;

    if (compareVersions(version, this.currentVersion) <= 0) {
      this.pending = null;
      return this._stamp({ status: 'up-to-date', current: this.currentVersion, latest: version, htmlUrl });
    }

    // Already downloaded on a previous check: nothing to fetch, just restart.
    const state = store.readState(this.payloadsDir);
    if (store.listInstalled(this.payloadsDir).some(p => p.version === version) && !state.quarantine.includes(version)) {
      this.pending = null;
      return this._stamp({ status: 'ready', version, htmlUrl, notes: release?.body ?? '' });
    }

    const assets = Array.isArray(release?.assets) ? release.assets : [];
    const byName = name => assets.find(a => a?.name === name) ?? null;
    const manifestAsset = byName(`rogger-payload-${version}.json`);
    const payloadAsset = byName(`rogger-payload-${version}.tar.gz`);
    if (!manifestAsset || !payloadAsset) {
      // A release without payload assets is a full-shell release.
      return this._stamp({
        status: 'no-payload',
        version,
        htmlUrl,
        notes: release?.body ?? '',
        message: 'This release ships a new exe rather than an over-the-air payload.',
      });
    }

    let manifest;
    try {
      const res = await this.fetch(manifestAsset.browser_download_url, {
        headers: { 'User-Agent': `ROGGER/${this.shellVersion ?? '0'}` },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`manifest download answered ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      return { status: 'error', message: `Could not read the update manifest: ${err?.message ?? err}` };
    }

    const problem = this._validateManifest(manifest, version);
    if (problem) return { status: 'error', message: problem };

    if (manifest.minShell && compareVersions(manifest.minShell, this.shellVersion) > 0) {
      this.pending = null;
      return this._stamp({
        status: 'shell-required',
        version,
        minShell: manifest.minShell,
        htmlUrl,
        notes: release?.body ?? '',
        message: `Version ${version} needs the ROGGER ${manifest.minShell} exe or newer.`,
      });
    }

    this.pending = {
      version,
      url: payloadAsset.browser_download_url,
      sha256: String(manifest.sha256).toLowerCase(),
      size: manifest.size,
      notes: release?.body ?? '',
      htmlUrl,
      publishedAt: release?.published_at ?? null,
    };
    return this._stamp({ status: 'available', ...this.pending });
  }

  _validateManifest(manifest, version) {
    if (!manifest || typeof manifest !== 'object') return 'The update manifest is not valid JSON.';
    if (stripV(manifest.version) !== version) {
      return `Manifest version ${manifest.version} does not match release tag ${version}.`;
    }
    if (!SHA256_RE.test(String(manifest.sha256 ?? ''))) return 'The update manifest has no usable sha256.';
    if (!Number.isFinite(manifest.size) || manifest.size <= 0 || manifest.size > MAX_PAYLOAD_BYTES) {
      return `The update manifest declares an implausible size (${manifest.size}).`;
    }
    if (manifest.minShell != null && !isValidVersion(manifest.minShell)) {
      return `The update manifest has an unusable minShell (${manifest.minShell}).`;
    }
    return null;
  }

  /**
   * Download, verify and install the pending payload. It becomes active on the
   * next launch; the running app is left completely alone.
   */
  async download(onProgress) {
    if (this.busy) return { ok: false, message: 'An update is already downloading.' };
    const pending = this.pending;
    if (!pending) return { ok: false, message: 'Nothing to download — run a check first.' };

    this.busy = true;
    const staging = path.join(this.payloadsDir, `.staging-${pending.version}`);
    try {
      const res = await this.fetch(pending.url, {
        headers: { 'User-Agent': `ROGGER/${this.shellVersion ?? '0'}` },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`download answered ${res.status}`);
      const buf = await readBody(res, { maxBytes: MAX_PAYLOAD_BYTES, onProgress });

      const digest = crypto.createHash('sha256').update(buf).digest('hex');
      if (digest !== pending.sha256) {
        throw new Error('checksum mismatch — the download does not match the manifest');
      }

      fs.rmSync(staging, { recursive: true, force: true });
      tar.extractTo(buf, staging, { maxTotalBytes: MAX_PAYLOAD_BYTES });

      const bootable = store.isBootable(staging);
      if (bootable !== pending.version) {
        throw new Error(`the payload does not declare version ${pending.version}`);
      }

      // Promote: the finished tree replaces any earlier copy of this version.
      const target = path.join(this.payloadsDir, pending.version);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(staging, target);

      // A freshly downloaded payload earns a clean slate even if an earlier
      // attempt at this version was quarantined.
      const state = store.readState(this.payloadsDir);
      store.writeState(this.payloadsDir, {
        ...state,
        quarantine: state.quarantine.filter(v => v !== pending.version),
      });

      this.pending = null;
      return { ok: true, version: pending.version };
    } catch (err) {
      fs.rmSync(staging, { recursive: true, force: true });
      return { ok: false, message: String(err?.message ?? err) };
    } finally {
      this.busy = false;
    }
  }

  /** Throw away every downloaded payload — next launch runs the bundled one. */
  resetToBundled() {
    this.pending = null;
    store.removeAll(this.payloadsDir);
    return this.info();
  }

  _stamp(result) {
    const state = store.readState(this.payloadsDir);
    store.writeState(this.payloadsDir, { ...state, lastCheck: this.now() });
    return result;
  }
}

module.exports = { Updater, MAX_PAYLOAD_BYTES };
