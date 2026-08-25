'use strict';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tar = require('../src/main/tarball.js');
const store = require('../src/payload-store.js');
const { Updater } = require('../src/main/updater.js');

const REPO = 'riegergogi2001/resolume-rogger';
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rogger-upd-'));
});

/** A payload tarball that store.isBootable() will accept. */
function payloadTarball(version, extra = {}) {
  return tar.packGzip([
    { name: 'payload.json', data: JSON.stringify({ version, ...extra }) },
    { name: 'src/main/main.js', data: 'module.exports = { start(){} };' },
    { name: 'src/renderer/index.html', data: '<!doctype html><title>ROGGER</title>' },
    { name: 'configs/campus-forum-stage.json', data: '{}' },
  ]);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Fake github. `release` is the JSON for /releases/latest; assets is a map of
 * asset name -> Buffer. Anything not registered 404s, like the real thing.
 */
function fakeGitHub({ release, assets = {}, apiStatus = 200, fail = null }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (fail) throw fail;
    if (String(url).includes('/releases/latest')) {
      if (apiStatus !== 200) return new Response('', { status: apiStatus });
      return new Response(JSON.stringify(release), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    const name = String(url).split('/').pop();
    if (!(name in assets)) return new Response('not found', { status: 404 });
    const body = assets[name];
    return new Response(body, {
      status: 200, headers: { 'content-length': String(body.length) },
    });
  };
  return { fetchImpl, calls };
}

/** Wire up a release that offers `version` as a downloadable payload. */
function releaseWith(version, { minShell, corruptTarball = false, manifestPatch = {} } = {}) {
  const tarball = payloadTarball(version);
  const shipped = corruptTarball ? Buffer.concat([tarball, Buffer.from('junk')]) : tarball;
  const manifest = {
    version,
    sha256: sha256(tarball), // always the honest hash of the intended bundle
    size: tarball.length,
    ...(minShell ? { minShell } : {}),
    ...manifestPatch,
  };
  return {
    release: {
      tag_name: `v${version}`,
      html_url: `https://github.com/${REPO}/releases/tag/v${version}`,
      body: `### ${version}\n- nicer faders`,
      published_at: '2026-08-25T10:00:00Z',
      assets: [
        { name: `rogger-payload-${version}.json`, browser_download_url: `https://x/rogger-payload-${version}.json` },
        { name: `rogger-payload-${version}.tar.gz`, browser_download_url: `https://x/rogger-payload-${version}.tar.gz` },
        { name: `ROGGER-${version}.exe`, browser_download_url: `https://x/ROGGER-${version}.exe` },
      ],
    },
    assets: {
      [`rogger-payload-${version}.json`]: Buffer.from(JSON.stringify(manifest)),
      [`rogger-payload-${version}.tar.gz`]: shipped,
    },
  };
}

function makeUpdater(github, { current = '2.0.0', shell = '2.0.0' } = {}) {
  return new Updater({
    repo: REPO,
    payloadsDir: dir,
    currentVersion: current,
    shellVersion: shell,
    fetchImpl: github.fetchImpl,
    now: () => 1000,
  });
}

test('a newer release is offered as available', async () => {
  const u = makeUpdater(fakeGitHub(releaseWith('2.1.0')));
  const r = await u.check();
  assert.equal(r.status, 'available');
  assert.equal(r.version, '2.1.0');
  assert.match(r.notes, /nicer faders/);
  assert.ok(SHA_RE.test(r.sha256));
  assert.equal(u.info().lastCheck, 1000, 'the check timestamp is persisted');
});
const SHA_RE = /^[a-f0-9]{64}$/;

test('the same or an older release reports up to date', async () => {
  for (const tag of ['2.0.0', '1.18.0']) {
    const u = makeUpdater(fakeGitHub(releaseWith(tag)));
    const r = await u.check();
    assert.equal(r.status, 'up-to-date', tag);
    assert.equal(u.pending, null);
  }
});

test('a repo with no releases at all is up to date, not an error', async () => {
  const u = makeUpdater(fakeGitHub({ release: null, apiStatus: 404 }));
  assert.equal((await u.check()).status, 'up-to-date');
});

test('a release needing a newer exe asks for the shell instead of installing', async () => {
  const u = makeUpdater(fakeGitHub(releaseWith('2.1.0', { minShell: '2.1.0' })), { shell: '2.0.0' });
  const r = await u.check();
  assert.equal(r.status, 'shell-required');
  assert.equal(r.minShell, '2.1.0');
  assert.ok(r.htmlUrl, 'the UI needs somewhere to send the operator');
  assert.equal(u.pending, null, 'nothing may be staged for download');
});

test('minShell at or below the running shell still installs over the air', async () => {
  const u = makeUpdater(fakeGitHub(releaseWith('2.1.0', { minShell: '2.0.0' })), { shell: '2.0.0' });
  assert.equal((await u.check()).status, 'available');
});

test('a release without payload assets is reported, not treated as an update', async () => {
  const base = releaseWith('2.1.0');
  base.release.assets = [{ name: 'ROGGER-2.1.0.exe', browser_download_url: 'https://x/ROGGER-2.1.0.exe' }];
  const r = await makeUpdater(fakeGitHub(base)).check();
  assert.equal(r.status, 'no-payload');
  assert.equal(r.version, '2.1.0');
});

test('download verifies the checksum, installs, and leaves the running app alone', async () => {
  const u = makeUpdater(fakeGitHub(releaseWith('2.1.0')));
  await u.check();
  const seen = [];
  const res = await u.download(p => seen.push(p));
  assert.equal(res.ok, true);
  assert.equal(res.version, '2.1.0');
  assert.ok(seen.length > 0, 'progress is reported');

  const installed = store.listInstalled(dir);
  assert.deepEqual(installed.map(p => p.version), ['2.1.0']);
  assert.equal(fs.readFileSync(path.join(dir, '2.1.0', 'src', 'main', 'main.js'), 'utf8'),
    'module.exports = { start(){} };');
  assert.equal(u.info().staged, '2.1.0', 'the UI can now offer a restart');
  assert.equal(u.pending, null);
});

test('a tampered tarball is rejected and nothing is installed', async () => {
  const u = makeUpdater(fakeGitHub(releaseWith('2.1.0', { corruptTarball: true })));
  await u.check();
  const res = await u.download();
  assert.equal(res.ok, false);
  assert.match(res.message, /checksum mismatch/);
  assert.deepEqual(store.listInstalled(dir), [], 'no payload may survive a failed verify');
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('.staging')), [], 'staging is cleaned up');
});

