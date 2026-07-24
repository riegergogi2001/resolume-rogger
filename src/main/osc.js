'use strict';
// OSC 1.0 wire codec. Pure functions, no I/O.
// Supported argument types: i (int32), f (float32), s (string).

function padded(len) {
  return (len + 4) & ~3; // string bytes incl. NUL, rounded up to 4
}

function writeString(str) {
  const raw = Buffer.from(str, 'utf8');
  const buf = Buffer.alloc(padded(raw.length));
  raw.copy(buf);
  return buf;
}

function encodeMessage(address, args = []) {
  if (typeof address !== 'string' || !address.startsWith('/')) {
    throw new Error(`invalid OSC address: ${address}`);
  }
  const parts = [writeString(address), writeString(',' + args.map(a => a.type).join(''))];
  for (const arg of args) {
    switch (arg.type) {
      case 'i': {
        const b = Buffer.alloc(4);
        b.writeInt32BE(Math.trunc(arg.value));
        parts.push(b);
        break;
      }
      case 'f': {
        const b = Buffer.alloc(4);
        b.writeFloatBE(arg.value);
        parts.push(b);
        break;
      }
      case 's':
        parts.push(writeString(String(arg.value)));
        break;
      default:
        throw new Error(`unsupported OSC arg type: ${arg.type}`);
    }
  }
  return Buffer.concat(parts);
}

function readString(buf, offset) {
  const end = buf.indexOf(0, offset);
  if (end === -1) throw new Error('unterminated OSC string');
  const value = buf.toString('utf8', offset, end);
  const next = offset + padded(end - offset);
  if (next > buf.length) throw new Error('OSC string padding out of bounds');
  return { value, next };
}

function decodeMessage(buf, offset, end, out) {
  const addr = readString(buf, offset);
  if (!addr.value.startsWith('/')) throw new Error(`invalid OSC address: ${addr.value}`);
  let args = [];
  let pos = addr.next;
  if (pos < end) {
    const tags = readString(buf, pos);
    pos = tags.next;
    if (!tags.value.startsWith(',')) throw new Error('missing OSC typetag string');
    for (const t of tags.value.slice(1)) {
      switch (t) {
        case 'i':
          if (pos + 4 > end) throw new Error('truncated int arg');
          args.push({ type: 'i', value: buf.readInt32BE(pos) });
          pos += 4;
          break;
        case 'f':
          if (pos + 4 > end) throw new Error('truncated float arg');
          args.push({ type: 'f', value: buf.readFloatBE(pos) });
          pos += 4;
          break;
        case 's': {
          const s = readString(buf, pos);
          args.push({ type: 's', value: s.value });
          pos = s.next;
          break;
        }
        case 'T': args.push({ type: 'i', value: 1 }); break; // booleans normalized to ints
        case 'F': args.push({ type: 'i', value: 0 }); break;
        case 'N': break; // nil carries no data
        default:
          throw new Error(`unsupported OSC typetag: ${t}`);
      }
    }
  }
  out.push({ address: addr.value, args });
}

function decodeInto(buf, offset, end, out) {
  if (end - offset < 4) throw new Error('OSC packet too short');
  if (buf[offset] === 0x23 /* '#' */) {
    const head = readString(buf, offset);
    if (head.value !== '#bundle') throw new Error('bad bundle header');
    let pos = head.next + 8; // skip 64-bit timetag
    while (pos < end) {
      if (pos + 4 > end) throw new Error('truncated bundle element size');
      const size = buf.readInt32BE(pos);
      pos += 4;
      if (size < 0 || pos + size > end) throw new Error('bundle element out of bounds');
      decodeInto(buf, pos, pos + size, out);
      pos += size;
    }
  } else {
    decodeMessage(buf, offset, end, out);
  }
}

// Returns a flat array of {address, args} — bundles are flattened.
function decodePacket(buf) {
  const out = [];
  decodeInto(buf, 0, buf.length, out);
  return out;
}

function inferArgs(values = []) {
  return values.map(v => {
    if (typeof v === 'number') {
      return Number.isInteger(v) ? { type: 'i', value: v } : { type: 'f', value: v };
    }
    return { type: 's', value: String(v) };
  });
}

module.exports = { encodeMessage, decodePacket, inferArgs };
