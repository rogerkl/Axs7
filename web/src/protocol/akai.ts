// Akai X7000/S700 sample dump protocol. Ported from the Web MIDI test page (spike/js/akai.js), which was verified
// on an X7000, and before that from the Java version (Axs7Sds SampleDump/SampleTransfer).
//
// A dump is one long sysex message: a 19 byte header (F0 7E 01 ...), a number of 122 byte blocks and a final F7.
// Block: block number (mod 128), 60 samples as 12 bit offset binary in 2 bytes each, XOR checksum of the 120 data
// bytes. The receiver sends an ACK (F0 7E 7F F7) after the header and after each block.

export const MAX_SAMPLES = 32752;
export const SAMPLES_PER_BLOCK = 60;
export const MAX_BLOCKS = 546;
export const HEADER_LENGTH = 19;
export const BLOCK_LENGTH = SAMPLES_PER_BLOCK * 2 + 2;
export const BITS = 12;
export const ACK = Uint8Array.of(0xf0, 0x7e, 0x7f, 0xf7);
/** 31250 baud, 10 bits per byte (start, 8 data, stop) */
export const MIDI_BYTES_PER_SECOND = 3125;
/**
 * A standard X7000/S700 has 6 sample slots, more with a memory expansion. On an X7000 with 16 slots, slot numbers
 * above 6 address those slots, receiving and sending (verified with slot 7). Akai's note that a sample number above
 * 5 replaces the sample being edited is for a standard unit.
 */
export const STANDARD_SLOTS = 6;
/** Two digits on the display. The slot number in the protocol is 7 bits. */
export const MAX_SLOTS = 99;

export interface Bandwidth {
  name: string;
  /** sampling period in ns, as the sampler has it */
  period: number;
  rate: number;
}

/**
 * The rates the sampler plays samples at, a semitone apart. Other rates are rounded down to one of these by the
 * sampler, so samples are resampled to one before sending.
 */
export const BANDWIDTHS: Bandwidth[] = ([
  ['16khz', 25281, 39555.4], ['15khz', 26784, 37335.72], ['14khz', 28377, 35239.81],
  ['13.khz', 30064, 33262.37], ['13khz', 31852, 31395.2], ['12khz', 33746, 29633.14],
  ['11.khz', 35753, 27969.68], ['11khz', 37879, 26399.85], ['10khz', 40131, 24918.39],
  ['9.4khz', 42518, 23519.45], ['8.9khz', 45046, 22199.53], ['8.4khz', 47724, 20953.82],
  ['7.9khz', 50562, 19777.7], ['7.5khz', 53569, 18667.51], ['7.0khz', 56754, 17619.9],
  ['6.7khz', 60129, 16630.91], ['6.3khz', 63704, 15697.6], ['5.9khz', 67492, 14816.57],
  ['5.6khz', 71506, 13984.84], ['5.3khz', 75758, 13199.93], ['5.0khz', 80262, 12459.2],
  ['4.7khz', 85035, 11759.86], ['4.4khz', 90091, 11099.89], ['4.2khz', 95449, 10476.8],
  ['4.0khz', 101124, 9888.85], ['3.7khz', 107137, 9333.84], ['3.5khz', 113508, 8809.95],
  ['3.3khz', 120258, 8315.46], ['3.1khz', 127409, 7848.74], ['3.0khz', 134985, 7408.23],
  ['2.8khz', 143011, 6992.47], ['2.6khz', 151515, 6600.01], ['2.5khz', 160525, 6229.56],
  ['2.4khz', 170070, 5879.93], ['2.2khz', 180183, 5549.91], ['2.1khz', 190897, 5238.43],
  ['2.0khz', 202248, 4944.42], ['1.9khz', 214275, 4666.9], ['1.8khz', 227016, 4404.98],
  ['1.7khz', 240515, 4157.74], ['1.6khz', 254817, 3924.38],
] as const).map(([name, period, rate]) => ({ name, period, rate }));

export const BW16 = BANDWIDTHS[0];

export function cents(rate: number, reference: number): number {
  return 1200 * Math.log2(rate / reference);
}

/** @returns the bandwidth nearest in pitch, BW16 for rates above it */
export function nearestBandwidth(rate: number): Bandwidth {
  let nearest = BW16;
  for (const bw of BANDWIDTHS) {
    if (Math.abs(cents(rate, bw.rate)) < Math.abs(cents(rate, nearest.rate))) {
      nearest = bw;
    }
  }
  return nearest;
}