test('a manifest that disagrees with the release tag is refused', async () => {
  const bad = releaseWith('2.1.0', { manifestPatch: { version: '9.9.9' } });
  const r = await makeUpdater(fakeGitHub(bad)).check();
  assert.equal(r.status, 'error');
  assert.match(r.message, /does not match release tag/);
});

test('a manifest with a junk sha256 or size is refused', async () => {
  for (const patch of [{ sha256: 'nope' }, { sha256: '' }, { size: 0 }, { size: -5 }, { size: 1e12 }]) {
    const r = await makeUpdater(fakeGitHub(releaseWith('2.1.0', { manifestPatch: patch }))).check();
    assert.equal(r.status, 'error', JSON.stringify(patch));
  }
});

test('a release tagged with something unusable is refused', async () => {
  const base = releaseWith('2.1.0');
  base.release.tag_name = 'nightly';
  const r = await makeUpdater(fakeGitHub(base)).check();
  assert.equal(r.status, 'error');
  assert.match(r.message, /unusable tag/);
});

test('network failure and a GitHub error both surface as a readable status', async () => {
  const dead = await makeUpdater(fakeGitHub({ fail: new Error('getaddrinfo ENOTFOUND') })).check();
  assert.equal(dead.status, 'error');
  assert.match(dead.message, /Could not reach GitHub/);

  const rate = await makeUpdater(fakeGitHub({ release: null, apiStatus: 403 })).check();
  assert.equal(rate.status, 'error');
  assert.match(rate.message, /403/);
});

