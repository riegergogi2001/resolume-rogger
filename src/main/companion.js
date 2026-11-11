'use strict';
// Bitfocus Companion "Satellite" client: ROGGER registers itself as a
// Stream Deck XL (8x4 = 32 keys) over Companion's Satellite API (TCP 16622),
// receives each key's rendered 72x72 bitmap and sends key presses back.
// Nothing else talks to Companion, so this stays out of the OSC/DMX path.
const net = require('node:net');
const os = require('node:os');

const KEYS_PER_ROW = 8;
const KEYS_TOTAL = 32;
const BITMAP_SIZE = 72;

// `KEY=3 TEXT="a b" FOO=bar` -> { KEY: '3', TEXT: 'a b', FOO: 'bar' }
function parseArgs(str) {
  const out = {};
  const re = /([A-Za-z_]+)=("((?:[^"\\]|\\.)*)"|\S*)/g;
  let m;
  while ((m = re.exec(str))) out[m[1].toUpperCase()] = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[2];
  return out;
}

function parseLine(line) {
  const i = line.indexOf(' ');
  const cmd = (i < 0 ? line : line.slice(0, i)).toUpperCase();
  const rest = i < 0 ? '' : line.slice(i + 1);
  return { cmd, rest, args: parseArgs(rest) };
}

class CompanionClient {
  constructor({ onEvent = () => {}, deviceId = `ROGGER-${os.hostname()}`.replace(/[^\w-]/g, '') } = {}) {
    this.onEvent = onEvent;
    this.deviceId = deviceId;
    this.sock = null;
    this.host = null;
    this.port = 16622;
    this.status = 'off';
    this.retryTimer = null;
    this.pingTimer = null;
    this.keys = new Map(); // key -> last KEY-STATE payload, replayed to a reloaded renderer
  }

  setStatus(status, message) {
    this.status = status;
    this.onEvent({ type: 'status', status, message: message ?? null });
  }

  connect(host, port = 16622) {
    this.disconnect();
    this.host = host;
    this.port = Number(port) || 16622;
    this.want = true;
    this.open();
  }

  open() {
    if (!this.want) return;
    this.setStatus('connecting');
    const sock = net.createConnection({ host: this.host, port: this.port });
    this.sock = sock;
    sock.setNoDelay(true);
    let buf = '';
    sock.on('connect', () => {
      // Companion pings us; we ping too so a dead link is noticed both ways.
      this.pingTimer = setInterval(() => this.write('PING rogger'), 2000);
    });
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line) this.handle(line);
      }
    });
    sock.on('error', err => this.setStatus('error', err.code || err.message));
    sock.on('close', () => {
      clearInterval(this.pingTimer);
      if (this.sock !== sock) return;
      this.sock = null;
      if (!this.want) return;
      if (this.status !== 'error') this.setStatus('connecting');
      this.retryTimer = setTimeout(() => this.open(), 3000);
    });
  }

  handle(line) {
    const { cmd, rest, args } = parseLine(line);
    if (cmd === 'PING') return this.write(`PONG ${rest}`);
    if (cmd === 'BEGIN') {
      this.write(`ADD-DEVICE DEVICEID=${this.deviceId} PRODUCT_NAME="ROGGER Stream Deck XL" `
        + `KEYS_TOTAL=${KEYS_TOTAL} KEYS_PER_ROW=${KEYS_PER_ROW} BITMAPS=${BITMAP_SIZE} COLORS=hex TEXT=true`);
      return;
    }
    if (cmd === 'ADD-DEVICE') {
      if (rest.startsWith('OK')) this.setStatus('connected');
      else this.setStatus('error', args.MESSAGE || rest);
      return;
    }
    if (args.DEVICEID && args.DEVICEID !== this.deviceId) return;
    if (cmd === 'KEY-STATE') {
      const key = Number(args.KEY);
      if (!(key >= 0 && key < KEYS_TOTAL)) return;
      const state = {
        key,
        bitmap: args.BITMAP || null, // base64 raw RGB, 72*72*3
        color: args.COLOR || null,
        text: args.TEXT ? Buffer.from(args.TEXT, 'base64').toString('utf8') : '',
        pressed: args.PRESSED === 'true' || args.PRESSED === '1',
      };
      this.keys.set(key, state);
      this.onEvent({ type: 'key', ...state });
    } else if (cmd === 'KEYS-CLEAR') {
      this.keys.clear();
      this.onEvent({ type: 'clear' });
    } else if (cmd === 'BRIGHTNESS') {
      this.onEvent({ type: 'brightness', value: Number(args.VALUE) });
    }
  }

  press(key, pressed) {
    if (this.status !== 'connected') return;
    this.write(`KEY-PRESS DEVICEID=${this.deviceId} KEY=${Number(key)} PRESSED=${pressed ? 'true' : 'false'}`);
  }

  write(line) {
    if (this.sock && !this.sock.destroyed && this.sock.writable) this.sock.write(`${line}\n`);
  }

  snapshot() {
    return { status: this.status, host: this.host, port: this.port, keys: [...this.keys.values()] };
  }

  disconnect() {
    this.want = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    const sock = this.sock;
    this.sock = null;
    if (sock) {
      try { sock.end(`REMOVE-DEVICE DEVICEID=${this.deviceId}\n`); } catch { /* closing anyway */ }
      setTimeout(() => sock.destroy(), 300).unref?.();
    }
    this.keys.clear();
    if (this.status !== 'off') this.setStatus('off');
  }
}

module.exports = { CompanionClient, parseLine, KEYS_PER_ROW, KEYS_TOTAL, BITMAP_SIZE };
