// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 Roger Klaveness
// SM-87: samples put into a firmware package (.fwsc) in the browser, tools/mkrom.py's packaging in JavaScript:
// the sample bank made (app/s700/s7bank.h), the package opened, the bank put at the top of the firmware's slot, the
// package's checksums made again. documentation/sample-bank.md has the formats; test/bank_js_test.mjs checks this
// gives mkrom.py's bytes (and so fm1-base's tools/fm1pkg_make.py's). No imports: a page copies this file as it is
// (with sm87bank.d.ts for TypeScript).
//
//   const pkg = new Sm87Package(bytes);              // throws Sm87BankError (its code says why)
//   pkg.identity, pkg.room, pkg.contents()           // what it holds
//   pkg.put(makeBank(samples, kit)); pkg.bytes()     // the package with them; pkg.put(null): without
//
// A sample: {slot 0-15, name, words (12-bit offset binary, 0-4095: 2048 is silence), params (the 155 SPRM values),
// pressure 0-99}. A kit (it replaces the firmware's drum kit; null keeps that): {sounds: up to 64 of {name (up to 6),
// words, rate (a rate code, 36-76), vel (velocity's say in its level, 0-99)}, pads: up to 16 of {name, sound (the
// kit's 0.., then the sampler's slots after them; NO_SOUND), tune (semitones, -24..24), level 0-99, pan -3..3, note,
// group 0-9 (pads that cut each other), poly 1-2}} in the pads' order: hr16Pads makes them from the HR-16's drums.

export const SLOTS = 16;
export const MAX_WORDS = 32752;
export const NPARAM = 155;
export const BANK_VERSION = 2;
export const KIT_SOUNDS = 64;                  // a kit's sounds, at most
export const PADS = 16;                        // its pads
export const NO_SOUND = 0xFF;                  // a pad without a sound
export const RATE_LO = 36, RATE_HI = 76;       // the sampler's rate codes (RECBW)
const BANK_MAGIC = 0x4B423753;                 // "S7BK"
const BANK_ENTRY = 188;
const BANK_SOUND = 16;
const BANK_PAD = 16;
const BANK_FOOT = 32;
const BANK_NAME = 24;
const KIT_NAME = 6;
const VEL = 60;                                // a kit sound's velocity's say unless told (resources/kit/kit.txt)
const PAD_KEYS = ["sound", "tune", "level", "pan", "note", "group", "poly"];
const SIGNED = new Set(["tune", "pan"]);
const PAD_RANGE = { tune: [-24, 24], level: [0, 99], pan: [-3, 3], note: [0, 127], group: [0, 9], poly: [1, 2] };
const PAD_DEFAULT = { sound: NO_SOUND, tune: 0, level: 85, pan: 0, note: 36, group: 0, poly: 1 };
const DESC_MAGIC = [..."SM87 S7 BANK"].map((c) => c.charCodeAt(0));   // s7_bank_desc_t, in the firmware's image
const MARKS = 20, MARK_BLK = 0x30, MARK_KEEP = 0x2F;   // .fwsc: a marker byte after each of the first 20 blocks
const APP_AREA = 0x4000;                       // flash.bin: the app area from here, SFC-ciphered with the chip key

export class Sm87BankError extends Error {
  // code: "not-package", "no-bank" (a firmware that takes none), "format" (another bank format), "damaged-bank",
  // "stray" (something above the firmware that isn't samples), "too-big", "bad-sample"
  constructor(code, message) {
    super(message);
    this.name = "Sm87BankError";
    this.code = code;
  }
}

// ------------------------------------------------------------------------------------------- checksums, ciphers ---
const T16 = new Uint16Array(256);
const T32 = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8, d = i;
  for (let k = 0; k < 8; k++) {
    c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    d = d & 1 ? (d >>> 1) ^ 0xEDB88320 : d >>> 1;
  }
  T16[i] = c & 0xFFFF;
  T32[i] = d >>> 0;
}

// CRC-16, polynomial 0x1021, initial 0: the package's (fm1pkg_make.py crc16)
export function crc16(b) {
  let c = 0;
  for (let i = 0; i < b.length; i++) c = ((c << 8) & 0xFFFF) ^ T16[((c >> 8) ^ b[i]) & 0xFF];
  return c;
}

