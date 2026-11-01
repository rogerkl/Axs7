// Web MIDI side of the sample dump transfers.
//
// Two browser behaviours shape this (checked in Chromium's source):
// - Incoming sysex is held back until its F7 arrives, so a dump (one long sysex) arrives as one message when the
//   sampler is done. The sampler waits for an ACK after the header and each block, so the ACKs are sent blind at
//   a fixed pace, as the Java version does. They are sent with timestamps a little ahead of time, which Chrome
//   schedules in its own process, so tab timer jitter and throttling don't disturb the pace.
// - send() rejects a sysex without F7 and data without a status byte, so a dump can't be sent in pieces with a
//   wait for the sampler's ACK between them. It has to be one send() of the whole dump.

import { ACK, MAX_BLOCKS, hex, parseDump, requestMessage, wireSeconds } from './akai.js';

/** @returns why Web MIDI can't be used here, or null if it can */
export function webMidiProblem() {
  if (!globalThis.isSecureContext) {
    return 'Web MIDI needs a secure context: open the page from http://localhost or https.';
  }
  if (!navigator.requestMIDIAccess) {
    return 'This browser has no Web MIDI. Use Chrome or Edge (Firefox needs a site permission add-on, Safari has '
      + 'no Web MIDI).';
  }
  return null;
}

export function requestAccess() {
  return navigator.requestMIDIAccess({ sysex: true });
}

/**
 * The selected input and output. One listener on the input passes messages to the log and to whatever transfer
 * is waiting for them.
 */
export class MidiLink {
  /**
   * @param {MIDIAccess} access
   * @param {(text: string, level?: string) => void} log
   */
  constructor(access, log) {
    this.access = access;
    this.log = log;
    /** @type {MIDIInput|null} */
    this.input = null;
    /** @type {MIDIOutput|null} */
    this.output = null;
    this.listeners = new Set();
    this.realTimeCount = 0;
    this.onMessage = this.onMessage.bind(this);
  }

  async setInput(id) {
    this.input?.removeEventListener('midimessage', this.onMessage);
    this.input = (id && this.access.inputs.get(id)) || null;
    if (this.input) {
      this.input.addEventListener('midimessage', this.onMessage);
      await this.input.open();
    }
  }

  async setOutput(id) {
    this.output = (id && this.access.outputs.get(id)) || null;
    if (this.output) {
      await this.output.open();
    }
  }

  /** @param {MIDIMessageEvent} event */
  onMessage(event) {
    const data = event.data;
    const time = event.timeStamp || performance.now();
    if (data.length === 1 && data[0] >= 0xf8) {
      this.realTimeCount++; // clock or active sensing, too many to log
    } else if (data[0] === 0xf0 && data.length > 16) {
      this.log(`in: sysex, ${data.length} bytes: ${hex(data.subarray(0, 12))} …`);
    } else {
      this.log(`in: ${hex(data)}`);
    }
    for (const listener of this.listeners) {
      listener(data, time);
    }
  }

