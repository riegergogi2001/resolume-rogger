'use strict';
// DMX output for buttons (CO2 jets, spark machines). A button whose address is
//   sacn://<universe>/<channel>[?default=<0-255>&prio=<0-200>&host=<ip>&iface=<local ip>]   (E1.31, multicast unless host=)
//   artnet://<host>/<universe>/<channel>
// sends DMX instead of OSC. The value the button sends IS the DMX level, so the
// normal editor fields program it: Value = press level, Release value = hold
// release level, Off value = toggle off level, mode tap/toggle/hold. Floats in
// 0..1 are scaled to 0..255. A used universe is streamed continuously (a node
// set to "zero on loss" reacts when ROGGER dies); quitting first returns every
// channel ROGGER drove to its default (0 when the address names none).
const dgram = require('node:dgram');
const crypto = require('node:crypto');

const FPS = 25;
const CID = crypto.randomBytes(16);

function parse(address) {
  let m = /^sacn:\/\/(\d+)\/(\d+)(?:\?(.*))?$/.exec(address);
  if (m) {
    const q = new URLSearchParams(m[3] ?? '');
    const universe = Number(m[1]);
    if (universe < 1 || universe > 63999) return null;
    const host = q.get('host') || `239.255.${universe >> 8}.${universe & 255}`;
    const def = Math.max(0, Math.min(255, Math.round(Number(q.get('default') ?? 0)) || 0));
    const p = Number(q.get('prio') ?? 100);
    const prio = Number.isFinite(p) ? Math.max(0, Math.min(200, Math.round(p))) : 100;
    return check({ proto: 'sacn', host, port: 5568, universe, channel: Number(m[2]), iface: q.get('iface') || null, def, prio });
  }
  m = /^artnet:\/\/([^/?]+)\/(\d+)\/(\d+)$/.exec(address);
  if (m) return check({ proto: 'artnet', host: m[1], port: 6454, universe: Math.min(32767, Number(m[2])), channel: Number(m[3]), iface: null, def: 0, prio: 100 });
  return null;
}
const check = t => (t.channel >= 1 && t.channel <= 512 ? t : null);

function level(args) {
  const a = args?.[0];
  const v = Number(a?.value ?? a ?? 0);
  const scaled = (a?.type === 'f' || !Number.isInteger(v)) && v > 0 && v <= 1 ? v * 255 : v;
  return Math.max(0, Math.min(255, Math.round(scaled) || 0));
}

function artnetPacket(universe, seq, data) {
  const h = Buffer.alloc(18);
  h.write('Art-Net\0', 0, 'latin1');
  h.writeUInt16LE(0x5000, 8);
  h.writeUInt16BE(14, 10);
  h[12] = seq;
  h.writeUInt16LE(universe, 14);
  h.writeUInt16BE(512, 16);
  return Buffer.concat([h, data]);
}

// options: 0x80 = preview data (visualisers only, fixtures ignore it),
// 0x40 = stream terminated (sent on quit).
function sacnPacket(universe, seq, data, priority = 100, options = 0) {
  const p = Buffer.alloc(638);
  p.writeUInt16BE(0x0010, 0);                       // root layer
  p.write('ASC-E1.17\0\0\0', 4, 'latin1');
  p.writeUInt16BE(0x7000 | (638 - 16), 16);
  p.writeUInt32BE(0x00000004, 18);
  CID.copy(p, 22);
  p.writeUInt16BE(0x7000 | (638 - 38), 38);         // framing layer
  p.writeUInt32BE(0x00000002, 40);
  p.write('ROGGER', 44, 'utf8');
  p[108] = priority;
  p[111] = seq;
  p[112] = options;
  p.writeUInt16BE(universe, 113);
  p.writeUInt16BE(0x7000 | (638 - 115), 115);       // DMP layer
  p[117] = 0x02;
  p[118] = 0xa1;
  p.writeUInt16BE(0x0001, 121);
  p.writeUInt16BE(513, 123);
  data.copy(p, 126);                                // start code 0 at 125
  return p;
}

class DmxOut {
  constructor(socketFactory = () => dgram.createSocket({ type: 'udp4', reuseAddr: true })) {
    this.socketFactory = socketFactory;
    this.sockets = new Map();  // iface|'' -> socket (opened on first use)
    this.outs = new Map();     // `${proto}|${host}|${universe}|${iface}` -> out
    this.rest = new Map();     // `${outKey}|${channel}` -> { out, channel, level }
    this.seq = 1;
    this.timer = null;
    this.preview = false;      // sACN preview data: visualisers see it, fixtures ignore it
  }