// CRC-32, zlib's: the bank's
export function crc32(b) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < b.length; i++) c = (c >>> 8) ^ T32[(c ^ b[i]) & 0xFF];
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// JieLi's ENC stream cipher, in place (fm1pkg_make.py enc)
function enc(b, off, n, key = 0xFFFF) {
  for (let i = 0; i < n; i++) {
    b[off + i] ^= key & 0xFF;
    key = ((key << 1) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xFFFF;
  }
}

// SFC: ENC in 32-byte blocks, each keyed with its offset (fm1pkg_make.py sfc, base 0)
function sfc(b, n, key) {
  for (let i = 0; i < n; i += 32) enc(b, i, Math.min(n - i, 32), key ^ (i >> 2));
}

function chipKeyDecode(d) {
  let sum = 0;
  for (let i = 0; i < 16; i++) sum += d[i];
  sum &= 0xFF;
  sum = sum >= 0xE0 ? 0xAA : sum <= 0x10 ? 0x55 : sum;
  let key = 0;
  for (let i = 0; i < 16; i++) if ((d[16 + i] ^ d[15 - i]) < sum) key |= 1 << i;
  return key;
}

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const deciphered = (b) => { const c = b.slice(); enc(c, 0, c.length); return c; };

// ---------------------------------------------------------------------------------------------------- the bank ---
// a name as the bank keeps it: printable ASCII (another character a "?"), up to 23 (mkrom.py c_name)
export function bankName(s) {
  return Array.from(String(s), (ch) => {
    const c = ch.codePointAt(0);
    return c >= 32 && c < 127 && ch !== '"' && ch !== "\\" ? ch : "?";
  }).slice(0, BANK_NAME - 1).join("");
}

// the bytes a sample of n words takes packed (S7_PACKED: a pad byte last)
export const packedSize = (n) => Math.floor((n + 1) / 2) * 3 + 1;

// two words to three bytes, then the pad byte (app/s700/s7.h)
export function packWords(words) {
  const out = new Uint8Array(packedSize(words.length));
  for (let i = 0, o = 0; i < words.length; i += 2, o += 3) {
    const a = words[i], b = i + 1 < words.length ? words[i + 1] : 0;
    out[o] = a & 0xFF;
    out[o + 1] = (a >> 8) | ((b & 15) << 4);
    out[o + 2] = b >> 4;
  }
  return out;
}

export function unpackWords(packed, n) {
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const o = (i >> 1) * 3;
    out[i] = i & 1 ? (packed[o + 1] >> 4) | (packed[o + 2] << 4) : packed[o] | ((packed[o + 1] & 15) << 8);
  }
  return out;
}

function checkSample(s, i) {
  const bad = (why) => { throw new Sm87BankError("bad-sample", `sample ${i + 1} (${s && s.name}): ${why}`); };
  if (!Number.isInteger(s.slot) || s.slot < 0 || s.slot >= SLOTS) bad(`slot ${s.slot}: not 0-15`);
  checkWords(s.words, bad);
  if (!s.params || s.params.length !== NPARAM) bad(`${s.params && s.params.length} parameters: not ${NPARAM}`);
  for (let k = 0; k < NPARAM; k++)
    if (!Number.isInteger(s.params[k]) || s.params[k] < 0 || s.params[k] > 255) bad(`parameter ${k} is ${s.params[k]}`);
  const p = s.pressure ?? 0;
  if (!Number.isInteger(p) || p < 0 || p > 99) bad(`pressure ${p}: not 0-99`);
}

function checkWords(words, bad) {
  if (!words || words.length < 1 || words.length > MAX_WORDS) bad(`${words && words.length} words: not 1-${MAX_WORDS}`);
  for (let k = 0; k < words.length; k++)
    if (!Number.isInteger(words[k]) || words[k] < 0 || words[k] > 4095) bad(`word ${k} is ${words[k]}: not 0-4095`);
}

const inRange = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

