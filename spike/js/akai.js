// Akai X7000/S700 sample dump protocol, ported from the Java version (Axs7Sds SampleDump/SampleTransfer).
// Pure functions without DOM or MIDI, so they can be tested in node.
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
 * The rates the sampler plays samples at, a semitone apart, with the sampling period in ns it uses for them.
 * Other rates are rounded down to one of these by the sampler, so samples are resampled to one before sending.
 */
export const BANDWIDTHS = [
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
].map(([name, period, rate]) => ({ name, period, rate }));

export const BW16 = BANDWIDTHS[0];

export function cents(rate, reference) {
  return 1200 * Math.log2(rate / reference);
}

/** @returns the bandwidth nearest in pitch, BW16 for rates above it */
export function nearestBandwidth(rate) {
  let nearest = BW16;
  for (const bw of BANDWIDTHS) {
    if (Math.abs(cents(rate, bw.rate)) < Math.abs(cents(rate, nearest.rate))) {
      nearest = bw;
    }
  }
  return nearest;
}

/** @returns true if the rate is the bandwidth's rate within the precision of a wav file (whole Hz) */
export function matchesBandwidth(bw, rate) {
  return Math.abs(cents(rate, bw.rate)) < 1;
}

/** @returns the sampling period in ns, the exact table period if the rate is one of the sampler's */
export function periodFor(rate) {
  const bw = nearestBandwidth(rate);
  return matchesBandwidth(bw, rate) ? bw.period : Math.trunc(1e9 / rate);
}

/** The X7000 accepts periods from 15259 to 500000 ns, but has been seen sending garbage in this field */
export function validPeriod(period) {
  return period >= 15259 && period <= 500000;
}

/** @returns the sample rate for a period from a received header, BW16 if the period is garbage */
export function rateForPeriod(period) {
  if (!validPeriod(period)) {
    return BW16.rate;
  }
  const bw = BANDWIDTHS.find((b) => b.period === period);
  return bw ? bw.rate : 1e9 / period;
}

/** @param slot 0-5 */
export function requestMessage(slot) {
  return Uint8Array.of(0xf0, 0x7e, 0x00, slot & 0x7f, 0x00, 0xf7);
}

// 21 bit value in 3 bytes, least significant 7 bits first
export function to3Bytes(value, out, index) {
  out[index] = value & 0x7f;
  out[index + 1] = (value >>> 7) & 0x7f;
  out[index + 2] = (value >>> 14) & 0x7f;
}

export function from3Bytes(bytes, index) {
  return bytes[index] + (bytes[index + 1] << 7) + (bytes[index + 2] << 14);
}

// 12 bit value in 2 bytes: 0 d11..d5, 0 d4..d0 0 0
export function to12Bit(value, out, index) {
  out[index] = (value >>> 5) & 0x7f;
  out[index + 1] = (value << 2) & 0x7c;
}

export function from12Bit(bytes, index) {
  return (bytes[index + 1] >>> 2) + (bytes[index] << 5);
}

/**
 * The sampler wants more words in the header than the sample has, or the end of the loop gets a discontinuity
 * (the "loop fix" of the Java version).
 */
export function headerTotalWords(numSamples) {
  return Math.min(numSamples + 200, MAX_SAMPLES);
}

/**
 * As the Java version: rounded down, so it usually sends one block less than the total words in the header
 * announce. The sampler accepts that, and the words it misses are past the sample's end anyway.
 */
export function blocksToSend(numSamples) {
  return Math.min(Math.floor(headerTotalWords(numSamples) / SAMPLES_PER_BLOCK), MAX_BLOCKS);
}

/**
 * @typedef {object} SampleHeader
 * @property {number} slot 0-5, or more for the sample being edited
 * @property {number} sampleRate
 * @property {number} numSamples
 * @property {number} loopStart
 * @property {number} loopEnd after the last sample in the loop, also the end of the sample on the sampler
 * @property {boolean} alternating
 */

/** Clamps the header values as the Java SampleHeader does */
export function normalizeHeader(h) {
  const numSamples = Math.min(h.numSamples, MAX_SAMPLES);
  const loopEnd = Math.min(h.loopEnd, numSamples);
  const loopStart = h.loopStart > loopEnd ? 0 : h.loopStart;
  return { ...h, numSamples, loopEnd, loopStart };
}

/** @param {SampleHeader} h @returns the 19 header bytes, without F7 */
export function encodeHeader(h) {
  h = normalizeHeader(h);
  const out = new Uint8Array(HEADER_LENGTH);
  out.set([0xf0, 0x7e, 0x01, h.slot & 0x7f, 0x00, BITS]);
  to3Bytes(periodFor(h.sampleRate), out, 6);
  to3Bytes(headerTotalWords(h.numSamples), out, 9);
  to3Bytes(h.loopStart, out, 12);
  to3Bytes(h.loopEnd, out, 15);
  out[18] = h.alternating ? 1 : 0;
  return out;
}