/** @returns true if the rate is the bandwidth's rate within the precision of a wav file (whole Hz) */
export function matchesBandwidth(bw: Bandwidth, rate: number): boolean {
  return Math.abs(cents(rate, bw.rate)) < 1;
}

/** @returns the sampler's bandwidth for the rate if it is one of the sampler's rates, null if not */
export function samplerBandwidth(rate: number): Bandwidth | null {
  const bw = nearestBandwidth(rate);
  return matchesBandwidth(bw, rate) ? bw : null;
}

/** @returns the sampling period in ns, the exact table period if the rate is one of the sampler's */
export function periodFor(rate: number): number {
  const bw = nearestBandwidth(rate);
  return matchesBandwidth(bw, rate) ? bw.period : Math.trunc(1e9 / rate);
}

/** The X7000 accepts periods from 15259 to 500000 ns, but has been seen sending garbage in this field */
export function validPeriod(period: number): boolean {
  return period >= 15259 && period <= 500000;
}

/** @returns the sample rate for a period from a received header, BW16 if the period is garbage */
export function rateForPeriod(period: number): number {
  if (!validPeriod(period)) {
    return BW16.rate;
  }
  const bw = BANDWIDTHS.find((b) => b.period === period);
  return bw ? bw.rate : 1e9 / period;
}

/** @param slot from 0 */
export function requestMessage(slot: number): Uint8Array {
  return Uint8Array.of(0xf0, 0x7e, 0x00, slot & 0x7f, 0x00, 0xf7);
}

// 21 bit value in 3 bytes, least significant 7 bits first
export function to3Bytes(value: number, out: Uint8Array, index: number): void {
  out[index] = value & 0x7f;
  out[index + 1] = (value >>> 7) & 0x7f;
  out[index + 2] = (value >>> 14) & 0x7f;
}

export function from3Bytes(bytes: ArrayLike<number>, index: number): number {
  return bytes[index] + (bytes[index + 1] << 7) + (bytes[index + 2] << 14);
}

// 12 bit value in 2 bytes: 0 d11..d5, 0 d4..d0 0 0
export function to12Bit(value: number, out: Uint8Array, index: number): void {
  out[index] = (value >>> 5) & 0x7f;
  out[index + 1] = (value << 2) & 0x7c;
}

export function from12Bit(bytes: ArrayLike<number>, index: number): number {
  return (bytes[index + 1] >>> 2) + (bytes[index] << 5);
}

/**
 * The sampler wants more words in the header than the sample has, or the end of the loop gets a discontinuity
 * (the "loop fix" of the Java version).
 */
export function headerTotalWords(numSamples: number): number {
  return Math.min(numSamples + 200, MAX_SAMPLES);
}

/**
 * As the Java version: rounded down, so it usually sends one block less than the total words in the header
 * announce. The sampler accepts that, and the words it misses are past the sample's end anyway.
 */
export function blocksToSend(numSamples: number): number {
  return Math.min(Math.floor(headerTotalWords(numSamples) / SAMPLES_PER_BLOCK), MAX_BLOCKS);
}

export interface DumpHeader {
  /** 0-5, or more for the sample being edited */
  slot: number;
  sampleRate: number;
  numSamples: number;
  loopStart: number;
  /** after the last sample in the loop, also the end of the sample on the sampler */
  loopEnd: number;
  alternating: boolean;
}

/** Clamps the header values as the Java SampleHeader does */
export function normalizeHeader(h: DumpHeader): DumpHeader {
  const numSamples = Math.min(h.numSamples, MAX_SAMPLES);
  const loopEnd = Math.min(h.loopEnd, numSamples);
  const loopStart = h.loopStart > loopEnd ? 0 : h.loopStart;
  return { ...h, numSamples, loopEnd, loopStart };
}

/** @returns the 19 header bytes, without F7 */
export function encodeHeader(header: DumpHeader): Uint8Array {
  const h = normalizeHeader(header);
  const out = new Uint8Array(HEADER_LENGTH);
  out.set([0xf0, 0x7e, 0x01, h.slot & 0x7f, 0x00, BITS]);
  to3Bytes(periodFor(h.sampleRate), out, 6);
  to3Bytes(headerTotalWords(h.numSamples), out, 9);
  to3Bytes(h.loopStart, out, 12);
  to3Bytes(h.loopEnd, out, 15);
  out[18] = h.alternating ? 1 : 0;
  return out;
}