function checkKit(kit) {
  const sounds = kit.sounds || [], pads = kit.pads || [];
  const bad = (why) => { throw new Sm87BankError("bad-sample", `the kit: ${why}`); };
  if (sounds.length > KIT_SOUNDS || pads.length > PADS)
    bad(`${sounds.length} sounds and ${pads.length} pads: at most ${KIT_SOUNDS} and ${PADS}`);
  for (const x of [...sounds, ...pads])
    if (typeof x.name !== "string" || !/^[\x00-\x7F]*$/.test(x.name) || x.name.length > KIT_NAME)
      bad(`${x.name}: a name of up to ${KIT_NAME} characters`);
  sounds.forEach((x, i) => {
    checkWords(x.words, (why) => bad(`sound ${i + 1} (${x.name}): ${why}`));
    if (!inRange(x.rate, RATE_LO, RATE_HI))
      bad(`sound ${i + 1} (${x.name}): rate code ${x.rate}: not ${RATE_LO}-${RATE_HI}`);
    if (!inRange(x.vel ?? VEL, 0, 99)) bad(`sound ${i + 1} (${x.name}): vel ${x.vel}: not 0-99`);
  });
  pads.forEach((q, i) => {
    const v = { ...PAD_DEFAULT, ...q };
    if (!(v.sound === NO_SOUND || inRange(v.sound, 0, sounds.length + SLOTS - 1)))
      bad(`pad ${i + 1} (${q.name}): sound ${v.sound}: not one of its ${sounds.length} or the 16 slots`);
    for (const [k, [lo, hi]] of Object.entries(PAD_RANGE))
      if (!inRange(v[k], lo, hi)) bad(`pad ${i + 1} (${q.name}): ${k} ${v[k]}: not ${lo}-${hi}`);
  });
}

// the bank's bytes, its footer last (mkrom.py bank): up to 16 samples, a slot each, in slot order; and a drum kit, or
// none (the firmware's own plays)
export function makeBank(samples, kit = null) {
  const list = [...samples].sort((a, b) => a.slot - b.slot);
  if (list.length > SLOTS) throw new Sm87BankError("bad-sample", `${list.length} samples: at most ${SLOTS}`);
  list.forEach(checkSample);
  for (let i = 1; i < list.length; i++)
    if (list[i].slot === list[i - 1].slot)
      throw new Sm87BankError("bad-sample", `two samples in slot ${list[i].slot + 1}`);
  if (kit) checkKit(kit);
  const sounds = kit ? kit.sounds || [] : [], pads = kit ? kit.pads || [] : [];
  const packed = [...list.map((s) => packWords(s.words)), ...sounds.map((x) => packWords(x.words))];
  const head = list.length * BANK_ENTRY + sounds.length * BANK_SOUND + pads.length * BANK_PAD;
  const size = packed.reduce((n, p) => n + ((p.length + 3) & ~3), head);
  const out = new Uint8Array(size + BANK_FOOT);
  const dv = view(out);
  const where = [];
  let at = head;
  for (const p of packed) {
    where.push(at);
    out.set(p, at);
    at += (p.length + 3) & ~3;
  }
  const name = (o, s) => [...s].forEach((ch, k) => { out[o + k] = ch.charCodeAt(0); });
  list.forEach((s, i) => {
    const e = i * BANK_ENTRY;
    out[e] = s.slot;
    out[e + 1] = s.pressure ?? 0;
    dv.setUint16(e + 2, s.words.length, true);
    dv.setUint32(e + 4, where[i], true);
    name(e + 8, bankName(s.name));
    out.set(s.params, e + 32);
  });
  sounds.forEach((x, i) => {
    const e = list.length * BANK_ENTRY + i * BANK_SOUND;
    dv.setUint16(e, x.words.length, true);
    out[e + 2] = x.rate;
    out[e + 3] = x.vel ?? VEL;
    dv.setUint32(e + 4, where[list.length + i], true);
    name(e + 8, x.name);
  });
  pads.forEach((q, i) => {
    const e = list.length * BANK_ENTRY + sounds.length * BANK_SOUND + i * BANK_PAD;
    const v = { ...PAD_DEFAULT, ...q };
    name(e, q.name);
    PAD_KEYS.forEach((k, j) => { out[e + 8 + j] = v[k] & 0xFF; });
  });
  dv.setUint32(size, BANK_MAGIC, true);
  dv.setUint16(size + 4, BANK_VERSION, true);
  dv.setUint16(size + 6, list.length, true);
  dv.setUint32(size + 8, size, true);
  dv.setUint32(size + 12, crc32(out.subarray(0, size)), true);
  dv.setUint16(size + 16, sounds.length, true);
  dv.setUint16(size + 18, pads.length, true);
  dv.setUint32(size + 28, crc32(out.subarray(size, size + 28)), true);
  return out;
}

