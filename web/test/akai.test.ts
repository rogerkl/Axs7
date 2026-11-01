import { describe, expect, test } from 'vitest';
import * as akai from '../src/protocol/akai';
import { chromeRejects, fixture, testSine } from './helpers';

const sineHeader = (overrides: Partial<akai.DumpHeader> = {}): akai.DumpHeader => ({
  slot: 0, sampleRate: akai.BW16.rate, numSamples: 6000, loopStart: 0, loopEnd: 5900, alternating: false,
  ...overrides,
});

describe('protocol', () => {
  test('7 bit packing matches the Java ByteConverter', () => {
    const b = new Uint8Array(3);
    akai.to3Bytes(65535, b, 0);
    expect([...b]).toEqual([127, 127, 3]);
    expect(akai.from3Bytes([0x58, 0x71, 0x03], 0)).toBe(63704);
    for (const [value, bytes] of [[4095, [127, 124]], [0, [0, 0]], [2047, [63, 124]]] as const) {
      const out = new Uint8Array(2);
      akai.to12Bit(value, out, 0);
      expect([...out]).toEqual(bytes);
      expect(akai.from12Bit(out, 0)).toBe(value);
    }
  });

  test('nearest bandwidth and period', () => {
    expect(akai.nearestBandwidth(48000)).toBe(akai.BW16);
    expect(akai.nearestBandwidth(22050).name).toBe('8.9khz');
    expect(akai.periodFor(39555)).toBe(25281);
    expect(akai.rateForPeriod(25281)).toBe(39555.4);
    expect(akai.rateForPeriod(1815780)).toBe(akai.BW16.rate);
  });

  test('dumps are byte for byte what the Java version sends', () => {
    const forward = akai.buildDump(sineHeader(), akai.encodeSamples(testSine(), 1));
    expect(forward.bytes).toEqual(fixture('java-sine-forward.syx'));
    const data = testSine(akai.BW16.rate, 32000);
    const alternating = akai.buildDump(
      sineHeader({ slot: 2, numSamples: 32000, loopStart: 1000, loopEnd: 31000, alternating: true }),
      akai.encodeSamples(data, 1 / akai.peak(data)));
    expect(alternating.bytes).toEqual(fixture('java-sine-alternating.syx'));
  });

  test('parses a dump received from a real X7000', () => {
    const r = akai.parseDump(fixture('x7000-received.syx'));
    expect(r).toMatchObject({ ok: true, problems: [], blocks: 545, expectedBlocks: 545, checksumErrors: 0,
      loopEnd: 32652 });
    expect(r.notes).toEqual(['Invalid sample period in header (1815780 ns), assuming 39555.4 Hz']);
    expect(r.data!.length).toBe(32652);
  });

  test('the whole dump is one message Chrome accepts, the Java style pieces are not', () => {
    const dump = akai.buildDump(sineHeader(), akai.encodeSamples(testSine(), 1), { fillerPerBlock: 10 });
    expect(chromeRejects(dump.bytes)).toBeNull();
    expect(chromeRejects(dump.bytes.subarray(0, akai.HEADER_LENGTH))).toMatch(/not ended/);
    expect(chromeRejects(dump.bytes.subarray(akai.HEADER_LENGTH, 50))).toMatch(/Running status/);
    const r = akai.parseDump(dump.bytes);
    expect(r.problems).toEqual(['Received 103 of 104 blocks']); // rounded down like the Java version
    expect(r.codes!.subarray(0, 6000)).toEqual(akai.encodeSamples(testSine(), 1));
  });

  test('reports a dump the sampler gave up on', () => {
    const full = akai.buildDump(sineHeader(), akai.encodeSamples(testSine(), 1)).bytes;
    const r = akai.parseDump(Uint8Array.of(...full.subarray(0, 19), 0xf7));
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('Received 0 of 104 blocks');
    expect(akai.parseDump(akai.ACK).ok).toBe(false);
  });
});
