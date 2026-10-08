// TON address helpers (raw "0:<hex>" <-> user-friendly base64url) without @ton/core,
// so mock mode and tests do not need the chain SDK.

const RAW_RE = /^(-?\d+):([0-9a-fA-F]{64})$/;
const FRIENDLY_RE = /^[A-Za-z0-9+/_-]{48}$/;

/** CRC16-XModem as used by TON friendly addresses. */
export function crc16(bytes) {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc;
}

/**
 * Parse a raw or friendly address.
 * @param {string} input
 * @returns {{workchain:number, hash:string, bounceable?:boolean, testOnly?:boolean}}
 */
export function parseAddress(input) {
  const s = String(input ?? '').trim();
  const raw = RAW_RE.exec(s);
  if (raw) return { workchain: Number(raw[1]), hash: raw[2].toLowerCase() };
  if (!FRIENDLY_RE.test(s)) throw new Error(`Not a TON address: ${s.slice(0, 80)}`);
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length !== 36) throw new Error(`Bad TON address length: ${s}`);
  const crc = (buf[34] << 8) | buf[35];
  if (crc16(buf.subarray(0, 34)) !== crc) throw new Error(`Bad TON address checksum: ${s}`);
  let tag = buf[0];
  const testOnly = (tag & 0x80) !== 0;
  if (testOnly) tag ^= 0x80;
  if (tag !== 0x11 && tag !== 0x51) throw new Error(`Unknown TON address tag: ${s}`);
  const workchain = buf[1] === 0xff ? -1 : buf[1];
  return { workchain, hash: buf.subarray(2, 34).toString('hex'), bounceable: tag === 0x11, testOnly };
}

export function isAddress(input) {
  try {
    parseAddress(input);
    return true;
  } catch {
    return false;
  }
}

/** Canonical internal key: "0:<lowercase hex>". */
export function toRaw(input) {
  const a = parseAddress(input);
  return `${a.workchain}:${a.hash}`;
}

/** User-friendly url-safe form (EQ.../UQ...). */
export function toFriendly(input, { bounceable = true, testOnly = false } = {}) {
  const a = parseAddress(input);
  const buf = Buffer.alloc(36);
  buf[0] = (bounceable ? 0x11 : 0x51) | (testOnly ? 0x80 : 0);
  buf[1] = a.workchain === -1 ? 0xff : a.workchain;
  Buffer.from(a.hash, 'hex').copy(buf, 2);
  const crc = crc16(buf.subarray(0, 34));
  buf[34] = crc >> 8;
  buf[35] = crc & 0xff;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

export function sameAddress(a, b) {
  try {
    return toRaw(a) === toRaw(b);
  } catch {
    return false;
  }
}

/** Short display form: EQAB…xyz1 */
export function shortAddr(input) {
  try {
    const f = toFriendly(input);
    return `${f.slice(0, 6)}…${f.slice(-4)}`;
  } catch {
    return String(input).slice(0, 12);
  }
}
