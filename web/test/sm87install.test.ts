// Installing a package on an FM-1 over Web MIDI (app/sm87install.ts, with fm1-base's fm1ota.js): against an FM-1 made
// here on a fake Web MIDI, which speaks fm1-base's update protocol as its firmware and its update loader do (the
// identity query, the read requests, the restarts). The real loader is fm1-base's to test (its tests/installer_*);
// here: the install's way through, an install finished, the failures said, and fm1-base's files as fm1-base has them.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { InstallError, installPackage } from '../src/app/sm87install';
import type { InstallProgress } from '../src/app/sm87install';
import { HS_FULL, pack7, unpack7 } from '../src/sm87/fm1ota.js';
import { crc16 } from '../src/sm87/sm87bank.js';

const HS_QUERY = [0xf0, 0x00, 0x32, 0x45, 0x00, 0x00, 0x00, 0x40, 0x7f, 0xf7];
const UPGRADE = [0xf0, 0x22, 0x24, 0x35, 0x7f, 0xf7];
const STEP1_DONE = 0xe0000000;
const STEP2_DONE = 0xf0000000;
const same = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length
  && Array.from(a).every((x, i) => x === b[i]);

// ------------------------------------------------------------------------------------------------- a package ---
function enc(b: Uint8Array, key = 0xffff): Uint8Array {
  for (let i = 0; i < b.length; i++) {
    b[i] ^= key & 0xff;
    key = ((key << 1) ^ (key & 0x8000 ? 0x1021 : 0)) & 0xffff;
  }
  return b;
}

/** a .fwsc as fm1-base's tools/fm1pkg_make.py ufw() makes one, of a made-up flash.bin and ota.bin */
function fwsc(flash: Uint8Array, ota: Uint8Array, product: string): Uint8Array {
  const parts: [number, string, Uint8Array][] = [[0, 'flash.bin', flash], [100, 'ota.bin', ota]];
  let off = 0x400;
  const ents: { e: Uint8Array; off: number; d: Uint8Array }[] = [];
  parts.forEach(([type, name, d], i) => {
    off = (off + 0xff) & ~0xff;
    const e = new Uint8Array(0x50);
    const v = new DataView(e.buffer);
    v.setUint16(0, type, true);
    v.setUint16(2, i, true);
    v.setUint16(4, crc16(d), true);
    v.setUint32(8, off, true);
    v.setUint32(12, d.length, true);
    v.setUint32(16, (d.length + 31) & ~31, true);
    e.set([...name].map((c) => c.charCodeAt(0)), 0x40);
    ents.push({ e, off, d });
    off += d.length;
  });
  const hdr = new Uint8Array(0x40);
  const hv = new DataView(hdr.buffer);
  hv.setUint32(4, off, true);
  hv.setUint16(8, parts.length, true);
  hv.setUint16(10, 4, true);
  hv.setUint16(12, 0x200, true);
  hdr.set([...'AC791N'].map((c) => c.charCodeAt(0)), 16);
  const list = new Uint8Array(ents.length * 0x50);
  ents.forEach(({ e }, i) => list.set(enc(e.slice()), i * 0x50));
  hv.setUint16(2, crc16(list), true);
  hv.setUint16(0, crc16(hdr.subarray(2)), true);
  const logical = new Uint8Array(off).fill(0xff);
  logical.set(enc(hdr), 0);
  logical.set(list, 0x40);
  ents.forEach(({ off: o, d }) => logical.set(d, o));
  const raw: number[] = [];
  for (let i = 0; i < 20; i++) {
    raw.push(...logical.subarray(i * 0x2f, (i + 1) * 0x2f), i < product.length ? (product.charCodeAt(i) + i + 1) & 0xff
      : 0x7d);
  }
  raw.push(...logical.subarray(20 * 0x2f));
  return Uint8Array.from(raw);
}

const noise = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => (i * 131 + seed * 7 + (i >> 5)) & 0xff);
const PACKAGE = fwsc(noise(0x5000, 1), noise(900, 2), 'FM-1_8700');
/** the image the FM-1 reads: the package without its 20 marker bytes */
const IMAGE = (() => {
  const out: number[] = [];
  for (let i = 0; i < 20; i++) {
    out.push(...PACKAGE.subarray(i * 0x30, i * 0x30 + 0x2f));
  }
  out.push(...PACKAGE.subarray(20 * 0x30));
  return Uint8Array.from(out);
})();

// ---------------------------------------------------------------------------------- an FM-1 on a fake Web MIDI ---
type Listener = (e: { data: Uint8Array }) => void;

