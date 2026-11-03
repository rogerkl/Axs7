import { describe, expect, test } from 'vitest';
import { MidiLink } from '../src/midi/link';
import { requestSampleParams, setSampleParams } from '../src/midi/transfer';
import { sampleFromDumpWithParams } from '../src/model/s700';
import {
  BANDWIDTHS, BLOCK_LENGTH, HEADER_LENGTH, SAMPLES_PER_BLOCK, encodeBlock, encodeHeader, parseDump, to3Bytes,
} from '../src/protocol/akai';
import {
  SPRM_LENGTH, bytesWithStart, parseSampleParams, sampleParamsBytesMessage, sampleParamsMessage, sampleParamsRequest,
} from '../src/protocol/sprm';
import { chromeRejects } from './helpers';

/** A sample parameters message as the document numbers its bytes, built here without the code under test */
function documentMessage(channel: number, slot: number): Uint8Array {
  const m = new Uint8Array(SPRM_LENGTH);
  m.set([0xf0, 0x47, channel, 10, 65, slot, 0]);
  const db = (at: number, v: number) => m.set([v & 0x7f, (v >> 7) & 1], at);
  const dw = (at: number, v: number) => {
    db(at, v & 0xff);
    db(at + 2, v >> 8);
  };
  for (let p = 0; p < 32; p++) {
    // KEYL, KEYH, TRANSP, ATPTCH for each program from byte 7: not in the program unless set below
    [24, 0, 0, 0x80 | 60].forEach((v, k) => db(7 + p * 8 + k * 2, v));
  }
  [36, 96, 0x7f & -12, 0x80 | 60].forEach((v, k) => db(7 + k * 2, v));
  [48, 60, 0x80 | 5, 62].forEach((v, k) => db(7 + 2 * 8 + k * 2, v));
  db(265, 4); // RPMODE alternating
  dw(267, 1000); // SSTRT
  dw(271, 30000 - 1000 - 1); // undefined: END - START - 1, as the X7000 keeps it
  dw(275, 30000); // SEND
  dw(279, 5000); // SLOOP
  dw(283, 30000 - 1 - 5000); // undefined: the loop length
  [40, 50, 60, 99, 70, 88, 0xfd, 60, 69, 255, 10, 20, 30].forEach((v, k) => db(287 + k * 2, v));
  m[317] = m.subarray(7, 317).reduce((x, b) => x ^ b, 0);
  m[318] = 0xf7;
  return m;
}

/** What an X7000 sent for its slot 1 (2026-11-03): START after the loop point, alternating, in programs 1 and 3 */
const X7000_BYTES = Uint8Array.from(('18 60 74 bc 18 00 00 bc 18 60 74 bc 18 00 00 bc'
  + ' 18 00 00 bc'.repeat(28)
  + ' 00 04 28 7f c7 00 f0 7f 33 25 bc 5a 00 00 00 5a 55 4b 00 3c 3c 00 00 00 00 00 00').split(' '),
(h) => parseInt(h, 16));

/** The message with the bytes, as the sampler sends it */
function x7000Message(): Uint8Array {
  const m = new Uint8Array(SPRM_LENGTH);
  m.set([0xf0, 0x47, 0, 10, 0x41, 0, 0]);
  X7000_BYTES.forEach((b, i) => m.set([b & 0x7f, b >> 7], 7 + 2 * i));
  m[317] = m.subarray(7, 317).reduce((x, b) => x ^ b, 0);
  m[318] = 0xf7;
  return m;
}

const expected = {
  scanMode: 4, start: 1000, end: 30000, loop: 5000, lfoSpeed: 40, lfoDepth: 50, lfoDelay: 60, filter: 99,
  release: 70, loudness: 88, fineTune: -3, recordPitch: 60, bandwidth: 69, reversed: true, velFilter: 10,
  velLoudness: 20, velRelease: 30,
};

