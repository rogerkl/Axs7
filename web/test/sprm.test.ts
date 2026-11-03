import { describe, expect, test } from 'vitest';
import { MidiLink } from '../src/midi/link';
import { requestSampleParams } from '../src/midi/transfer';
import { SPRM_LENGTH, parseSampleParams, sampleParamsMessage, sampleParamsRequest } from '../src/protocol/sprm';
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
  dw(271, 29999); // undefined: END - 1, as the S700 keeps it
  dw(275, 30000); // SEND
  dw(279, 5000); // SLOOP
  dw(283, 30000 - 1 - 5000); // undefined: the loop length
  [40, 50, 60, 99, 70, 88, 0xfd, 60, 69, 255, 10, 20, 30].forEach((v, k) => db(287 + k * 2, v));
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
