import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as akai from '../js/akai.js';
import { encodeWav, readWavInfo } from '../js/wav.js';

const fixture = (name) => new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));

/**
 * The rules Chrome's MIDIOutput.send() checks a message with (Blink's MessageValidator), for the parts that matter
 * here. Returns why it would throw, or null if it would send.
 */
function chromeRejects(bytes) {
  const reserved = (b) => b === 0xf4 || b === 0xf5 || b === 0xf9 || b === 0xfd;
  const realTime = (b) => b >= 0xf8 && !reserved(b);
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (realTime(b)) {
      i++;
    } else if (!(b & 0x80)) {
      return 'Running status is not allowed';
    } else if (b === 0xf7) {
      return 'Unexpected end of system exclusive message';
    } else if (reserved(b)) {
      return 'Reserved status is not allowed';
    } else if (b === 0xf0) {
      for (i++; ; i++) {
        if (i >= bytes.length) {
          return 'System exclusive message is not ended by end of system exclusive message.';
        }
        const c = bytes[i];
        if (reserved(c)) {
          return 'Reserved status in system exclusive message';
        }
        if (c === 0xf7) {
          i++;
          break;
        }
        if (c & 0x80 && !realTime(c)) {
          return 'System exclusive message contains a status byte';
        }
      }
    } else {
      const length = b < 0xf0 ? [3, 3, 3, 3, 2, 2, 3][(b >> 4) - 8] : [0, 2, 3, 2, 0, 0, 1][b - 0xf0];
      i += length; // good enough for the tests, which only send sysex
    }
  }
  return null;
}

const sineHeader = (overrides = {}) => ({
  slot: 0, sampleRate: akai.BW16.rate, numSamples: 6000, loopStart: 0, loopEnd: 5900, alternating: false,
  ...overrides,
});

test('7 bit packing matches the Java ByteConverter', () => {
  const b = new Uint8Array(3);
  akai.to3Bytes(65535, b, 0);
  assert.deepEqual([...b], [127, 127, 3]);
  assert.equal(akai.from3Bytes(b, 0), 65535);
  assert.equal(akai.from3Bytes([0x58, 0x71, 0x03], 0), 63704);
  assert.equal(akai.from3Bytes([0x70, 0x7f, 0x01], 0), 32752);
  for (const [value, bytes] of [[4095, [127, 124]], [0, [0, 0]], [2047, [63, 124]]]) {
    const out = new Uint8Array(2);
    akai.to12Bit(value, out, 0);
    assert.deepEqual([...out], bytes);
    assert.equal(akai.from12Bit(out, 0), value);
  }
});

test('nearest bandwidth and period', () => {
  assert.equal(akai.nearestBandwidth(48000), akai.BW16);
  assert.equal(akai.nearestBandwidth(44100), akai.BW16);
  assert.equal(akai.nearestBandwidth(22050).name, '8.9khz');
  assert.equal(akai.periodFor(39555), 25281);
  assert.equal(akai.periodFor(44100), Math.trunc(1e9 / 44100));
  assert.equal(akai.rateForPeriod(25281), 39555.4);
  assert.equal(akai.rateForPeriod(0x6e * 16384 + 0x69 * 128 + 0x64), akai.BW16.rate); // garbage from the X7000
});

test('dump is byte for byte what the Java version sends (forward loop, no normalize)', () => {
  const codes = akai.encodeSamples(akai.testSine(akai.BW16.rate, 6000), 1);
  const dump = akai.buildDump(sineHeader(), codes);
  assert.equal(dump.numBlocks, 103);
  assert.deepEqual(dump.bytes, fixture('java-sine-forward.syx'));
});

test('dump is byte for byte what the Java version sends (alternating loop, normalized, slot 3)', () => {
  const data = akai.testSine(akai.BW16.rate, 32000);
  const codes = akai.encodeSamples(data, 1 / akai.peak(data));
  const dump = akai.buildDump(sineHeader({ slot: 2, numSamples: 32000, loopStart: 1000, loopEnd: 31000,
    alternating: true }), codes);
  assert.equal(dump.numBlocks, 536);
  assert.deepEqual(dump.bytes, fixture('java-sine-alternating.syx'));
});

test('parses a dump received from a real X7000', () => {
  const r = akai.parseDump(fixture('x7000-received.syx'));
  assert.equal(r.length, 66510);
  assert.equal(r.blocks, 545);
  assert.equal(r.expectedBlocks, 545);
  assert.equal(r.checksumErrors, 0);
  assert.equal(r.blockNumberErrors, 0);
  assert.equal(r.header.totalWords, 32652);
  assert.equal(r.header.bits, 12);
  assert.equal(r.header.periodValid, false);
  assert.equal(r.header.sampleRate, akai.BW16.rate);
  assert.equal(r.loopEnd, 32652);
  assert.equal(r.data.length, 32652);
  assert.ok(r.ok);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.notes, ['Invalid sample period in header (1815780 ns), assuming 39555.4 Hz']);
  assert.ok(akai.peak(r.data) > 0.1);
});

test('build and parse round trip', () => {
  const codes = akai.encodeSamples(akai.testSine(akai.BW16.rate, 6000), 1);
  const r = akai.parseDump(akai.buildDump(sineHeader(), codes).bytes);
  // the header announces 200 more words than the sample has, and like the Java version the number of blocks is
  // rounded down, so one block less than announced is sent
  assert.equal(r.header.totalWords, 6200);
  assert.equal(r.blocks, 103);
  assert.deepEqual(r.problems, ['Received 103 of 104 blocks']);
  assert.deepEqual(r.codes.subarray(0, 6000), codes);
  assert.ok(r.codes.subarray(6000).every((c) => c === 2048));
});