describe('sample parameters (Akai exclusive)', () => {
  test('the request', () => {
    expect([...sampleParamsRequest(1, 2)]).toEqual([0xf0, 0x47, 1, 4, 0x41, 2, 0, 0xf7]);
    expect([...sampleParamsRequest(15, 0, 0x65)]).toEqual([0xf0, 0x47, 15, 4, 0x65, 0, 0, 0xf7]);
  });

  test('the parameters, read from the bytes the document gives them', () => {
    const r = parseSampleParams(documentMessage(3, 5));
    expect(r).toMatchObject({ channel: 3, id: 0x41, slot: 5, checksumOk: true });
    expect(r.params).toMatchObject(expected);
    expect(r.params.programs[0]).toEqual({ low: 36, high: 96, transpose: -12, constantPitch: false,
      audioTrigger: null });
    expect(r.params.programs[1]).toMatchObject({ low: 24, high: 0 });
    expect(r.params.programs[2]).toEqual({ low: 48, high: 60, transpose: 5, constantPitch: true, audioTrigger: 62 });
    expect(r.bytes).toHaveLength(155);
    const damaged = documentMessage(3, 5);
    damaged[300] ^= 1;
    expect(parseSampleParams(damaged).checksumOk).toBe(false);
    expect(() => parseSampleParams(documentMessage(3, 5).subarray(0, 100))).toThrow(/Not a sample parameters/);
  });

  test('what an X7000 sent, and the same message made from its parameters', () => {
    const r = parseSampleParams(x7000Message());
    expect(r.bytes).toEqual(X7000_BYTES);
    expect(r.params).toMatchObject({ scanMode: 4, start: 32552, end: 32752, loop: 9523, filter: 90, release: 85,
      loudness: 75, recordPitch: 60, bandwidth: 60, reversed: false });
    const inProgram = { low: 24, high: 96, transpose: -12, constantPitch: false, audioTrigger: null };
    expect(r.params.programs.flatMap((k, i) => (k.low <= k.high ? [i] : []))).toEqual([0, 2]);
    expect(r.params.programs[0]).toEqual(inProgram);
    expect(r.params.programs[2]).toEqual(inProgram);
    // the words the sampler keeps besides: END - START - 1, END - LOOP - 1
    expect([...sampleParamsMessage(0, 0, r.params)]).toEqual([...x7000Message()]);
    expect([...sampleParamsBytesMessage(0, 0, r.bytes)]).toEqual([...x7000Message()]);
  });

  test('START changed, and the word kept with it: the rest as it was', () => {
    const zero = bytesWithStart(X7000_BYTES, 0);
    expect([...zero.subarray(130, 134)]).toEqual([0, 0, 0xef, 0x7f]); // 0, and END - 0 - 1 = 32751
    expect(zero.filter((b, i) => b !== X7000_BYTES[i])).toHaveLength(4);
    expect(parseSampleParams(sampleParamsBytesMessage(0, 0, zero)).params).toMatchObject({ start: 0, end: 32752,
      loop: 9523 });
    expect(bytesWithStart(zero, 32552)).toEqual(X7000_BYTES);
  });

  test('the message that sets them is the document\'s, and Chrome sends it', () => {
    const message = documentMessage(3, 5);
    const ours = sampleParamsMessage(3, 5, parseSampleParams(message).params);
    expect([...ours]).toEqual([...message]);
    expect(chromeRejects(ours)).toBeNull();
  });
});

/** A sampler that answers a request for parameters on one channel and identifier only, as Chrome delivers sysex */
function fakeSampler(channel: number | null, id = 0x41) {
  const link = new MidiLink({ inputs: new Map(), outputs: new Map() } as unknown as MIDIAccess, () => {});
  const sent: Uint8Array[] = [];
  const deliver = (data: Uint8Array) =>
    (link as unknown as { onMessage: (e: unknown) => void }).onMessage({ data, timeStamp: performance.now() });
  link.input = {} as MIDIInput;
  link.output = {
    send(data: Uint8Array) {
      const bytes = Uint8Array.from(data);
      sent.push(bytes);
      if (bytes[3] === 4 && bytes[2] === channel && bytes[4] === id) {
        const reply = documentMessage(7, bytes[5]);
        reply[4] = id;
        setTimeout(() => deliver(reply), 5);
      } else {
        setTimeout(() => deliver(Uint8Array.of(0xf0, 0x47, bytes[2], 0x7f, 0x41, 0xf7)), 1); // something else
      }
    },
  } as unknown as MIDIOutput;
  return { link, sent };
}