export interface ReceivedHeader {
  slot: number;
  bits: number;
  period: number;
  periodValid: boolean;
  sampleRate: number;
  totalWords: number;
  loopStart: number;
  loopEnd: number;
  alternating: boolean;
}

export function decodeHeader(bytes: ArrayLike<number>): ReceivedHeader {
  const period = from3Bytes(bytes, 6);
  return {
    slot: bytes[3],
    bits: bytes[5],
    period,
    periodValid: validPeriod(period),
    sampleRate: rateForPeriod(period),
    totalWords: from3Bytes(bytes, 9),
    loopStart: from3Bytes(bytes, 12),
    loopEnd: from3Bytes(bytes, 15),
    alternating: bytes[18] === 1,
  };
}

/**
 * Scales samples (-1..1) to 12 bit offset binary as the Java version does
 *
 * @param gain 1, or 1/peak to normalize
 */
export function encodeSamples(data: ArrayLike<number>, gain = 1): Uint16Array {
  const half = 1 << (BITS - 1);
  const codes = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    codes[i] = Math.max(0, Math.min(4095, Math.trunc(data[i] * gain * (half - 1) + half)));
  }
  return codes;
}

export function decodeCode(code: number): number {
  return (code - 2048) / 2048;
}

export function peak(data: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    max = Math.max(max, Math.abs(data[i]));
  }
  return max;
}

/** @returns the 122 bytes of a block, without the F7 the Java version puts in front for its continuation sysex */
export function encodeBlock(blockNumber: number, codes: ArrayLike<number>, numSamples: number): Uint8Array {
  const out = new Uint8Array(BLOCK_LENGTH);
  out[0] = blockNumber % 128;
  let chk = 0;
  for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
    const index = blockNumber * SAMPLES_PER_BLOCK + s;
    to12Bit(index < numSamples ? codes[index] : 2048, out, 1 + 2 * s);
    chk ^= out[1 + 2 * s] ^ out[2 + 2 * s];
  }
  out[BLOCK_LENGTH - 1] = chk;
  return out;
}

export interface FillerOptions {
  fillerAfterHeader?: number;
  fillerPerBlock?: number;
  /** a real-time status byte, F8 timing clock or FE active sensing */
  fillerByte?: number;
}

export interface Dump {
  bytes: Uint8Array;
  numBlocks: number;
  header: DumpHeader;
}

/**
 * Builds the whole dump as one complete sysex message, which is the only way Web MIDI can send it: browsers
 * reject a send() with a sysex that isn't terminated, or that starts with a data byte. The X7000 takes it without
 * pauses between blocks.
 *
 * Real-time status bytes are allowed inside a sysex, so they can be put between blocks as filler to give the
 * sampler a pause if it ever needs one, 0.32 ms per byte.
 */
export function buildDump(header: DumpHeader, codes: ArrayLike<number>, options: FillerOptions = {}): Dump {
  const { fillerAfterHeader = 0, fillerPerBlock = 0, fillerByte = 0xf8 } = options;
  if (fillerByte < 0xf8 || fillerByte === 0xf9 || fillerByte === 0xfd) {
    throw new Error('Filler must be a real-time status byte (F8, FA-FC, FE, FF)');
  }
  const h = normalizeHeader(header);
  const numBlocks = blocksToSend(h.numSamples);
  const length = HEADER_LENGTH + fillerAfterHeader + numBlocks * BLOCK_LENGTH
    + Math.max(0, numBlocks - 1) * fillerPerBlock + 1;
  const out = new Uint8Array(length);
  out.set(encodeHeader(h), 0);
  let pos = HEADER_LENGTH;
  out.fill(fillerByte, pos, pos + fillerAfterHeader);
  pos += fillerAfterHeader;
  for (let b = 0; b < numBlocks; b++) {
    if (b > 0) {
      out.fill(fillerByte, pos, pos + fillerPerBlock);
      pos += fillerPerBlock;
    }
    out.set(encodeBlock(b, codes, h.numSamples), pos);
    pos += BLOCK_LENGTH;
  }
  out[pos] = 0xf7;
  return { bytes: out, numBlocks, header: h };
}

/** @returns seconds it takes to send the bytes on a MIDI cable */
export function wireSeconds(numBytes: number): number {
  return numBytes / MIDI_BYTES_PER_SECOND;
}

export interface ParsedDump {
  ok: boolean;
  problems: string[];
  /** known sampler behaviour, not transfer problems */
  notes: string[];
  length: number;
  header?: ReceivedHeader;
  headerBytes?: Uint8Array;
  terminated?: boolean;
  expectedBlocks?: number;
  blocks?: number;
  checksumErrors?: number;
  blockNumberErrors?: number;
  codes?: Uint16Array;
  data?: Float32Array;
  loopStart?: number;
  loopEnd?: number;
}

