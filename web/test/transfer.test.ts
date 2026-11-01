import { describe, expect, test } from 'vitest';
import { ACK, BLOCK_LENGTH, BW16, buildDump, encodeSamples } from '../src/protocol/akai';
import { MidiLink } from '../src/midi/link';
import { receiveDump, transmitDump } from '../src/midi/transfer';
import { testSine } from './helpers';

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A sampler behind a fake output, delivering what it sends the way Chrome does: a sysex only when complete.
 * Sends a dump once one ACK for the header and one per block are due, and ACKs each block of a dump it gets.
 */
function fakeSampler(dump?: Uint8Array) {
  const link = new MidiLink({ inputs: new Map(), outputs: new Map() } as unknown as MIDIAccess, () => {});
  const sent: { bytes: Uint8Array; timestamp: number }[] = [];
  const deliver = (data: Uint8Array) =>
    (link as unknown as { onMessage: (e: unknown) => void }).onMessage({ data, timeStamp: performance.now() });
  link.input = {} as MIDIInput;
  link.output = {
    send(data: Uint8Array, timestamp = 0) {
      const bytes = Uint8Array.from(data);
      if (bytes[0] === 0xf0 && bytes[bytes.length - 1] !== 0xf7) {
        throw new TypeError('System exclusive message is not ended by end of system exclusive message.');
      }
      sent.push({ bytes, timestamp });
      if (bytes[2] === 0x00 && dump) {
        const needed = 1 + Math.round((dump.length - 20) / BLOCK_LENGTH);
        const poll = setInterval(() => {
          if (sent.filter((s) => same(s.bytes, ACK) && s.timestamp <= performance.now()).length >= needed) {
            clearInterval(poll);
            deliver(dump);
          }
        }, 1);
        poll.unref?.();
      } else if (bytes[2] === 0x01) {
        const blocks = Math.round((bytes.length - 20) / BLOCK_LENGTH);
        for (let i = 0; i < blocks; i++) {
          setTimeout(() => deliver(ACK), (i + 1) * 2);
        }
      }
    },
  } as unknown as MIDIOutput;
  return { link, sent };
}

const sineDump = (n: number) => buildDump(
  { slot: 1, sampleRate: BW16.rate, numSamples: n, loopStart: 0, loopEnd: n - 100, alternating: false },
  encodeSamples(testSine(BW16.rate, n), 1));

describe('transfers', () => {
  test('receive: scheduled ACKs make the sampler send the dump', async () => {
    const dump = sineDump(1000);
    const { link, sent } = fakeSampler(dump.bytes);
    const r = await receiveDump(link, 1, { ackIntervalMs: 5, lookaheadMs: 50 });
    expect([...sent[0].bytes]).toEqual([0xf0, 0x7e, 0x00, 1, 0x00, 0xf7]);
    expect(r.blocks).toBe(dump.numBlocks);
    expect(r.timing.acksSent).toBeGreaterThanOrEqual(dump.numBlocks + 1);
    expect(r.timing.lateRefills).toBe(0);
    expect(r.timing.lastAckAt).toBeGreaterThan(0);
  });

  test('receive: cancel rejects with the ACK timing', async () => {
    const { link } = fakeSampler(sineDump(30000).bytes);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expect(receiveDump(link, 0, { ackIntervalMs: 5, lookaheadMs: 30, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError', timing: { acksSent: expect.any(Number) } });
  });

  test('receive without ports is an error', async () => {
    const link = new MidiLink({ inputs: new Map(), outputs: new Map() } as unknown as MIDIAccess, () => {});
    await expect(receiveDump(link, 0)).rejects.toThrow(/No MIDI/);
  });

  test('transmit: one send() of the whole dump, replies are counted', async () => {
    const dump = sineDump(3000);
    const { link, sent } = fakeSampler();
    const r = await transmitDump(link, dump, { quietMs: 300 });
    expect(sent).toHaveLength(1);
    expect(r.replies).toBe(dump.numBlocks);
    expect(r.kinds).toEqual([['f0 7e 7f f7', dump.numBlocks]]);
  });
});