/** A sampler with a slot's parameters on channel 0, 41h, that takes parameters sent to it, or not */
function samplerWithParams(bytes: Uint8Array, takes = true) {
  const link = new MidiLink({ inputs: new Map(), outputs: new Map() } as unknown as MIDIAccess, () => {});
  const sent: Uint8Array[] = [];
  let kept = bytes.slice();
  const deliver = (data: Uint8Array) =>
    (link as unknown as { onMessage: (e: unknown) => void }).onMessage({ data, timeStamp: performance.now() });
  link.input = {} as MIDIInput;
  link.output = {
    send(data: Uint8Array) {
      const m = Uint8Array.from(data);
      sent.push(m);
      if (m[1] === 0x47 && m[2] === 0 && m[4] === 0x41 && m[3] === 10 && takes) {
        kept = parseSampleParams(m).bytes;
      } else if (m[1] === 0x47 && m[2] === 0 && m[4] === 0x41 && m[3] === 4) {
        setTimeout(() => deliver(sampleParamsBytesMessage(0, m[5], kept)), 5);
      }
    },
  } as unknown as MIDIOutput;
  return { link, sent, has: () => parseSampleParams(sampleParamsBytesMessage(0, 0, kept)).params };
}

describe('asking the sampler for parameters', () => {
  test('on each channel in turn from the one given, until one is answered', async () => {
    const { link, sent } = fakeSampler(2);
    const r = await requestSampleParams(link, 4, { channel: 14, waitMs: 30 });
    expect(sent.map((s) => s[2])).toEqual([14, 15, 0, 1, 2]);
    expect(r.requests).toBe(5);
    expect(r.reply).toMatchObject({ askedChannel: 2, askedId: 0x41, channel: 7, slot: 4, checksumOk: true });
    expect(r.reply!.params).toMatchObject(expected);
    expect(r.other.length).toBeGreaterThan(0);
  });

  test('then with the other reading of the identifier', async () => {
    const { link, sent } = fakeSampler(0, 0x65);
    const r = await requestSampleParams(link, 0, { waitMs: 15 });
    expect(r.requests).toBe(17);
    expect(sent.slice(0, 16).every((s) => s[4] === 0x41)).toBe(true);
    expect(r.reply).toMatchObject({ askedChannel: 0, askedId: 0x65 });
  });

  test('only on the channel given, as RECEIVE asks', async () => {
    const { link, sent } = fakeSampler(5);
    expect(await requestSampleParams(link, 0, { channel: 5, waitMs: 15, search: false }))
      .toMatchObject({ reply: { askedChannel: 5 }, requests: 1 });
    expect(await requestSampleParams(link, 0, { channel: 4, waitMs: 2, search: false }))
      .toMatchObject({ reply: null, requests: 1 });
    expect(sent.map((s) => s[2])).toEqual([5, 4]);
  });

  test('setting them, and seeing that the sampler took them', async () => {
    for (const takes of [true, false]) {
      const { link, sent, has } = samplerWithParams(X7000_BYTES, takes);
      const now = await setSampleParams(link, 0, bytesWithStart(X7000_BYTES, 0), { channel: 0, id: 0x41 });
      expect(sent.map((m) => m[3])).toEqual([10, 4]); // the parameters, then the request
      expect(now!.params.start).toBe(takes ? 0 : 32552);
      expect(has().start).toBe(takes ? 0 : 32552);
    }
  });

  test('no reply at all, or cancelled', async () => {
    const { link } = fakeSampler(null);
    const r = await requestSampleParams(link, 0, { waitMs: 2 });
    expect(r).toMatchObject({ reply: null, requests: 32 });
    const abort = new AbortController();
    const asking = requestSampleParams(link, 0, { waitMs: 1000, signal: abort.signal });
    setTimeout(() => abort.abort(), 10);
    await expect(asking).rejects.toThrow(/Cancelled/);
  });
});