// the bytes the bank ending at the end of top takes, footer and all, by its footer alone (0: none; a damaged footer
// throws): one whose contents don't check (readBank) can still be taken out or replaced (mkrom.py bank_size)
function bankSize(top) {
  if (top.length < BANK_FOOT) return 0;
  const f = top.length - BANK_FOOT, dv = view(top);
  if (dv.getUint32(f, true) !== BANK_MAGIC) return 0;
  const size = dv.getUint32(f + 8, true);
  if (crc32(top.subarray(f, f + 28)) !== dv.getUint32(f + 28, true) || size & 3 || size > f)
    throw new Sm87BankError("damaged-bank", "the package's samples don't check (its footer)");
  return size + BANK_FOOT;
}

// the bank ending at the end of top, checked as the firmware checks it (s7bank.c): {samples, kit (null for none),
// size (its bytes)}, each sample and kit sound with its words; null without one; Sm87BankError "damaged-bank" for
// one that doesn't check
export function readBank(top) {
  if (top.length < BANK_FOOT) return null;
  const f = top.length - BANK_FOOT, dv = view(top);
  if (dv.getUint32(f, true) !== BANK_MAGIC) return null;
  const damaged = (why) => { throw new Sm87BankError("damaged-bank", `the package's samples don't check (${why})`); };
  const count = dv.getUint16(f + 6, true), size = dv.getUint32(f + 8, true);
  const nsnd = dv.getUint16(f + 16, true), npad = dv.getUint16(f + 18, true);
  const head = count * BANK_ENTRY + nsnd * BANK_SOUND + npad * BANK_PAD;
  if (crc32(top.subarray(f, f + 28)) !== dv.getUint32(f + 28, true)) damaged("its footer");
  if (dv.getUint16(f + 4, true) !== BANK_VERSION) damaged(`format ${dv.getUint16(f + 4, true)}`);
  if (count > SLOTS || nsnd > KIT_SOUNDS || npad > PADS || size & 3 || size > f || head > size) damaged("its size");
  const base = f - size;
  if (crc32(top.subarray(base, f)) !== dv.getUint32(f + 12, true)) damaged("its CRC");
  const wordsIn = (at, n) =>
    n >= 1 && n <= MAX_WORDS && at >= head && !(at & 3) && at <= size && packedSize(n) <= size - at;
  const words = (at, n) => unpackWords(top.subarray(base + at, base + at + packedSize(n)), n);
  const text = (o, n) => {
    let t = "";
    for (let k = 0; k < n && top[o + k]; k++) t += String.fromCharCode(top[o + k]);
    return t;
  };
  const nulsFrom = (o, from, n) => top.subarray(o + from, o + n).every((x) => x === 0);
  const samples = [];
  for (let i = 0; i < count; i++) {
    const e = base + i * BANK_ENTRY;
    const slot = top[e], n = dv.getUint16(e + 2, true), at = dv.getUint32(e + 4, true);
    if (slot >= SLOTS || !wordsIn(at, n) || top[e + 8 + BANK_NAME - 1]) damaged(`sample ${i + 1}`);
    samples.push({ slot, name: text(e + 8, BANK_NAME), pressure: top[e + 1], params: top.slice(e + 32, e + 32 + NPARAM),
                   words: words(at, n) });
  }
  const sounds = [], pads = [];
  for (let i = 0; i < nsnd; i++) {
    const e = base + count * BANK_ENTRY + i * BANK_SOUND;
    const n = dv.getUint16(e, true), rate = top[e + 2], vel = top[e + 3], at = dv.getUint32(e + 4, true);
    if (!wordsIn(at, n) || rate < RATE_LO || rate > RATE_HI || vel > 99 || !nulsFrom(e + 8, KIT_NAME, 8))
      damaged(`the kit's sound ${i + 1}`);
    sounds.push({ name: text(e + 8, 8), rate, vel, words: words(at, n) });
  }
  for (let i = 0; i < npad; i++) {
    const e = base + count * BANK_ENTRY + nsnd * BANK_SOUND + i * BANK_PAD;
    const q = { name: text(e, 8) };
    PAD_KEYS.forEach((k, j) => { q[k] = SIGNED.has(k) ? dv.getInt8(e + 8 + j) : top[e + 8 + j]; });
    if (!nulsFrom(e, KIT_NAME, 8) || !(q.sound === NO_SOUND || q.sound < nsnd + SLOTS) ||
        Object.entries(PAD_RANGE).some(([k, [lo, hi]]) => q[k] < lo || q[k] > hi)) damaged(`the kit's pad ${i + 1}`);
    pads.push(q);
  }
  return { samples, kit: nsnd || npad ? { sounds, pads } : null, size: size + BANK_FOOT };
}

