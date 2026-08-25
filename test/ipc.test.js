'use strict';
// The IPC layer must not lose what the engine says before the renderer is
// listening: the launch-time bind runs before the window has a page.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const store = require('../src/main/config-store.js');
const { registerIpc } = require('../src/main/ipc.js');

function harness() {
  const handlers = {};
  const ipcMain = { handle: (ch, fn) => { handlers[ch] = fn; }, on: (ch, fn) => { handlers[ch] = fn; } };
  const engine = new EventEmitter();
  engine.status = 'ready';
  engine.listenInfo = () => ({ port: 55555, configured: 7001, fallback: true });
  const sent = [];
  let win = null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rogger-ipc-'));
  registerIpc({
    ipcMain, engine, store,
    configPath: path.join(dir, 'config.json'), seedPath: null,
    getWindow: () => win, app: null, dialog: null, shell: null, ctx: {},
  });
  const showWindow = () => { win = { isDestroyed: () => false, webContents: { send: (ch, p) => sent.push([ch, p]) } }; };
  const setWindow = w => { win = w; };
  return { handlers, engine, sent, showWindow, setWindow };
}

test('engine errors raised before the renderer asks for status are replayed to it afterwards', async () => {
  const h = harness();
  // Launch order in main.js: open() (and its bind error) before createWindow().
  h.engine.emit('error', new Error('Listen port 7001 is not available (EADDRINUSE)'));
  h.showWindow();
  assert.deepEqual(h.sent, [], 'nothing is sent to a page that has no listeners yet');
  assert.equal(await h.handlers['osc:status:get'](), 'ready');
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(h.sent, [['osc:error', 'Listen port 7001 is not available (EADDRINUSE)']],
    'the first status request flushes what was said before it');
  h.engine.emit('error', new Error('later'));
  assert.deepEqual(h.sent.at(-1), ['osc:error', 'later'], 'after that, errors go straight through');
});

test('listen info is forwarded live and available on request', async () => {
  const h = harness();
  h.showWindow();
  await h.handlers['osc:status:get']();
  h.engine.emit('listen', { port: 1, configured: 7001, fallback: true });
  assert.deepEqual(h.sent.at(-1), ['osc:listen', { port: 1, configured: 7001, fallback: true }]);
  assert.deepEqual(await h.handlers['osc:listen:get'](), { port: 55555, configured: 7001, fallback: true });
});

test('a destroyed window never receives anything, and nothing throws', async () => {
  const h = harness();
  h.showWindow();
  await h.handlers['osc:status:get']();
  let touched = 0;
  h.setWindow({ isDestroyed: () => true, webContents: { send: () => { touched += 1; throw new Error('gone'); } } });
  h.engine.emit('status', 'live');
  h.engine.emit('message', { address: '/x', args: [] });
  h.engine.emit('listen', { port: 1, configured: 7001, fallback: false });
  h.engine.emit('error', new Error('after teardown'));
  assert.equal(touched, 0, 'webContents.send is never called on a destroyed window');
  assert.deepEqual(h.sent, [], 'and nothing was delivered anywhere');
});
