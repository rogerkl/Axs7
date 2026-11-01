// Sample dump transfers over Web MIDI, ported from the test page (spike/js/midi.js) that was verified on an X7000.
//
// - Incoming sysex is held back by the browser until its F7 arrives, so a dump arrives as one message when the
//   sampler is done. The sampler waits for an ACK after the header and each block, so the ACKs are sent blind at a
//   fixed pace, with timestamps a little ahead of time. The browser schedules those in its own process, so tab
//   timer jitter and throttling don't disturb the pace.
// - send() rejects a sysex without F7, so a dump goes out in one send(), without waiting for ACKs between blocks.

import { ACK, MAX_BLOCKS, hex, parseDump, requestMessage, wireSeconds } from '../protocol/akai';
import type { Dump, ParsedDump } from '../protocol/akai';
import type { Log, MidiLink } from './link';

export interface AckTiming {
  seconds: number;
  acksSent: number;
  acksAfterEnd: number;
  lateRefills: number;
  /** when the last scheduled ACK goes out, they can't be called back */
  lastAckAt: number;
}

export interface Received extends ParsedDump {
  raw: Uint8Array;
  timing: AckTiming;
}

export class TransferError extends Error {
  constructor(message: string, readonly timing?: AckTiming) {
    super(message);
  }
}

class AckScheduler {
  times: number[] = [];
  private lateRefills = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private next = 0;

  constructor(private output: MIDIOutput, private intervalMs: number, private lookaheadMs: number,
    private log: Log) {}

  start(firstTime: number): void {
    this.next = firstTime;
    this.fill();
    // refill well within the lookahead, or the ACKs run out before the next refill
    this.timer = setInterval(() => this.fill(), Math.min(100, this.lookaheadMs / 3));
  }

  private fill(): void {
    const now = performance.now();
    if (this.next < now) {
      // the timer ran late (hidden tab?), skip the missed ACKs instead of sending them as a burst
      this.lateRefills++;
      this.log(`ACK timer was ${(now - this.next).toFixed(0)} ms late, keep the tab visible`, 'warn');
      this.next = now;
    }
    const horizon = now + this.lookaheadMs;
    while (this.next <= horizon) {
      this.output.send(ACK, this.next);
      this.times.push(this.next);
      this.next += this.intervalMs;
    }
  }

  sent(before: number): number {
    return this.times.filter((t) => t <= before).length;
  }

  stop(time: number): Omit<AckTiming, 'seconds'> {
    clearInterval(this.timer);
    try {
      // in the spec, but not in every browser or in TypeScript's types
      (this.output as MIDIOutput & { clear?: () => void }).clear?.();
    } catch {
      // ignore
    }
    const sent = this.sent(time);
    return { acksSent: sent, acksAfterEnd: this.times.length - sent, lateRefills: this.lateRefills,
      lastAckAt: this.times.length ? this.times[this.times.length - 1] : 0 };
  }
}

export interface ReceiveOptions {
  /** a little slower than a block takes to send (122 bytes = 39 ms) */
  ackIntervalMs?: number;
  lookaheadMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: { elapsedMs: number; acks: number; maxMs: number }) => void;
}