  /** @returns a function that removes the listener */
  listen(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Sends ACKs at a fixed pace with timestamps, keeping `lookaheadMs` of them scheduled ahead.
 */
class AckScheduler {
  constructor(output, intervalMs, lookaheadMs, log) {
    this.output = output;
    this.intervalMs = intervalMs;
    this.lookaheadMs = lookaheadMs;
    this.log = log;
    /** times the ACKs are scheduled for */
    this.times = [];
    this.lateRefills = 0;
    this.timer = null;
  }

  start(firstTime) {
    this.next = firstTime;
    this.fill();
    // refill well within the lookahead, or the ACKs run out before the next refill
    this.timer = setInterval(() => this.fill(), Math.min(100, this.lookaheadMs / 3));
  }

  fill() {
    const now = performance.now();
    if (this.next < now) {
      // the timer ran late (hidden tab?), skip the missed ACKs instead of sending them as a burst
      this.lateRefills++;
      this.log(`ACK timer was ${(now - this.next).toFixed(0)} ms late, the sampler may have timed out. `
        + 'Keep the tab visible, or raise the lookahead.', 'warn');
      this.next = now;
    }
    const horizon = now + this.lookaheadMs;
    while (this.next <= horizon) {
      this.output.send(ACK, this.next);
      this.times.push(this.next);
      this.next += this.intervalMs;
    }
  }

  /** @returns how many ACKs were due before `time`, and how many are still scheduled after it */
  stop(time) {
    clearInterval(this.timer);
    try {
      this.output.clear?.(); // in the spec, but not every browser has it
    } catch {
      // ignore
    }
    const sent = this.times.filter((t) => t <= time).length;
    return { sent, after: this.times.length - sent, lateRefills: this.lateRefills,
      lastAckAt: this.times.length ? this.times[this.times.length - 1] : 0 };
  }
}

/**
 * Requests a sample from the sampler and receives it.
 *
 * @param {MidiLink} link
 * @param {number} slot 0-5
 * @param {object} options
 * @param {number} [options.ackIntervalMs] a little slower than a block takes to send (122 bytes = 39 ms)
 * @param {number} [options.lookaheadMs]
 * @param {AbortSignal} [options.signal]
 * @param {(p: {elapsedMs: number, acks: number, maxMs: number}) => void} [options.onProgress]
 */
export function receiveDump(link, slot, options = {}) {
  const { ackIntervalMs = 50, lookaheadMs = 1500, signal, onProgress } = options;
  const log = link.log;
  // the longest dump takes MAX_BLOCKS ACKs, plus some time before the sampler starts
  const maxMs = (MAX_BLOCKS + 1) * ackIntervalMs;
  const timeoutMs = maxMs + 10_000;
  return new Promise((resolve, reject) => {
    const acks = new AckScheduler(link.output, ackIntervalMs, lookaheadMs, log);
    let done = false;
    const t0 = performance.now();

    const finish = (error, data, time) => {
      if (done) {
        return;
      }
      done = true;
      clearInterval(progressTimer);
      unlisten();
      const at = time ?? performance.now();
      const ackInfo = acks.stop(at);
      // ACKs already scheduled can't be called back, lastAckAt is when the last one goes out
      const timing = { seconds: (at - t0) / 1000, acksSent: ackInfo.sent, acksAfterEnd: ackInfo.after,
        lateRefills: ackInfo.lateRefills, lastAckAt: ackInfo.lastAckAt };
      if (error) {
        error.timing = timing;
        reject(error);
      } else {
        resolve({ ...parseDump(data), raw: data.slice(), timing });
      }
    };

    const unlisten = link.listen((data, time) => {
      if (data[0] === 0xf0 && data[1] === 0x7e && data[2] === 0x01) {
        finish(null, data, time);
      }
    });
    const progressTimer = setInterval(() => {
      const elapsedMs = performance.now() - t0;
      onProgress?.({ elapsedMs, acks: acks.times.filter((t) => t <= performance.now()).length, maxMs });
      if (elapsedMs > timeoutMs) {
        finish(new Error(`No sample dump from the sampler within ${(timeoutMs / 1000).toFixed(0)} s`));
      }
    }, 200);
    signal?.addEventListener('abort', () => finish(new DOMException('Receive cancelled', 'AbortError')));

    try {
      log(`Requesting sample ${slot + 1}: ${hex(requestMessage(slot))}, ACK every ${ackIntervalMs} ms`);
      link.output.send(requestMessage(slot));
      acks.start(t0 + ackIntervalMs);
    } catch (e) {
      finish(e);
    }
  });
}

/**
 * Sends a whole dump in one send() and records what the sampler sends back while it receives it.
 *
 * @param {MidiLink} link
 * @param {{bytes: Uint8Array, numBlocks: number}} dump
 * @param {object} options
 * @param {number} [options.quietMs] how long to wait for more messages after the dump should have been sent
 * @param {AbortSignal} [options.signal] stops waiting, the data is with the MIDI driver and can't be called back
 * @param {(p: {elapsedMs: number, wireMs: number, replies: number}) => void} [options.onProgress]
 */
export function transmitDump(link, dump, options = {}) {
  const { quietMs = 2000, signal, onProgress } = options;
  return new Promise((resolve, reject) => {
    const replies = [];
    const unlisten = link.listen((data, time) => {
      if (data[0] === 0xf0) {
        replies.push({ time, data: data.slice() });
      }
    });
    const wireMs = wireSeconds(dump.bytes.length) * 1000;
    const t0 = performance.now();
    try {
      link.output.send(dump.bytes);
    } catch (e) {
      unlisten();
      reject(e);
      return;
    }
    let done = false;
    const finish = (cancelled) => {
      if (done) {
        return;
      }
      done = true;
      clearInterval(timer);
      unlisten();
      resolve(summarizeReplies(replies, t0, dump, wireMs, cancelled));
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

function summarizeReplies(replies, t0, dump, wireMs, cancelled) {
  const kinds = new Map();
  for (const { data } of replies) {
    const key = data.length <= 12 ? hex(data) : `${hex(data.subarray(0, 8))} … (${data.length} bytes)`;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  const times = replies.map((r) => r.time - t0);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  return {
    bytes: dump.bytes.length,
    numBlocks: dump.numBlocks,
    wireMs,
    cancelled,
    replies: replies.length,
    kinds: [...kinds],
    firstMs: times[0],
    lastMs: times[times.length - 1],
    gaps: gaps.length
      ? { min: Math.min(...gaps), avg: gaps.reduce((a, b) => a + b, 0) / gaps.length, max: Math.max(...gaps) }
      : null,
  };
}