// the HR-16's 16 drums, in its order (its dumps', its manual's), each with the pad SM-87 plays it on (hr16/hrdump.h
// HD_PAD) and the set-up a kit gives that pad: its name, its MIDI note (General MIDI's), the hats' group, two voices
// for the cymbals
export const HR16_DRUMS = [
  { drum: "KICK", pad: 0, name: "KICK", note: 36 },
  { drum: "SNARE", pad: 1, name: "SNARE", note: 38 },
  { drum: "CLS HAT", pad: 2, name: "CLHAT", note: 42, group: 1 },
  { drum: "MID HAT", pad: 6, name: "MDHAT", note: 44, group: 1 },
  { drum: "OPN HAT", pad: 3, name: "OPHAT", note: 46, group: 1 },
  { drum: "CLAPS", pad: 7, name: "CLAPS", note: 39 },
  { drum: "PERC3", pad: 14, name: "PERC3", note: 62 },
  { drum: "PERC4", pad: 15, name: "PERC4", note: 64 },
  { drum: "TOM1", pad: 8, name: "TOM1", note: 50 },
  { drum: "TOM2", pad: 9, name: "TOM2", note: 48 },
  { drum: "TOM3", pad: 10, name: "TOM3", note: 45 },
  { drum: "TOM4", pad: 11, name: "TOM4", note: 41 },
  { drum: "RIDE", pad: 5, name: "RIDE", note: 51, poly: 2 },
  { drum: "CRASH", pad: 4, name: "CRASH", note: 49, poly: 2 },
  { drum: "PERC1", pad: 12, name: "PERC1", note: 56 },
  { drum: "PERC2", pad: 13, name: "PERC2", note: 54 },
];

// a kit's 16 pads from what each of the HR-16's drums plays, in HR16_DRUMS' order: {sound (the kit's, or a slot after
// them), tune, level, pan}, or null for a drum without one; each pad named, on its note and in its group as
// HR16_DRUMS has it
export function hr16Pads(byDrum) {
  const pads = new Array(PADS);
  HR16_DRUMS.forEach((d, i) => {
    const x = byDrum[i] || { sound: NO_SOUND };
    pads[d.pad] = { ...PAD_DEFAULT, group: d.group ?? 0, poly: d.poly ?? 1, ...x, name: d.name, note: d.note };
  });
  return pads;
}

