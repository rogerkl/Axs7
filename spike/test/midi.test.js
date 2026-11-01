import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as akai from '../js/akai.js';
import { MidiLink, receiveDump, transmitDump } from '../js/midi.js';

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A sampler on the other end of a fake output, delivering what it sends the way Chrome does: a sysex only when
 * it is complete. Sends a dump after one ACK for the header and one per block, at the time the ACKs are due.
 */
function fakeSampler({ dump, ackFormat = akai.ACK, ackEveryMs = 2 } = {}) {
  const logs = [];
  const link = new MidiLink({ inputs: new Map(), outputs: new Map() }, (text, level) => logs.push([level, text]));
  const sent = [];
  let acksNeeded = Infinity;
  const deliver = (data) => link.onMessage({ data: Uint8Array.from(data), timeStamp: performance.now() });
  link.output = {
    send(data, timestamp = 0) {
      const bytes = Uint8Array.from(data);
      if (bytes[0] === 0xf0 && bytes[bytes.length - 1] !== 0xf7) {
        throw new TypeError('System exclusive message is not ended by end of system exclusive message.');
      }
      sent.push({ bytes, timestamp, at: performance.now() });
      if (bytes[1] === 0x7e && bytes[2] === 0x00) {
        // a request: the dump is complete after the header ACK and one ACK per block
        acksNeeded = 1 + Math.round((dump.length - 20) / akai.BLOCK_LENGTH);
        const poll = setInterval(() => {
          const due = sent.filter((s) => sameBytes(s.bytes, akai.ACK) && s.timestamp <= performance.now()).length;
          if (due >= acksNeeded) {
            clearInterval(poll);
            deliver(dump);
          }
        }, 1);
        poll.unref(); // a cancelled receive never gets its dump
      } else if (bytes[1] === 0x7e && bytes[2] === 0x01) {
        // a dump: ACK each block as it would arrive
        const blocks = Math.round((bytes.length - 20) / akai.BLOCK_LENGTH);
        for (let i = 0; i < blocks; i++) {
          setTimeout(() => deliver(ackFormat), (i + 1) * ackEveryMs);
        }
      }
    },
  };
  return { link, sent, logs };
}

const sineDump = (numSamples) => akai.buildDump(
  { slot: 1, sampleRate: akai.BW16.rate, numSamples, loopStart: 0, loopEnd: numSamples - 100, alternating: false },
  akai.encodeSamples(akai.testSine(akai.BW16.rate, numSamples), 1),
);

test('receive: scheduled ACKs make the sampler send the dump, which is parsed', async () => {
  const dump = sineDump(1000);
  const { link, sent } = fakeSampler({ dump: dump.bytes });
  const progress = [];
  const r = await receiveDump(link, 1, { ackIntervalMs: 5, lookaheadMs: 50, onProgress: (p) => progress.push(p) });
  assert.deepEqual([...sent[0].bytes], [0xf0, 0x7e, 0x00, 1, 0x00, 0xf7]);
  assert.equal(r.blocks, dump.numBlocks);
  assert.deepEqual(r.codes.subarray(0, 1000), akai.encodeSamples(akai.testSine(akai.BW16.rate, 1000), 1));
  assert.ok(sameBytes(r.raw, dump.bytes));
  assert.ok(r.timing.acksSent >= dump.numBlocks + 1, `${r.timing.acksSent} ACKs`);
  // at most the lookahead's worth of ACKs go out after the end
  assert.ok(r.timing.acksAfterEnd <= 50 / 5 + 1, `${r.timing.acksAfterEnd} after the end`);
  assert.equal(r.timing.lateRefills, 0);
  // the ACKs are spaced by the interval through their timestamps, not by when send() was called
  const acks = sent.filter((s) => sameBytes(s.bytes, akai.ACK)).map((s) => s.timestamp);
  acks.slice(1).forEach((t, i) => assert.ok(Math.abs(t - acks[i] - 5) < 1e-6));
  assert.ok(sent.filter((s) => sameBytes(s.bytes, akai.ACK)).some((s) => s.timestamp > s.at + 20),
    'some ACKs are scheduled ahead of time');
  assert.equal(link.listeners.size, 0, 'listener removed');
});

test('receive: a dump the sampler gave up on is reported', async () => {
  const dump = sineDump(1000);
  const aborted = Uint8Array.of(...dump.bytes.subarray(0, 19), 0xf7);
  const { link } = fakeSampler({ dump: aborted });
  const r = await receiveDump(link, 0, { ackIntervalMs: 5, lookaheadMs: 50 });
  assert.equal(r.ok, false);
  assert.equal(r.blocks, 0);
});

test('receive: cancel stops the ACKs and rejects', async () => {
  const { link, sent } = fakeSampler({ dump: sineDump(30000).bytes });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  await assert.rejects(receiveDump(link, 0, { ackIntervalMs: 5, lookaheadMs: 20, signal: controller.signal }),
    { name: 'AbortError' });
  const count = sent.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(sent.length, count, 'no ACKs scheduled after the cancel');
});

test('transmit: one send() of the whole dump, replies are counted', async () => {
  const dump = sineDump(3000);
  const { link, sent } = fakeSampler({ ackEveryMs: 2 });
  const r = await transmitDump(link, dump, { quietMs: 300 });
  assert.equal(sent.length, 1);
  assert.ok(sameBytes(sent[0].bytes, dump.bytes));
  assert.equal(r.replies, dump.numBlocks);
  assert.deepEqual(r.kinds, [['f0 7e 7f f7', dump.numBlocks]]);
  assert.ok(r.gaps.avg > 1 && r.gaps.avg < 10, `${r.gaps.avg}`);
  assert.equal(r.cancelled, false);
});

test('transmit: a send() the browser rejects is reported', async () => {
  const dump = sineDump(1000);
  const { link } = fakeSampler();
  const broken = { ...dump, bytes: dump.bytes.subarray(0, dump.bytes.length - 1) };
  await assert.rejects(transmitDump(link, broken), /not ended/);
  assert.equal(link.listeners.size, 0);
});

test('the input logs messages, collapsing real-time bytes into a count', () => {
  const { link, logs } = fakeSampler();
  link.onMessage({ data: Uint8Array.of(0xfe), timeStamp: 1 });
  link.onMessage({ data: Uint8Array.of(0xf8), timeStamp: 2 });
  link.onMessage({ data: Uint8Array.of(0x90, 60, 100), timeStamp: 3 });
  const dump = sineDump(1000).bytes;
  link.onMessage({ data: dump, timeStamp: 4 });
  assert.equal(link.realTimeCount, 2);
  assert.deepEqual(logs.map((l) => l[1]),
    ['in: 90 3c 64', `in: sysex, ${dump.length} bytes: ${akai.hex(dump.subarray(0, 12))} …`]);
});