/**
 * A dump of a ramp as the X7000 sends one: the words in its header are the samples it sends, not 200 more as in a
 * dump sent to it, and its period isn't a rate
 */
function x7000Dump(numSamples: number) {
  const codes = Uint16Array.from({ length: numSamples }, (_, i) => (i * 7) % 4096);
  const blocks = Math.ceil(numSamples / SAMPLES_PER_BLOCK);
  const bytes = new Uint8Array(HEADER_LENGTH + blocks * BLOCK_LENGTH + 1);
  bytes.set(encodeHeader({ slot: 0, sampleRate: 39555.4, numSamples, loopStart: 0, loopEnd: numSamples,
    alternating: false }));
  for (let b = 0; b < blocks; b++) {
    bytes.set(encodeBlock(b, codes, numSamples), HEADER_LENGTH + b * BLOCK_LENGTH);
  }
  bytes[bytes.length - 1] = 0xf7;
  to3Bytes(1815780, bytes, 6); // the period in x7000-received.syx
  to3Bytes(numSamples, bytes, 9);
  const r = parseDump(bytes);
  expect(r).toMatchObject({ ok: true, header: { periodValid: false, totalWords: numSamples } });
  return r;
}

describe('a sample received with its parameters', () => {
  test('START after the loop point: the dump is START to END, the loop is lost', () => {
    const params = parseSampleParams(x7000Message()).params;
    const { sample, programs, notes } = sampleFromDumpWithParams(x7000Dump(200), params, 'SLOT 1');
    expect(sample).toMatchObject({ start: 0, end: 200, loopStart: 0, loopEnd: 200, loopMode: 'alternating',
      rate: BANDWIDTHS.find((b) => b.rate === 15697.6)!.rate, fromSampler: true, reverse: false });
    expect(sample.sound).toMatchObject({ filter: 90, release: 85, level: 75, lfoDepth: 0, velRelease: 0 });
    expect(sample.data[1]).toBe((7 - 2048) / 2048);
    const range = { low: 24, high: 96, root: 60, semitones: -12, cents: 0, fixedPitch: false };
    expect(programs.slice(0, 4)).toEqual([range, null, range, null]);
    expect(notes).toEqual(['LOOP 9523 is before START 32552, and the dump has START to END only: the loop is lost, '
      + 'it starts at START here.']);
  });

  test('START set to 0 for the dump: all of the sample, with its points as on the sampler', () => {
    const params = parseSampleParams(x7000Message()).params;
    const { sample, notes } = sampleFromDumpWithParams(x7000Dump(32752), params, 'SLOT 1');
    expect(sample).toMatchObject({ start: 32552, end: 32752, loopStart: 9523, loopEnd: 32752,
      loopMode: 'alternating' });
    expect(sample.data).toHaveLength(32752);
    expect(notes).toEqual([]);
  });

  test('START before the loop point: the points from START, the rate from the parameters', () => {
    const params = { ...parseSampleParams(documentMessage(0, 0)).params, reversed: false };
    const { sample, notes } = sampleFromDumpWithParams(x7000Dump(29000), params, 'SLOT 1');
    expect(sample).toMatchObject({ start: 0, end: 29000, loopStart: 4000, loopEnd: 29000, loopMode: 'alternating',
      rate: BANDWIDTHS.find((b) => b.name === '11khz')!.rate });
    expect(sample.data).toHaveLength(29000);
    expect(notes).toEqual([]);
    // not as the parameters have it
    const dump = x7000Dump(100);
    dump.header = { ...dump.header!, periodValid: true, sampleRate: 39555.4 };
    expect(sampleFromDumpWithParams(dump, { ...params, start: 0, end: 300 }, 'X').notes).toEqual([
      'The dump has 100 samples, START to END on the sampler is 300',
      'The dump\'s header has 39555.4 Hz, the parameters 26399.85 Hz: took the parameters\'',
    ]);
  });
});