  setPreview(on) { this.preview = !!on; this.flush(); return this.preview; }

  socket(iface) {
    const k = iface ?? '';
    let s = this.sockets.get(k);
    if (!s) {
      s = this.socketFactory();
      s.on?.('error', () => {});
      s.bind?.(() => {
        try { s.setBroadcast(true); s.setMulticastTTL(8); if (iface) s.setMulticastInterface(iface); } catch {}
      });
      this.sockets.set(k, s);
    }
    return s;
  }

  // true when the address was a DMX address (handled here, not OSC)
  handle(address, args) {
    const t = parse(address);
    if (!t) return false;
    const key = `${t.proto}|${t.host}|${t.universe}|${t.iface ?? ''}`;
    let out = this.outs.get(key);
    if (!out) this.outs.set(key, out = { ...t, data: Buffer.alloc(512) });
    const v = level(args);
    out.data[t.channel - 1] = v;
    const rk = `${key}|${t.channel}`;
    this.rest.set(rk, { out, channel: t.channel, level: t.def, prio: t.prio });
    // one sACN source = one priority per universe: the highest any of its channels asks for
    out.priority = Math.max(...[...this.rest.values()].filter(r => r.out === out).map(r => r.prio));
    this.sendOut(out);
    if (!this.timer) this.timer = setInterval(() => this.flush(), 1000 / FPS);
    return true;
  }

  sendOut(out, options = 0) {
    const pkt = out.proto === 'sacn'
      ? sacnPacket(out.universe, this.seq, out.data, out.priority ?? 100, options | (this.preview ? 0x80 : 0))
      : artnetPacket(out.universe, this.seq, out.data);
    this.socket(out.iface).send(pkt, out.port, out.host, () => {});
    this.seq = this.seq % 255 + 1;
  }

  flush() { for (const out of this.outs.values()) this.sendOut(out); }

  close() {
    clearInterval(this.timer);
    this.timer = null;
    for (const r of this.rest.values()) r.out.data[r.channel - 1] = r.level;
    this.flush();
    // E1.31 6.2.6: three packets with Stream_Terminated so receivers drop us at once
    for (let i = 0; i < 3; i += 1) for (const out of this.outs.values()) if (out.proto === 'sacn') this.sendOut(out, 0x40);
  }

  // The renderer reports every DMX address the config still uses; streams no
  // other address needs any more (an edited button, a deleted safety) are
  // closed with Stream_Terminated instead of streaming zeros forever.
  retain(addresses) {
    const keep = new Set();
    const keepCh = new Set();
    for (const a of addresses ?? []) {
      const t = parse(a);
      if (!t) continue;
      const key = `${t.proto}|${t.host}|${t.universe}|${t.iface ?? ''}`;
      keep.add(key);
      keepCh.add(`${key}|${t.channel}`);
    }
    for (const [rk, r] of this.rest) if (!keepCh.has(rk)) this.rest.delete(rk);
    for (const [key, out] of this.outs) {
      if (keep.has(key)) continue;
      if (out.proto === 'sacn') for (let i = 0; i < 3; i += 1) this.sendOut(out, 0x40);
      this.outs.delete(key);
    }
    for (const out of this.outs.values()) {
      const prios = [...this.rest.values()].filter(r => r.out === out).map(r => r.prio);
      if (prios.length) out.priority = Math.max(...prios);
    }
  }

  // For the DMX monitor: every stream and the channels ROGGER drives in it.
  snapshot() {
    return {
      preview: this.preview,
      streams: [...this.outs.values()].map(out => ({
        proto: out.proto, host: out.host, universe: out.universe, iface: out.iface,
        priority: out.proto === 'sacn' ? (out.priority ?? 100) : null,
        channels: [...this.rest.values()].filter(r => r.out === out)
          .map(r => ({ channel: r.channel, value: out.data[r.channel - 1], default: r.level }))
          .sort((a, b) => a.channel - b.channel),
      })).sort((a, b) => a.universe - b.universe),
    };
  }
}

module.exports = { DmxOut, parse, level, sacnPacket, artnetPacket };