// ------------------------------------------------------------------------------------------------- the package ---
// a firmware package (fm1-base tools/fm1pkg_make.py) opened: its app.bin plain, where the firmware's image in it ends
// (its s7_bank_desc_t), the room above it (mkrom.py Package)
export class Sm87Package {
  constructor(bytes, name = "the package") {
    const raw = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.name = name;
    this.raw = raw.slice();
    if (raw.length < MARKS * MARK_BLK + 0x40) this.fail("too short");
    let id = "";
    for (let i = 0; i < MARKS; i++) {
      const m = raw[i * MARK_BLK + MARK_KEEP];
      if (m !== 0x7D) id += String.fromCharCode((m - i - 1) & 0xFF);
    }
    this.identity = id;
    const lg = new Uint8Array(raw.length - MARKS);
    for (let i = 0; i < MARKS; i++) lg.set(raw.subarray(i * MARK_BLK, i * MARK_BLK + MARK_KEEP), i * MARK_KEEP);
    lg.set(raw.subarray(MARKS * MARK_BLK), MARKS * MARK_KEEP);
    // the UFW header and its parts: flash.bin is type 0
    const hdr = deciphered(lg.subarray(0, 0x40)), hv = view(hdr);
    const n = hv.getUint16(8, true);
    if (crc16(hdr.subarray(2)) !== hv.getUint16(0, true) || !n || 0x40 + n * 0x50 > lg.length ||
        crc16(lg.subarray(0x40, 0x40 + n * 0x50)) !== hv.getUint16(2, true)) this.fail("its header doesn't check");
    let part = -1, ent;
    for (let i = 0; i < n && part < 0; i++) {
      ent = deciphered(lg.subarray(0x40 + i * 0x50, 0x90 + i * 0x50));
      if (view(ent).getUint16(0, true) === 0) part = i;
    }
    if (part < 0) this.fail("no flash.bin in it");
    const off = view(ent).getUint32(8, true), len = view(ent).getUint32(12, true);
    if (off + len > lg.length) this.fail("its flash.bin is cut short");
    const flash = lg.slice(off, off + len);
    if (crc16(flash) !== view(ent).getUint16(4, true)) this.fail("its flash.bin doesn't check");
    this.lg = lg;
    this.off = off;
    this.part = part;
    this.key = this.chipKey(flash);
    // the app area: its head (a JLFS entry: the block's size), the entries after it (app.bin's), the app
    const head = flash.slice(APP_AREA, APP_AREA + 32);
    sfc(head, 32, this.key);
    const av = view(head);
    if (crc16(head.subarray(2)) !== av.getUint16(0, true))
      this.fail(`its app area doesn't open with the chip key 0x${this.key.toString(16)}`);
    const blk = av.getUint32(8, true);
    this.span = (blk + 31) & ~31;              // whole cipher blocks: ciphered back the same
    if (APP_AREA + this.span > flash.length) this.fail("its app area is bigger than its flash.bin");
    const region = flash.slice(APP_AREA, APP_AREA + this.span);
    sfc(region, this.span, this.key);
    if (crc16(region.subarray(32, blk)) !== av.getUint16(2, true)) this.fail("its app area doesn't check");
    const appName = [..."app.bin\0"].map((c) => c.charCodeAt(0));
    let entry = -1;
    for (let k = 32; k < 0x120 && entry < 0; k += 32)
      if (appName.every((c, j) => region[k + 16 + j] === c)) entry = k;
    if (entry < 0) this.fail("no app.bin in its app area");
    const rv = view(region);
    this.aOff = rv.getUint32(entry + 4, true);
    const aSize = rv.getUint32(entry + 8, true);
    if (this.aOff + aSize > region.length) this.fail("its app.bin is bigger than its app area");
    Object.assign(this, { flash, region, blk, entry });
    this.app = region.slice(this.aOff, this.aOff + aSize);
    this.describe();
  }

  fail(why) {
    throw new Sm87BankError("not-package", `${this.name}: not a firmware package samples can go into: ${why}`);
  }

  // from the flash's head: the isd_config.ini entry's blob
  chipKey(flash) {
    const want = "isd_config.ini";
    for (let o = 32; o < 0x200; o += 32) {
      const e = deciphered(flash.subarray(o, o + 32));
      let nm = "";
      for (let k = 16; k < 32 && e[k] && e[k] !== 0xFF; k++) nm += String.fromCharCode(e[k]);
      if (nm === want) {
        const at = view(e).getUint32(4, true);
        return chipKeyDecode(flash.subarray(at, at + 32));
      }
    }
    this.fail("no chip key in its head");
  }