/** Requests a sample from the sampler and receives it */
export function receiveDump(link: MidiLink, slot: number, options: ReceiveOptions = {}): Promise<Received> {
  const { ackIntervalMs = 50, lookaheadMs = 1500, signal, onProgress } = options;
  const output = link.output;
  if (!output || !link.input) {
    return Promise.reject(new TransferError('No MIDI input and output selected'));
  }
  // the longest dump takes MAX_BLOCKS ACKs, plus some time before the sampler starts
  const maxMs = (MAX_BLOCKS + 1) * ackIntervalMs;
  const timeoutMs = maxMs + 10_000;
  return new Promise((resolve, reject) => {
    const acks = new AckScheduler(output, ackIntervalMs, lookaheadMs, link.log);
    let done = false;
    const t0 = performance.now();

    const finish = (error: Error | null, data?: Uint8Array, time?: number) => {
      if (done) {
        return;
      }
      done = true;
      clearInterval(progressTimer);
      unlisten();
      const at = time ?? performance.now();
      const timing = { seconds: (at - t0) / 1000, ...acks.stop(at) };
      if (error) {
        reject(error instanceof DOMException ? Object.assign(error, { timing }) : new TransferError(error.message, timing));
      } else {
        resolve({ ...parseDump(data!), raw: data!.slice(), timing });
      }
    };

    const unlisten = link.listen((data, time) => {
      if (data[0] === 0xf0 && data[1] === 0x7e && data[2] === 0x01) {
        finish(null, data, time);
      }
    });
    const progressTimer = setInterval(() => {
      const elapsedMs = performance.now() - t0;
      onProgress?.({ elapsedMs, acks: acks.sent(performance.now()), maxMs });
      if (elapsedMs > timeoutMs) {
        finish(new Error(`No sample dump from the sampler within ${(timeoutMs / 1000).toFixed(0)} s`));
      }
    }, 200);
    signal?.addEventListener('abort', () => finish(new DOMException('Receive cancelled', 'AbortError')));

    try {
      link.log(`Requesting sample ${slot + 1}: ${hex(requestMessage(slot))}, ACK every ${ackIntervalMs} ms`);
      output.send(requestMessage(slot));
      acks.start(t0 + ackIntervalMs);
    } catch (e) {
      finish(e as Error);
    }
  });
}

export interface TransmitResult {
  bytes: number;
  numBlocks: number;
  wireMs: number;
  cancelled: boolean;
  replies: number;
  kinds: [string, number][];
}

export interface TransmitOptions {
  /** how long to wait for more replies after the dump should have been sent */
  quietMs?: number;
  /** stops waiting, the data is with the MIDI driver and can't be called back */
  signal?: AbortSignal;
  onProgress?: (p: { elapsedMs: number; wireMs: number; replies: number }) => void;
}

/** Sends a whole dump in one send() and counts what the sampler sends back while it receives it */
export function transmitDump(link: MidiLink, dump: Dump, options: TransmitOptions = {}): Promise<TransmitResult> {
  const { quietMs = 2000, signal, onProgress } = options;
  const output = link.output;
  if (!output) {
    return Promise.reject(new TransferError('No MIDI output selected'));
  }
  return new Promise((resolve, reject) => {
    const replies: { time: number; data: Uint8Array }[] = [];
    const unlisten = link.listen((data, time) => {
      if (data[0] === 0xf0) {
        replies.push({ time, data: data.slice() });
      }
    });
    const wireMs = wireSeconds(dump.bytes.length) * 1000;
    const t0 = performance.now();
    try {
      output.send(dump.bytes);
    } catch (e) {
      unlisten();
      reject(e);
      return;
    }
    let done = false;
    const finish = (cancelled: boolean) => {
      if (done) {
        return;
      }
      done = true;
      clearInterval(timer);
      unlisten();
      const kinds = new Map<string, number>();
      for (const { data } of replies) {
        const key = data.length <= 12 ? hex(data) : `${hex(data.subarray(0, 8))} … (${data.length} bytes)`;
        kinds.set(key, (kinds.get(key) ?? 0) + 1);
      }
      resolve({ bytes: dump.bytes.length, numBlocks: dump.numBlocks, wireMs, cancelled, replies: replies.length,
        kinds: [...kinds] });
    };
    const timer = setInterval(() => {
      const now = performance.now();
      const last = replies.length ? replies[replies.length - 1].time : t0;
      onProgress?.({ elapsedMs: now - t0, wireMs, replies: replies.length });
      const allAcked = replies.length >= dump.numBlocks && now - last > 500;
      if (allAcked || (now > t0 + wireMs && now - last > quietMs)) {
        finish(false);
      }
    }, 100);
    signal?.addEventListener('abort', () => finish(true));
  });
}