class Port {
  state = 'connected';
  connection = 'closed';
  onmidimessage: Listener | null = null;
  private listeners = new Set<Listener>();
  constructor(readonly id: string, readonly name: string, readonly type: string, private onSend?: (d: number[]) => void) {}
  open() {
    this.connection = 'open';
    return Promise.resolve(this);
  }
  close() {
    return Promise.resolve(this);
  }
  addEventListener(_t: string, f: Listener) {
    this.listeners.add(f);
  }
  removeEventListener(_t: string, f: Listener) {
    this.listeners.delete(f);
  }
  send(data: ArrayLike<number>) {
    this.onSend?.(Array.from(data));
  }
  deliver(data: number[]) {
    const e = { data: Uint8Array.from(data) };
    this.onmidimessage?.(e);
    this.listeners.forEach((f) => f(e));
  }
}

/**
 * An FM-1 as its firmware and update loader answer: who it is (the firmware: its name and three digits, then all of
 * it), and an update's reads of the image, a few in the firmware's step and all of it in the loader's, each answer
 * checked against the image; after each step it restarts, into the loader and then into the firmware it was given
 */
class Fm1 {
  readonly input: Port;
  readonly output: Port;
  /** what it was sent, the requests' answers wrong */
  wrong = 0;
  heard: number[][] = [];
  reads: { mode: string; addr: number; len: number }[] = [];
  private plan: { addr: number; len: number }[] = [];

  constructor(public mode: 'firmware' | 'loader', public runs: string, name = 'SM-87 FM-1') {
    this.input = new Port('in', name, 'input');
    this.output = new Port('out', name, 'output', (d) => this.receive(d));
  }

  access(): MIDIAccess {
    return { inputs: new Map([['in', this.input]]), outputs: new Map([['out', this.output]]), sysexEnabled: true,
      onstatechange: null, addEventListener() {}, removeEventListener() {} } as unknown as MIDIAccess;
  }

  private say(bytes: number[]): void {
    setTimeout(() => this.input.deliver(bytes), 1);
  }

  private identity(text: string): number[] {
    const d = new Array(34).fill(0);
    d.splice(0, 6, 0x00, 0x59, 0x11, text.length, 0, 0);
    [...text].forEach((c, i) => {
      d[6 + i] = c.charCodeAt(0);
    });
    return [0xf0, ...pack7(d), 0xf7];
  }

  private request({ addr, len }: { addr: number; len: number }): void {
    const u = [0x00, 0x59, 0x30, 8, 0, 0, 0, addr & 0xff, (addr >>> 8) & 0xff, (addr >>> 16) & 0xff,
      (addr >>> 24) & 0xff, len & 0xff, (len >> 8) & 0xff, 0];
    u.push(~u.slice(6, 14).reduce((a, b) => a + b, 0) & 0xff);
    this.say([0xf0, ...pack7(u), 0xf7]);
  }

  private receive(d: number[]): void {
    this.heard.push(d);
    if (same(d, HS_QUERY)) {
      this.say(this.identity(this.mode === 'loader' ? 'ota-FM-1_870' : this.runs.slice(0, this.runs.indexOf('_') + 4)));
    } else if (same(d, HS_FULL) && this.mode === 'firmware') {
      this.say(this.identity(this.runs));
    } else if (same(d, UPGRADE)) {
      // the firmware reads the header and the loader's part; the loader the whole image, 512 bytes at a time
      this.plan = this.mode === 'firmware' ? [{ addr: 0, len: 0x40 }, { addr: 0x40, len: 0xa0 }, { addr: 0x700, len: 512 }]
        : Array.from({ length: Math.ceil(IMAGE.length / 512) },
          (_, k) => ({ addr: k * 512, len: Math.min(512, IMAGE.length - k * 512) }));
      this.plan.push({ addr: this.mode === 'firmware' ? STEP1_DONE : STEP2_DONE, len: 8 });
      this.request(this.plan[0]);
    } else if (d[0] === 0xf0 && this.plan.length) {
      const u = unpack7(d.slice(1, -1));
      if (u[0] !== 0 || u[1] !== 0x59 || u[2] !== 0x30) {
        return;
      }
      const addr = (u[7] | (u[8] << 8) | (u[9] << 16) | (u[10] << 24)) >>> 0;
      const len = u[11] | (u[12] << 8);
      const want = this.plan.shift()!;
      if (addr !== want.addr) {
        this.wrong++;
      } else if (addr === STEP1_DONE || addr === STEP2_DONE) {
        // it restarts: into the loader, then into the firmware it wrote
        setTimeout(() => {
          this.mode = this.mode === 'firmware' ? 'loader' : 'firmware';
          if (addr === STEP2_DONE) {
            this.runs = 'FM-1_8700';
          }
        }, 50);
        return;
      } else {
        this.reads.push({ mode: this.mode, addr, len });
        if (!same(u.slice(14, 14 + len), IMAGE.subarray(addr, addr + len))) {
          this.wrong++;
        }
      }
      if (this.plan.length) {
        this.request(this.plan[0]);
      }
    }
  }
}