/**
 * Parses a received dump. In a browser it arrives as one complete message (F0 ... F7) when the sampler is done,
 * a short one if the sampler gave up (F0 header F7).
 *
 * Doesn't throw on bad data, it reports what it found so a failed transfer can be diagnosed.
 */
export function parseDump(message: Uint8Array): ParsedDump {
  // real-time bytes may be interleaved anywhere, Chrome takes them out but other sources might not
  const bytes = message.filter((b) => b < 0xf8);
  const problems: string[] = [];
  if (bytes.length < HEADER_LENGTH || bytes[0] !== 0xf0 || bytes[1] !== 0x7e || bytes[2] !== 0x01) {
    return { ok: false, problems: ['Not a sample dump: ' + hex(bytes.subarray(0, 24))], notes: [],
      length: bytes.length };
  }
  const headerBytes = bytes.slice(0, HEADER_LENGTH);
  const header = decodeHeader(headerBytes);
  const terminated = bytes[bytes.length - 1] === 0xf7;
  const end = terminated ? bytes.length - 1 : bytes.length;
  const expectedBlocks = Math.ceil(header.totalWords / SAMPLES_PER_BLOCK);
  const codes = new Uint16Array(Math.min(header.totalWords, MAX_BLOCKS * SAMPLES_PER_BLOCK));
  let blocks = 0;
  let checksumErrors = 0;
  let blockNumberErrors = 0;
  let pos = HEADER_LENGTH;
  while (end - pos >= BLOCK_LENGTH) {
    const block = bytes.subarray(pos, pos + BLOCK_LENGTH);
    const status = block.findIndex((b) => (b & 0x80) !== 0);
    if (status >= 0) {
      problems.push(`Status byte ${hex([block[status]])} inside block ${blocks}, data is out of sync`);
      break;
    }
    if (block[0] !== blocks % 128) {
      blockNumberErrors++;
      if (blockNumberErrors <= 5) {
        problems.push(`Block ${blocks} has block number ${block[0]}, expected ${blocks % 128}`);
      }
    }
    let chk = 0;
    for (let i = 1; i <= SAMPLES_PER_BLOCK * 2; i++) {
      chk ^= block[i];
    }
    if (chk !== block[BLOCK_LENGTH - 1]) {
      checksumErrors++;
    }
    for (let s = 0; s < SAMPLES_PER_BLOCK; s++) {
      const index = blocks * SAMPLES_PER_BLOCK + s;
      if (index < codes.length) {
        codes[index] = from12Bit(block, 1 + 2 * s);
      }
    }
    blocks++;
    pos += BLOCK_LENGTH;
  }
  const leftover = end - pos;
  if (leftover > 0) {
    problems.push(`${leftover} bytes after the last whole block`);
  }
  if (!terminated) {
    problems.push('Message does not end with F7');
  }
  if (blocks < expectedBlocks) {
    problems.push(`Received ${blocks} of ${expectedBlocks} blocks`);
  } else if (blocks > expectedBlocks) {
    problems.push(`Received ${blocks} blocks, more than the ${expectedBlocks} the header announced`);
  }
  if (checksumErrors > 0) {
    problems.push(`${checksumErrors} blocks with checksum errors`);
  }
  const notes = header.periodValid ? []
    : [`Invalid sample period in header (${header.period} ns), assuming ${BW16.rate} Hz`];
  const numSamples = Math.min(header.totalWords, blocks * SAMPLES_PER_BLOCK);
  const received = codes.slice(0, numSamples);
  const data = Float32Array.from(received, decodeCode);
  const ok = blocks > 0 && blocks >= expectedBlocks && checksumErrors === 0 && blockNumberErrors === 0
    && leftover === 0 && terminated;
  return {
    ok, problems, notes, length: bytes.length, header, headerBytes, terminated, expectedBlocks, blocks,
    checksumErrors, blockNumberErrors, codes: received, data,
    loopStart: Math.min(header.loopStart, numSamples), loopEnd: Math.min(header.loopEnd, numSamples),
  };
}

/** The sampler plays a sample as one shot when the loop is shorter than 5 samples */
export function isOneShot(loopStart: number, loopEnd: number): boolean {
  return loopEnd - loopStart < 5;
}

export function hex(bytes: ArrayLike<number>, separator = ' '): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(separator);
}
