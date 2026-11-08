// Raw MIDI on Linux: an ALSA rawmidi device (/dev/snd/midiC<card>D<device>) read and written as a file, no
// libraries. The messages coming in are split up as they arrive, system exclusive whole.

import fs from 'node:fs';

export interface Midi {
  send(bytes: ArrayLike<number>): void;
  /** the next message for which `match` is true, or null after `ms` */
  next(match: (m: Uint8Array) => boolean, ms: number): Promise<Uint8Array | null>;
  close(): void;
}

/** The first rawmidi device of the card named like `name` in /proc/asound/cards */
export function findDevice(name: RegExp): string {
  const cards = fs.readFileSync('/proc/asound/cards', 'utf8');
  for (const line of cards.split('\n')) {
    const m = /^\s*(\d+)\s+\[/.exec(line);
    if (m && name.test(line)) {
      const path = `/dev/snd/midiC${m[1]}D0`;
      if (fs.existsSync(path)) {
        return path;
      }
    }
  }
  throw new Error(`No MIDI device like ${name} in /proc/asound/cards`);
}

export function openMidi(path: string): Midi {
  const out = fs.openSync(path, 'w');
  // read without blocking, polled: a blocking read in Node's thread pool keeps the process from exiting
  const input = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  const buf = Buffer.alloc(4096);
  const waiting: { match: (m: Uint8Array) => boolean; resolve: (m: Uint8Array | null) => void }[] = [];
  const queue: Uint8Array[] = [];
  let sysex: number[] | null = null;
  let status = 0;
  let data: number[] = [];
  const deliver = (m: Uint8Array) => {
    const i = waiting.findIndex((w) => w.match(m));
    if (i >= 0) {
      waiting.splice(i, 1)[0].resolve(m);
    } else {
      queue.push(m);
      if (queue.length > 256) {
        queue.shift();
      }
    }
  };
  const lengths: Record<number, number> = { 0x80: 2, 0x90: 2, 0xa0: 2, 0xb0: 2, 0xc0: 1, 0xd0: 1, 0xe0: 2 };
  const parse = (chunk: Uint8Array) => {
    for (const b of chunk) {
      if (b >= 0xf8) {
        continue; // real time: clock, active sensing
      }
      if (b === 0xf0) {
        sysex = [b];
      } else if (b === 0xf7) {
        if (sysex) {
          sysex.push(b);
          deliver(Uint8Array.from(sysex));
        }
        sysex = null;
      } else if (b & 0x80) {
        sysex = null;
        status = b;
        data = [];
      } else if (sysex) {
        sysex.push(b);
      } else if (status) {
        data.push(b);
        if (data.length === (lengths[status & 0xf0] ?? 1)) {
          deliver(Uint8Array.from([status, ...data]));
          data = [];
        }
      }
    }
  };
  const poll = setInterval(() => {
    for (;;) {
      let n = 0;
      try {
        n = fs.readSync(input, buf, 0, buf.length, null);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') {
          throw e;
        }
      }
      if (n <= 0) {
        return;
      }
      parse(buf.subarray(0, n));
    }
  }, 1);
  return {
    send(bytes) {
      const buf = Buffer.from(Uint8Array.from(bytes));
      let at = 0;
      while (at < buf.length) {
        at += fs.writeSync(out, buf, at);
      }
    },
    next(match, ms) {
      const i = queue.findIndex(match);
      if (i >= 0) {
        return Promise.resolve(queue.splice(i, 1)[0]);
      }
      return new Promise((resolve) => {
        const w = { match, resolve: (m: Uint8Array | null) => { clearTimeout(timer); resolve(m); } };
        const timer = setTimeout(() => {
          waiting.splice(waiting.indexOf(w), 1);
          resolve(null);
        }, ms);
        waiting.push(w);
      });
    },
    close() {
      clearInterval(poll);
      fs.closeSync(out);
      fs.closeSync(input);
    },
  };
}
