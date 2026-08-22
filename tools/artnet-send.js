#!/usr/bin/env node
'use strict';
/**
 * Zero-dependency Art-Net (ArtDmx) sender for testing the ROGGER MA3
 * channel map end-to-end without a real console.
 *
 * Keeps a persistent 512-byte DMX frame, applies --set ch=value pairs to
 * it, and sends ArtDmx packets on UDP port 6454:
 *   "Art-Net\0"  8 bytes, NUL-terminated ID
 *   OpCode       0x5000, little-endian u16   (ArtDmx)
 *   ProtVer      14, big-endian u16
 *   Sequence     u8, 0 = sequencing disabled, else wraps 1..255
 *   Physical     u8, 0
 *   SubUni       universe & 0xff             (low byte, Art-Net 4 style)
 *   Net          (universe >> 8) & 0x7f      (high byte / net)
 *   Length       512, big-endian u16
 *   Data         512 bytes
 *
 * Examples:
 *   node tools/artnet-send.js --host 127.0.0.1 --universe 0 --set 1=255,15=255 --seconds 2 --fps 30
 *   node tools/artnet-send.js --host 192.168.20.157 --universe 0 --pulse 15
 *   node tools/artnet-send.js --host 127.0.0.1 --universe 0 --set 1=255 --hold
 *   node tools/artnet-send.js --broadcast --universe 0 --set 36=64
 */
const dgram = require('node:dgram');

const ART_NET_PORT = 6454;
const UNICAST_DEFAULT_HOST = '127.0.0.1';
const BROADCAST_ADDR_LOW_UNIVERSE = '2.255.255.255'; // Art-Net's own convention for net 0
const BROADCAST_ADDR_LIMITED = '255.255.255.255';

function parseArgs(argv) {
  const args = {
    host: null, port: ART_NET_PORT, universe: 0, set: [], seconds: 1, fps: 30,
    hold: false, pulse: null, pulseMs: 300, broadcast: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--host': args.host = next(); break;
      case '--port': args.port = parseInt(next(), 10); break;
      case '--universe': args.universe = parseInt(next(), 10); break;
      case '--set': args.set.push(next()); break;
      case '--seconds': args.seconds = parseFloat(next()); break;
      case '--fps': args.fps = parseFloat(next()); break;
      case '--hold': args.hold = true; break;
      case '--pulse': args.pulse = parseInt(next(), 10); break;
      case '--pulse-ms': args.pulseMs = parseInt(next(), 10); break;
      case '--broadcast': args.broadcast = true; break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default:
        console.error(`unknown argument: ${a}`);
        printHelp();
        process.exit(1);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node tools/artnet-send.js [options]

  --host <ip>        unicast destination (default 127.0.0.1, ignored with --broadcast)
  --port <n>          UDP port (default 6454)
  --universe <n>       0-based Art-Net universe index (default 0)
  --set ch=v[,ch=v...] set DMX channel(s) 1..512 to value 0..255 (repeatable)
  --seconds <n>         how long to keep sending (default 1)
  --fps <n>              send rate (default 30)
  --hold                 send forever until Ctrl-C (ignores --seconds)
  --pulse <ch>            press channel to 255 for --pulse-ms then release to 0
  --pulse-ms <n>           pulse hold duration in ms (default 300)
  --broadcast              broadcast instead of unicast (2.255.255.255 for net 0, else 255.255.255.255)
`);
}

function applySet(frame, setArgs) {
  for (const group of setArgs) {
    for (const pair of group.split(',')) {
      const [chStr, vStr] = pair.split('=');
      const ch = parseInt(chStr, 10);
      const v = parseInt(vStr, 10);
      if (!Number.isInteger(ch) || ch < 1 || ch > 512 || !Number.isInteger(v) || v < 0 || v > 255) {
        throw new Error(`bad --set entry: "${pair}" (expected ch=value, ch 1-512, value 0-255)`);
      }
      frame[ch - 1] = v;
    }
  }
}

function buildArtDmxPacket(frame, universe, sequence) {
  const packet = Buffer.alloc(18 + 512);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(0x5000, 8);          // OpCode (little-endian per spec)
  packet.writeUInt16BE(14, 10);             // ProtVer (big-endian)
  packet.writeUInt8(sequence & 0xff, 12);   // Sequence
  packet.writeUInt8(0, 13);                 // Physical
  packet.writeUInt8(universe & 0xff, 14);   // SubUni (low byte)
  packet.writeUInt8((universe >> 8) & 0x7f, 15); // Net (high byte)
  packet.writeUInt16BE(512, 16);            // Length
  frame.copy(packet, 18);
  return packet;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const frame = Buffer.alloc(512, 0);

  try {
    applySet(frame, args.set);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const dest = args.broadcast
    ? (args.universe === 0 ? BROADCAST_ADDR_LOW_UNIVERSE : BROADCAST_ADDR_LIMITED)
    : (args.host || UNICAST_DEFAULT_HOST);

  const sock = dgram.createSocket('udp4');
  if (args.broadcast) sock.bind(() => sock.setBroadcast(true));

  let sequence = 1;
  let sent = 0;

  const send = () => {
    const packet = buildArtDmxPacket(frame, args.universe, sequence);
    sequence = sequence >= 255 ? 1 : sequence + 1;
    sent++;
    sock.send(packet, args.port, dest, (err) => {
      if (err) console.error('send error:', err.message);
    });
  };

  const intervalMs = Math.max(1, Math.round(1000 / args.fps));

  const finish = () => {
    clearInterval(timer);
    console.log(`sent ${sent} ArtDmx packet(s) to ${dest}:${args.port} universe ${args.universe}`);
    sock.close();
  };

  process.on('SIGINT', () => { finish(); process.exit(0); });

  if (args.pulse !== null) {
    if (args.pulse < 1 || args.pulse > 512) {
      console.error('--pulse channel must be 1-512');
      process.exit(1);
    }
    frame[args.pulse - 1] = 255;
    send();
    setTimeout(() => {
      frame[args.pulse - 1] = 0;
      send();
      sock.close();
      console.log(`pulsed channel ${args.pulse} on universe ${args.universe} (${args.pulseMs}ms) to ${dest}:${args.port}`);
    }, args.pulseMs);
    return;
  }

  const timer = setInterval(send, intervalMs);
  send(); // fire the first frame immediately

  if (!args.hold) {
    setTimeout(finish, Math.max(0, args.seconds * 1000));
  } else {
    console.log(`holding — sending to ${dest}:${args.port} universe ${args.universe} at ${args.fps}fps, Ctrl-C to stop`);
  }
}

main();