  // the firmware's s7_bank_desc_t: where its image ends
  describe() {
    const app = this.app;
    let at = -1;
    outer: for (let i = 0; i + 36 <= app.length; i++) {
      if (app[i] !== DESC_MAGIC[0]) continue;
      for (let k = 1; k < DESC_MAGIC.length; k++) if (app[i + k] !== DESC_MAGIC[k]) continue outer;
      at = i;
      break;
    }
    if (at < 0)
      throw new Sm87BankError("no-bank", `${this.name}: its firmware doesn't take samples this way (an SM-87 from ` +
                              "before the sample bank, or another firmware)");
    const dv = view(app);
    const [version, me, load, start, end, slotEnd] = [0, 1, 2, 3, 4, 5].map((k) => dv.getUint32(at + 12 + 4 * k, true));
    const base = me - at;
    this.imageEnd = load + (end - start) - base;
    if (slotEnd - base !== app.length || !(at < this.imageEnd && this.imageEnd <= app.length) || this.imageEnd & 3)
      this.fail("its firmware's description of itself doesn't fit its slot");
    if (version !== BANK_VERSION)
      throw new Sm87BankError("format", `${this.name}: its firmware reads samples of format ${version}, this ` +
                              `writes format ${BANK_VERSION}: use the version of this for that firmware`);
  }

  get slotSize() { return this.app.length; }
  get room() { return this.app.length - this.imageEnd; }

  // what it holds: {samples, kit, size} (readBank), null for none
  contents() { return readBank(this.app.subarray(this.imageEnd)); }
  samples() { const c = this.contents(); return c ? c.samples : null; }
  kit() { const c = this.contents(); return c ? c.kit : null; }

  // the bank into the slot (null or empty: none): above the image all 0xFF, the bank at the slot's top
  put(bank) {
    const b = bank || new Uint8Array(0);
    const top = this.app.subarray(this.imageEnd);
    const size = bankSize(top);   // (not readBank: samples that don't check are replaced as any others)
    for (let i = 0; i < top.length - size; i++)
      if (top[i] !== 0xFF)
        throw new Sm87BankError("stray", `${this.name}: there's something above its firmware that isn't samples`);
    if (b.length > this.room)
      throw new Sm87BankError("too-big", `${(b.length / 1024).toFixed(1)} KB of samples: more than the ` +
                              `${(this.room / 1024).toFixed(1)} KB the firmware leaves in ${this.name}`);
    top.fill(0xFF, 0, this.room - b.length);
    top.set(b, this.room - b.length);
  }

  // the package's bytes, the app as it is now
  bytes() {
    const region = this.region.slice(), flash = this.flash.slice(), lg = this.lg.slice();
    region.set(this.app, this.aOff);
    const rv = view(region), e = this.entry;
    rv.setUint16(e + 2, crc16(this.app), true);
    rv.setUint16(e, crc16(region.subarray(e + 2, e + 32)), true);
    rv.setUint16(2, crc16(region.subarray(32, this.blk)), true);
    rv.setUint16(0, crc16(region.subarray(2, 32)), true);
    sfc(region, this.span, this.key);
    flash.set(region, APP_AREA);
    lg.set(flash, this.off);
    const at = 0x40 + this.part * 0x50;
    const ent = deciphered(lg.subarray(at, at + 0x50));
    view(ent).setUint16(4, crc16(flash), true);
    enc(ent, 0, 0x50);
    lg.set(ent, at);
    const hdr = deciphered(lg.subarray(0, 0x40)), hv = view(hdr);
    hv.setUint16(2, crc16(lg.subarray(0x40, 0x40 + hv.getUint16(8, true) * 0x50)), true);
    hv.setUint16(0, crc16(hdr.subarray(2)), true);
    enc(hdr, 0, 0x40);
    lg.set(hdr, 0);
    const raw = this.raw.slice();
    for (let i = 0; i < MARKS; i++) raw.set(lg.subarray(i * MARK_KEEP, (i + 1) * MARK_KEEP), i * MARK_BLK);
    raw.set(lg.subarray(MARKS * MARK_KEEP), MARKS * MARK_BLK);
    return raw;
  }
}
