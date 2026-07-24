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
      const socket = dgram.createSocket('udp4');
      socket.on('error', err => {
        this.emit('error', err);
        this._setStatus('offline');
        socket.close();
        if (this.socket === socket) this.socket = null;
        this._scheduleReconnect();
      });
      socket.on('message', buf => this._onInbound(buf));
      socket.bind(this.network.listenPort ?? 0, () => {
        this.socket = socket;
        this._reconnectAttempt = 0;
        this._setStatus('ready');
        resolve(true);
      });
    });
  }

  close() {
    clearTimeout(this._liveTimer);
    clearTimeout(this._reconnectTimer);
    this._liveTimer = null;
    this._reconnectTimer = null;
    if (this.socket) {
      try { this.socket.close(); } catch { /* already closed */ }
      this.socket = null;
    }
    this._setStatus('offline');
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
      this.emit('message', msg);
      if (this._learnArmed) this.emit('learn', msg);
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