test('the whole dump is one message Chrome accepts, the Java style pieces are not', () => {
  const codes = akai.encodeSamples(akai.testSine(akai.BW16.rate, 6000), 1);
  const dump = akai.buildDump(sineHeader(), codes);
  assert.equal(chromeRejects(dump.bytes), null);
  assert.equal(chromeRejects(akai.ACK), null);
  assert.equal(chromeRejects(akai.requestMessage(5)), null);
  // what the Java version sends: the header without F7, F7 + block for each block, then F7
  const header = dump.bytes.subarray(0, akai.HEADER_LENGTH);
  const block = dump.bytes.subarray(akai.HEADER_LENGTH, akai.HEADER_LENGTH + akai.BLOCK_LENGTH);
  assert.match(chromeRejects(header), /not ended/);
  assert.match(chromeRejects(Uint8Array.of(0xf7, ...block)), /Unexpected end/);
  assert.match(chromeRejects(block), /Running status/);
  assert.match(chromeRejects(Uint8Array.of(0xf7)), /Unexpected end/);
});

test('filler bytes between blocks', () => {
  const codes = akai.encodeSamples(akai.testSine(akai.BW16.rate, 6000), 1);
  for (const fillerByte of [0xf8, 0xfe]) {
    const dump = akai.buildDump(sineHeader(), codes, { fillerAfterHeader: 100, fillerPerBlock: 30, fillerByte });
    assert.equal(dump.bytes.length, 19 + 100 + 103 * 122 + 102 * 30 + 1);
    assert.equal(chromeRejects(dump.bytes), null);
    const r = akai.parseDump(dump.bytes);
    assert.deepEqual(r.problems, ['Received 103 of 104 blocks']);
    assert.deepEqual(r.codes.subarray(0, 6000), codes);
  }
  assert.throws(() => akai.buildDump(sineHeader(), codes, { fillerByte: 0xf9 }));
});

test('reports a dump the sampler gave up on', () => {
  const codes = akai.encodeSamples(akai.testSine(akai.BW16.rate, 6000), 1);
  const full = akai.buildDump(sineHeader(), codes).bytes;
  const aborted = Uint8Array.of(...full.subarray(0, 19), 0xf7);
  const r = akai.parseDump(aborted);
  assert.equal(r.ok, false);
  assert.equal(r.blocks, 0);
  assert.ok(r.problems.includes('Received 0 of 104 blocks'), r.problems.join());

  const partial = Uint8Array.of(...full.subarray(0, 19 + 10 * 122 + 50), 0xf7);
  const p = akai.parseDump(partial);
  assert.equal(p.blocks, 10);
  assert.equal(p.data.length, 600);
  assert.ok(p.problems.includes('50 bytes after the last whole block'), p.problems.join());

  const corrupt = full.slice();
  corrupt[19 + 5 * 122 + 7] ^= 0x01;
  assert.equal(akai.parseDump(corrupt).checksumErrors, 1);

  assert.equal(akai.parseDump(akai.ACK).ok, false);
});

test('header values are clamped like the Java SampleHeader', () => {
  const h = akai.decodeHeader(akai.encodeHeader(sineHeader({ numSamples: 40000, loopStart: 39000, loopEnd: 39500 })));
  assert.equal(h.totalWords, akai.MAX_SAMPLES);
  assert.equal(h.loopEnd, akai.MAX_SAMPLES);
  assert.equal(h.loopStart, 0); // past the clamped loop end
  assert.equal(akai.blocksToSend(40000), 545); // 32752 words, rounded down
  const full = akai.parseDump(akai.buildDump(sineHeader({ numSamples: 32752, loopEnd: 32752 }),
    new Uint16Array(32752).fill(2048)).bytes);
  assert.equal(full.blocks, 545);
});

test('compare and pitch helpers', () => {
  const sine = akai.testSine(akai.BW16.rate, 6000);
  assert.ok(Math.abs(akai.sineFrequency(sine, akai.BW16.rate) - 440) < 0.05);
  const codes = akai.encodeSamples(sine, 1);
  const shifted = new Uint16Array(6100);
  shifted.set(codes, 37);
  assert.deepEqual(akai.compareCodes(codes, shifted), { offset: 37, identical: 6000, compared: 6000, maxDiff: 0 });
});

test('wav with a loop in the smpl chunk', () => {
  const data = akai.testSine(akai.BW16.rate, 1000);
  const wav = encodeWav(data, akai.BW16.rate, [{ start: 100, end: 900, alternating: true }]);
  const info = readWavInfo(wav.buffer);
  assert.equal(info.sampleRate, 39555);
  assert.deepEqual(info.loops, [{ start: 100, end: 900, alternating: true }]);
  const view = new DataView(wav.buffer);
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(view.getInt16(44 + 2 * 10, true), Math.round(data[10] * 32767));

  assert.deepEqual(readWavInfo(encodeWav(data, 22199.53, []).buffer), { sampleRate: 22200, loops: [] });
  // without a smpl chunk
  const plain = wav.slice(0, 44 + 2000);
  new DataView(plain.buffer).setUint32(4, plain.length - 8, true);
  assert.deepEqual(readWavInfo(plain.buffer), { sampleRate: 39555, loops: null });
  assert.deepEqual(readWavInfo(new ArrayBuffer(8)), { sampleRate: null, loops: null });
});