export function decodeHeader(bytes) {
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
 * @param {ArrayLike<number>} data
 * @param {number} gain 1, or 1/peak to normalize
 */
export function encodeSamples(data, gain = 1) {
  const half = 1 << (BITS - 1);
  const codes = new Uint16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    codes[i] = Math.max(0, Math.min(4095, Math.trunc(data[i] * gain * (half - 1) + half)));
  }
  return codes;
}

export function decodeCode(code) {
  return (code - 2048) / 2048;
}

export function peak(data) {
  let max = 0;
  for (let i = 0; i < data.length; i++) {
    max = Math.max(max, Math.abs(data[i]));
  }
  return max;
}

/** @returns the 122 bytes of a block, without the F7 the Java version puts in front for its continuation sysex */
export function encodeBlock(blockNumber, codes, numSamples) {
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

/**
 * Builds the whole dump as one complete sysex message, which is the only way Web MIDI can send it: browsers
 * reject a send() with a sysex that isn't terminated, or that starts with a data byte.
 *
 * Real-time status bytes (F8 timing clock, FE active sensing) are allowed inside a sysex by the MIDI spec and by
 * Chrome, so they can be put between blocks as filler to give the sampler a pause, 0.32 ms per byte.
 *
 * @param {SampleHeader} header
 * @param {Uint16Array} codes 12 bit offset binary samples
 * @param {{fillerAfterHeader?: number, fillerPerBlock?: number, fillerByte?: number}} [options]
 */
export function buildDump(header, codes, options = {}) {
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
export function wireSeconds(numBytes) {
  return numBytes / MIDI_BYTES_PER_SECOND;
}

/**
 * Parses a received dump. In a browser it arrives as one complete message (F0 ... F7) when the sampler is done,
 * a short one if the sampler gave up (F0 header F7).
 *
 * Doesn't throw on bad data, it reports what it found so a failed transfer can be diagnosed.
 *
 * @param {Uint8Array} message
 */
export function parseDump(message) {
  // real-time bytes may be interleaved anywhere, Chrome takes them out but other sources might not
  const bytes = message.filter((b) => b < 0xf8);
  const problems = [];
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
    const status = block.findIndex((b) => b & 0x80);
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
  // known X7000 behaviour, not a transfer problem
  const notes = header.periodValid ? []
    : [`Invalid sample period in header (${header.period} ns), assuming ${BW16.rate} Hz`];
  const numSamples = Math.min(header.totalWords, blocks * SAMPLES_PER_BLOCK);
  const received = codes.slice(0, numSamples);
  const data = Float32Array.from(received, decodeCode);
  const ok = blocks > 0 && blocks >= expectedBlocks && checksumErrors === 0 && blockNumberErrors === 0
    && leftover === 0 && terminated;
  return {
    ok, problems, notes, length: bytes.length, header, headerBytes, terminated, expectedBlocks, blocks, checksumErrors,
    blockNumberErrors, codes: received, data,
    loopStart: Math.min(header.loopStart, numSamples), loopEnd: Math.min(header.loopEnd, numSamples),
  };
}

/** The sampler plays a sample as one shot when the loop is shorter than 5 samples */
export function isOneShot(loopStart, loopEnd) {
  return loopEnd - loopStart < 5;
}

/**
 * Compares sent and received 12 bit codes at the offset that matches best, as HardwareLoopback does
 */
export function compareCodes(sent, got, maxOffset = 200) {
  let bestOffset = 0;
  let bestMatches = -1;
  for (let offset = -maxOffset; offset <= maxOffset; offset++) {
    let matches = 0;
    for (let i = 0; i < sent.length; i++) {
      const j = i + offset;
      if (j >= 0 && j < got.length && got[j] === sent[i]) {
        matches++;
      }
    }
    if (matches > bestMatches) {
      bestMatches = matches;
      bestOffset = offset;
    }
  }
  let maxDiff = 0;
  let compared = 0;
  for (let i = 0; i < sent.length; i++) {
    const j = i + bestOffset;
    if (j >= 0 && j < got.length) {
      maxDiff = Math.max(maxDiff, Math.abs(got[j] - sent[i]));
      compared++;
    }
  }
  return { offset: bestOffset, identical: bestMatches, compared, maxDiff };
}

/** Frequency of a sine from its upward zero crossings, interpolated between samples */
export function sineFrequency(data, rate) {
  let first = -1;
  let last = -1;
  let periods = 0;
  for (let i = 1; i < data.length; i++) {
    if (data[i - 1] < 0 && data[i] >= 0) {
      const t = i - 1 + data[i - 1] / (data[i - 1] - data[i]);
      if (first < 0) {
        first = t;
      } else {
        periods++;
      }
      last = t;
    }
  }
  return periods > 0 ? (periods / (last - first)) * rate : NaN;
}

/** The test sine of HardwareLoopback: rising amplitude, so a copy shifted by whole periods doesn't match */
export function testSine(rate = BW16.rate, numSamples = 6000, frequency = 440) {
  const data = new Float64Array(numSamples); // doubles, to encode to the same codes as the Java version
  for (let i = 0; i < numSamples; i++) {
    data[i] = Math.sin((2 * Math.PI * frequency * i) / rate) * (0.2 + (0.7 * i) / numSamples);
  }
  return data;
}

export function hex(bytes, separator = ' ') {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(separator);
}