const quick = (u: { pause: number }) => {
  u.pause = 0;
};

async function failure(p: Promise<unknown>): Promise<InstallError> {
  try {
    await p;
  } catch (e) {
    return e as InstallError;
  }
  throw new Error('it did not fail');
}

describe('installing on the FM-1', () => {
  test('its fm1-base files are fm1-base\'s', () => {
    for (const f of ['fm1ota.js', 'fm1ports.js', 'fm1pkg.js']) {
      const theirs = new URL(`../../../sm-87/fm1-base/web/${f}`, import.meta.url);
      if (existsSync(theirs)) {
        expect(readFileSync(new URL(`../src/sm87/${f}`, import.meta.url), 'utf8'), f)
          .toBe(readFileSync(theirs, 'utf8'));
      }
    }
  });

  test('installs: the firmware reads its part, the loader the whole image; it comes back running the package',
    async () => {
      const fm1 = new Fm1('firmware', 'FM-1_8600');
      const progress: InstallProgress[] = [];
      const runs = await installPackage(fm1.access(), PACKAGE, (p) => progress.push(p), () => {}, quick);
      expect(runs).toBe('FM-1_8700');
      expect(fm1.wrong).toBe(0);
      expect(fm1.reads.filter((r) => r.mode === 'firmware').length).toBe(3);
      expect(fm1.reads.filter((r) => r.mode === 'loader').reduce((n, r) => n + r.len, 0)).toBe(IMAGE.length);
      const steps = [...new Set(progress.map((p) => p.step))];
      expect(steps).toEqual(['start', 'verify', 'loader', 'write', 'reboot', 'done']);
      expect(progress.every((p, i) => i === 0 || p.pct >= progress[i - 1].pct)).toBe(true);
      expect(progress.at(-1)).toEqual({ step: 'done', pct: 100, text: 'DONE' });
      expect(progress.filter((p) => p.step === 'write').at(-1)!.text).toMatch(/^WRITING \d+%$/);
      expect(Math.max(...progress.filter((p) => p.step !== 'done').map((p) => p.pct))).toBeLessThanOrEqual(99);
    }, 40000);

  test('an FM-1 waiting in update mode: that install finished', async () => {
    const fm1 = new Fm1('loader', 'FM-1_8700');
    const progress: InstallProgress[] = [];
    expect(await installPackage(fm1.access(), PACKAGE, (p) => progress.push(p), () => {}, quick)).toBe('FM-1_8700');
    expect(fm1.wrong).toBe(0);
    expect(fm1.reads.every((r) => r.mode === 'loader')).toBe(true);
    expect(progress.some((p) => p.step === 'start')).toBe(false);
    expect(progress.at(-1)!.pct).toBe(100);
  }, 30000);

  test('no FM-1: notfound, said as fm1-base\'s installer says it', async () => {
    const access = { inputs: new Map(), outputs: new Map() } as unknown as MIDIAccess;
    const e = await failure(installPackage(access, PACKAGE, () => {}, () => {}, quick));
    expect(e).toBeInstanceOf(InstallError);
    expect(e.code).toBe('notfound');
    expect(e.message).toMatch(/^FM-1 not found\. Check the USB cable/);
  }, 20000);

  test('another device: model; a damaged package: badpkg, the FM-1 not asked', async () => {
    const other = new Fm1('firmware', 'PERF-1_100', 'FM-1 lookalike');
    const e = await failure(installPackage(other.access(), PACKAGE, () => {}, () => {}, quick));
    expect([e.code, e.message]).toEqual(['model', 'The connected device is not an FM-1.']);
    expect(other.reads).toEqual([]);
    const fm1 = new Fm1('firmware', 'FM-1_8600');
    const bad = PACKAGE.slice();
    bad[0x2000] ^= 1;
    const d = await failure(installPackage(fm1.access(), bad, () => {}, () => {}, quick));
    expect(d.code).toBe('badpkg');
    expect(fm1.heard).toEqual([]);
  }, 20000);
});