test('an already downloaded payload checks as ready, without re-fetching assets', async () => {
  const github = fakeGitHub(releaseWith('2.1.0'));
  const u = makeUpdater(github);
  await u.check();
  await u.download();

  const after = makeUpdater(github);
  const r = await after.check();
  assert.equal(r.status, 'ready');
  assert.equal(r.version, '2.1.0');
  assert.equal(github.calls.filter(c => c.endsWith('.tar.gz')).length, 1, 'the tarball is fetched once');
});

test('a quarantined version is offered again rather than reported ready', async () => {
  const github = fakeGitHub(releaseWith('2.1.0'));
  const u = makeUpdater(github);
  await u.check();
  await u.download();
  store.writeState(dir, { ...store.readState(dir), quarantine: ['2.1.0'] });

  const r = await makeUpdater(github).check();
  assert.equal(r.status, 'available', 'a bad payload must be re-downloadable');
});

test('re-downloading clears an earlier quarantine on that version', async () => {
  const github = fakeGitHub(releaseWith('2.1.0'));
  store.writeState(dir, { active: null, attempts: 0, quarantine: ['2.1.0'], lastCheck: 0 });
  const u = makeUpdater(github);
  await u.check();
  assert.equal((await u.download()).ok, true);
  assert.deepEqual(store.readState(dir).quarantine, []);
});

test('download refuses to run without a check', async () => {
  const res = await makeUpdater(fakeGitHub(releaseWith('2.1.0'))).download();
  assert.equal(res.ok, false);
  assert.match(res.message, /run a check first/);
});

test('an oversized download is cut off at the ceiling', async () => {
  const version = '2.1.0';
  const huge = Buffer.alloc(20 * 1024 * 1024, 0x41);
  const base = releaseWith(version);
  base.assets[`rogger-payload-${version}.tar.gz`] = huge;
  const u = makeUpdater(fakeGitHub(base));
  await u.check();
  const res = await u.download();
  assert.equal(res.ok, false);
  assert.match(res.message, /limit|size/i);
  assert.deepEqual(store.listInstalled(dir), []);
});

test('a payload whose manifest lies about its own version is not promoted', async () => {
  const version = '2.1.0';
  const wrong = payloadTarball('3.3.3');            // inner payload.json says 3.3.3
  const base = releaseWith(version);
  base.assets[`rogger-payload-${version}.json`] = Buffer.from(JSON.stringify({
    version, sha256: sha256(wrong), size: wrong.length,
  }));
  base.assets[`rogger-payload-${version}.tar.gz`] = wrong;
  const u = makeUpdater(fakeGitHub(base));
  await u.check();
  const res = await u.download();
  assert.equal(res.ok, false);
  assert.match(res.message, /does not declare version 2\.1\.0/);
  assert.deepEqual(store.listInstalled(dir), []);
});

test('resetToBundled removes every downloaded payload', async () => {
  const u = makeUpdater(fakeGitHub(releaseWith('2.1.0')));
  await u.check();
  await u.download();
  assert.equal(store.listInstalled(dir).length, 1);
  const info = u.resetToBundled();
  assert.deepEqual(store.listInstalled(dir), []);
  assert.deepEqual(info.installed, []);
  assert.equal(info.staged, null);
});

test('a misconfigured repo never builds a URL', async () => {
  const u = new Updater({ repo: '../../evil', payloadsDir: dir, currentVersion: '2.0.0', shellVersion: '2.0.0',
    fetchImpl: () => { throw new Error('must not be called'); } });
  const r = await u.check();
  assert.equal(r.status, 'error');
  assert.match(r.message, /No update repository/);
});

test('info() reports what the Settings page needs before any network call', () => {
  const u = makeUpdater(fakeGitHub(releaseWith('2.1.0')), { current: '2.0.0', shell: '2.0.0' });
  const info = u.info();
  assert.equal(info.payloadVersion, '2.0.0');
  assert.equal(info.shellVersion, '2.0.0');
  assert.equal(info.repo, REPO);
  assert.deepEqual(info.installed, []);
  assert.equal(info.staged, null);
  assert.equal(info.busy, false);
});
