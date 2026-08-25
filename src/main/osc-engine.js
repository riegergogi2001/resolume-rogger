'use strict';
// UDP transport for OSC: send, receive, learn mode, connection status, test.
// One socket bound to listenPort handles both directions, so replies to our
// source port and dedicated OSC output streams both land here.
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { encodeMessage, decodePacket, inferArgs } = require('./osc.js');

const RECONNECT_BACKOFF_MS = [500, 2000, 5000];

class OscEngine extends EventEmitter {
  constructor({ liveWindowMs = 5000, testReplyMs = 1500 } = {}) {
    super();
    this.liveWindowMs = liveWindowMs;
    this.testReplyMs = testReplyMs;
    this.network = null;
    this.socket = null;
    this.status = 'offline';
    this._liveTimer = null;
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._learnArmed = false;
    this._pending = null;     // { socket, resolve } while a bind is in flight
    // True when the configured listen port could not be bound and the engine
    // is sending from an ephemeral port instead: commands still land, but
    // feedback aimed at the configured port will not arrive.
    this.listenFallback = false;
  }

  configure(network) {
    this.network = { ...network };
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  open() {
    return new Promise(resolve => {
      this.close();
      if (!this.network || !this.network.targetIp) {
        this._setStatus('offline');
        return resolve(false);
      }
      this._bind(this.network.listenPort ?? 0, resolve, true);
    });
  }

  // Bind one socket. A bind that fails on the configured port (EADDRINUSE from
  // another app, EACCES from a Windows excluded port range) falls back to an
  // ephemeral port once, so a busy listen port never takes sending down with
  // it. Every path settles the promise: the Settings save awaits this.
  _bind(port, resolve, allowFallback) {
    const socket = dgram.createSocket('udp4');
    const pending = { socket, resolve };
    this._pending = pending;
    let bound = false;
    socket.on('error', err => {
      if (bound) {
        // A receive error on a live socket (Windows reports an ICMP
        // port-unreachable this way) is worth a toast, never a teardown.
        this.emit('error', err);
        return;
      }
      if (this._pending === pending) this._pending = null;
      try { socket.close(); } catch { /* never bound */ }
      this.emit('error', err);
      if (allowFallback && port !== 0) {
        this.emit('error', new Error(
          `Listen port ${port} is not available (${err?.code ?? err?.message ?? err}) — ` +
          'sending still works, but feedback and the remote API will not arrive until ' +
          'the port is freed or changed in Settings → Network.'));
        this._bind(0, resolve, false);
        return;
      }
      this._setStatus('offline');
      this._scheduleReconnect();
      resolve(false);
    });
    socket.on('message', buf => this._onInbound(buf));
    socket.bind(port, () => {
      bound = true;
      if (this._pending !== pending) {
        // close() or a newer open() superseded this bind while it was in flight
        try { socket.close(); } catch { /* already closed */ }
        resolve(false);
        return;
      }
      this._pending = null;
      this.socket = socket;
      this.listenFallback = port === 0 && (this.network?.listenPort ?? 0) !== 0;
      this._reconnectAttempt = 0;
      this._setStatus('ready');
      // Where feedback can actually arrive. The surface shows a persistent
      // warning when this is not the configured port, because 'ready' alone
      // would hide a dead feedback leg behind a healthy-looking lamp.
      this.emit('listen', this.listenInfo());
      resolve(true);
    });
  }

  close() {
    clearTimeout(this._liveTimer);
    clearTimeout(this._reconnectTimer);
    this._liveTimer = null;
    this._reconnectTimer = null;
    if (this._pending) {
      const pending = this._pending;
      this._pending = null;
      try { pending.socket.close(); } catch { /* never bound */ }
      pending.resolve(false);
    }
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
      this.socket = null;
    }
    this.listenFallback = false;
    this._setStatus('offline');
    this.emit('listen', this.listenInfo());
  }

  // { port, configured, fallback }: the port feedback must be sent to, the
  // one Settings asked for, and whether they differ.
  listenInfo() {
    const addr = this.listenAddress();
    return {
      port: addr?.port ?? null,
      configured: this.network?.listenPort ?? 0,
      fallback: Boolean(this.listenFallback),
    };
  }

  listenAddress() {
    return this.socket ? this.socket.address() : null;
  }

  _scheduleReconnect() {
    if (!this.network?.autoReconnect || this._reconnectTimer) return;
    const delay = RECONNECT_BACKOFF_MS[Math.min(this._reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this._reconnectAttempt += 1;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.open();
    }, delay);
  }

  _onInbound(buf) {
    let messages;
    try {
      messages = decodePacket(buf);
    } catch {
      return; // not OSC — ignore
    }
    if (this.status !== 'offline') {
      this._setStatus('live');
      clearTimeout(this._liveTimer);
      this._liveTimer = setTimeout(() => {
        if (this.status === 'live') this._setStatus('ready');
      }, this.liveWindowMs);
    }
    for (const msg of messages) {
      // A listener that throws (a window torn down mid-send, say) must not
      // propagate out of the socket's message handler — that would be an
      // uncaught exception in the main process, i.e. the app going down.
      try {
        this.emit('message', msg);
        if (this._learnArmed) this.emit('learn', msg);
      } catch (err) {
        this.emit('error', err);
      }
    }
  }

  sendTyped(address, args) {
    if (!this.socket || !this.network?.targetIp) {
      this.emit('error', new Error('OSC socket is not open'));
      return;
    }
    let buf;
    try {
      buf = encodeMessage(address, args);
    } catch (err) {
      this.emit('error', err);
      return;
    }
    this.socket.send(buf, this.network.targetPort, this.network.targetIp, err => {
      if (err) this.emit('error', err);
    });
  }

  send(address, values = []) {
    this.sendTyped(address, inferArgs(values));
  }

  armLearn() { this._learnArmed = true; }
  disarmLearn() { this._learnArmed = false; }

  // UDP has no handshake: we probe with a harmless query and report honestly.
  testConnection() {
    return new Promise(resolve => {
      if (!this.socket || !this.network?.targetIp) {
        return resolve({ ok: false, detail: 'Not connected — check network settings.' });
      }
      let settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        this.removeListener('message', onMessage);
        clearTimeout(timer);
        resolve(result);
      };
      const onMessage = () => finish({
        ok: true,
        detail: `Reply received from ${this.network.targetIp} — OSC link is live.`,
      });
      const timer = setTimeout(() => finish({
        ok: false,
        detail: `No reply within ${this.testReplyMs} ms. Commands may still arrive — ` +
          'enable OSC output in the target app for confirmation.',
      }), this.testReplyMs);
      this.on('message', onMessage);
      this.send('/composition/name');
    });
  }
}

module.exports = { OscEngine };
