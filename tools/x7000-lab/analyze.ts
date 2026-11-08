// Analyses the recordings measure.ts made: node tools/x7000-lab/run.mjs analyze <experiment>...
// Writes <experiment>/results.json and prints a summary.

import fs from 'node:fs';
import { DATA } from './experiments';
import type { Event } from './experiments';
import { readWav } from './record';
import { db, dbAmp, envelope, fitLine, onset, peak, powerSpectrum, rms } from './dsp';

export interface Note extends Event {
  /** where it starts in the recording, in samples */
  start: number;
  /** where its key off is, in samples */
  stop: number;
  /** false if no onset was found, so start is where it should be from the sync note */
  heard: boolean;
  /** dB before it starts: higher than the floor means the note before still sounds */
  before: number;
}

export interface Take {
  name: string;
  rate: number;
  data: Float32Array;
  notes: Note[];
  /** RMS of the quiet before the first note, dBFS */
  floor: number;
}

export function load(name: string): Take {
  const dir = `${DATA}/${name}`;
  const { events } = JSON.parse(fs.readFileSync(`${dir}/events.json`, 'utf8')) as { events: Event[] };
  const { rate, data } = readWav(`${dir}/recording.wav`);
  const quiet = rms(data, 0, Math.round(rate * 0.3));
  const threshold = Math.max(quiet * 30, 10 ** (-60 / 20));
  const first = onset(data, 0, data.length, threshold, rate);
  if (first < 0) {
    throw new Error(`${name}: nothing in the recording`);
  }
  // the sync note is the first sound
  const offset = first / rate - events[0].on;
  const notes = events.map((e): Note => {
    const expected = Math.round((offset + e.on) * rate);
    const found = onset(data, expected - Math.round(rate * 0.03), expected + Math.round(rate * 0.08), threshold,
      rate);
    const start = found >= 0 ? found : expected;
    const stop = start + Math.round((e.off - e.on) * rate);
    const before = dbAmp(rms(data, start - Math.round(rate * 0.1), start - Math.round(rate * 0.005)));
    return { ...e, start, stop, heard: found >= 0, before };
  });
  return { name, rate, data, notes, floor: dbAmp(quiet) };
}

/** Sustained level of a note, dBFS RMS: from 0.3 s after the start (or `skip`) to just before the key off */
export function sustain(t: Take, n: Note, skip = 0.3): number {
  return dbAmp(rms(t.data, n.start + Math.round(t.rate * skip), n.stop - Math.round(t.rate * 0.02)));
}

/**
 * The release after the key off: the level held, and how long it takes to fall 10, 20 ... dB below it, in seconds
 * (null where it doesn't before the next note or the floor)
 */
export function release(t: Take, n: Note, until: number): { held: number; falls: (number | null)[];
  curve: { t: number; db: number }[] } {
  const held = sustain(t, n, 0.3);
  const win = Math.round(t.rate * 0.002);
  const env = envelope(t.data, n.stop - Math.round(t.rate * 0.05), until, win);
  const curve = Array.from(env, (v, i) => ({ t: (i * win) / t.rate - 0.05, db: dbAmp(v) }));
  const falls = [10, 20, 30, 40, 50, 60].map((d) => {
    const p = curve.find((c) => c.t >= 0 && c.db <= held - d);
    return p ? p.t : null;
  });
  return { held, falls, curve };
}

/** The power spectrum of a note's held part, dB per bin, and the bin width */
export function spectrum(t: Take, n: Note, size = 4096): { hz: number; db: Float64Array } {
  const p = powerSpectrum(t.data, n.start + Math.round(t.rate * 0.3), n.stop - Math.round(t.rate * 0.02), size);
  return { hz: t.rate / size, db: p.map(db) };
}

function bandDb(s: { hz: number; db: Float64Array }, f: number, octaves = 1 / 6): number {
  const lo = Math.max(1, Math.floor((f * 2 ** (-octaves / 2)) / s.hz));
  const hi = Math.min(s.db.length - 1, Math.ceil((f * 2 ** (octaves / 2)) / s.hz));
  let sum = 0;
  for (let k = lo; k <= hi; k++) {
    sum += 10 ** (s.db[k] / 10);
  }
  return db(sum / (hi - lo + 1));
}

/** Third octave-ish bands for transfer functions */
export const BANDS = Array.from({ length: 31 }, (_, i) => 50 * 2 ** (i / 3)).filter((f) => f < 21000);

const fmt = (v: number | null, d = 1) => (v === null ? '-' : v.toFixed(d));

function pilot(t: Take): unknown {
  return t.notes.map((n) => {
    const s = spectrum(t, n);
    let top = 1;
    for (let k = 1; k < s.db.length; k++) {
      if (s.db[k] > s.db[top]) {
        top = k;
      }
    }
    const next = t.notes[t.notes.indexOf(n) + 1];
    const r = release(t, n, next ? next.start : t.data.length);
    const out = { tag: n.tag, heard: n.heard, before: n.before, peak: dbAmp(peak(t.data, n.start, n.stop)),
      sustain: sustain(t, n), topHz: top * s.hz, falls: r.falls };
    console.log(`${JSON.stringify(n.tag)}: heard ${n.heard}, before ${fmt(n.before)} dB, peak ${fmt(out.peak)}, `
      + `sustain ${fmt(out.sustain)} dBFS, strongest ${Math.round(out.topHz)} Hz, release -10..-60 dB at `
      + `${r.falls.map((f) => fmt(f, 3)).join(' ')} s`);
    return out;
  });
}

/** 1/12 octave from 30 Hz to 20 kHz */
export const CENTERS = Array.from({ length: 113 }, (_, i) => 30 * 2 ** (i / 12)).filter((f) => f <= 20000);

/** A note's spectrum against a reference note's, dB at CENTERS (1/6 octave wide) */
function transfer(t: Take, n: Note, ref: Note): number[] {
  const a = spectrum(t, n, 8192);
  const b = spectrum(t, ref, 8192);
  return CENTERS.map((f) => bandDb(a, f) - bandDb(b, f));
}

export interface Cutoff {
  /** dB at the lowest frequencies */
  passband: number;
  /** -3 dB below the passband, Hz, null if it doesn't fall */
  fc: number | null;
  /** dB per octave, from -10 to -40 dB */
  slope: number | null;
  /** highest dB above the passband, a resonance */
  peak: number;
}

export function cutoff(h: number[]): Cutoff {
  const passband = (h[0] + h[1] + h[2]) / 3;
  const peakDb = Math.max(...h) - passband;
  let fc: number | null = null;
  for (let i = 1; i < h.length; i++) {
    if (h[i] < passband - 3) {
      // between the two, in log frequency
      const x = (passband - 3 - h[i - 1]) / (h[i] - h[i - 1]);
      fc = CENTERS[i - 1] * 2 ** (x / 12);
      break;
    }
  }
  if (h[0] < -3 && fc === null) {
    fc = CENTERS[0];
  }
  const xs: number[] = [];
  const ys: number[] = [];
  h.forEach((v, i) => {
    if (v < passband - 10 && v > passband - 40 && (!fc || CENTERS[i] > fc)) {
      xs.push(Math.log2(CENTERS[i]));
      ys.push(v);
    }
  });
  return { passband, fc, slope: xs.length >= 4 ? fitLine(xs, ys).slope : null, peak: peakDb };
}

/** dB at some frequencies, for the log */
const sketch = (h: number[]) => [100, 300, 1000, 2000, 4000, 8000, 12000, 16000].map((f) => {
  const i = CENTERS.findIndex((c) => c >= f);
  return `${f >= 1000 ? `${f / 1000}k` : f}:${fmt(h[i], 0)}`;
}).join(' ');

function filter(t: Take): unknown {
  const ref = (note: number) => t.notes.find((n) => n.tag.filter === 99 && n.tag.note === note)!;
  // the response at FILTER 99 itself, against flat (white noise): the output's own roll off
  const flat = (n: Note) => {
    const s = spectrum(t, n, 8192);
    const lo = bandDb(s, 200, 1);
    return CENTERS.map((f) => bandDb(s, f) - lo);
  };
  const out = t.notes.filter((n) => !n.tag.sync).map((n) => {
    const note = n.tag.note as number;
    const h = transfer(t, n, ref(note));
    const c = cutoff(h);
    const open = n.tag.filter === 99 ? cutoff(flat(n)) : null;
    console.log(`note ${note} FILTER ${String(n.tag.filter).padStart(2)}: fc ${c.fc ? Math.round(c.fc) : '-'} Hz, `
      + `slope ${fmt(c.slope)} dB/oct, passband ${fmt(c.passband)} dB, peak +${fmt(c.peak)} | ${sketch(h)}`
      + `${open ? ` | open: fc ${open.fc ? Math.round(open.fc) : '-'} Hz slope ${fmt(open.slope)} | ${sketch(flat(n))}` : ''}`);
    return { tag: n.tag, ...c, h, open: open && { ...open, h: flat(n) } };
  });
  return { centers: CENTERS, notes: out };
}

function velfilter(t: Take): unknown {
  const ref = t.notes.find((n) => n.tag.filter === 99)!;
  const out = t.notes.filter((n) => !n.tag.sync && n !== ref).map((n) => {
    const h = transfer(t, n, ref);
    const c = cutoff(h);
    return { tag: n.tag, ...c, h };
  });
  const groups = new Map<string, typeof out>();
  for (const o of out) {
    const k = `FILTER ${o.tag.filter} VEL>FILTER ${o.tag.velFilter}`;
    groups.set(k, [...(groups.get(k) ?? []), o]);
  }
  for (const [k, g] of groups) {
    console.log(`${k}: ${g.map((o) => `v${o.tag.velocity} ${o.fc ? Math.round(o.fc) : '-'}`).join(', ')} Hz`);
  }
  return { centers: CENTERS, notes: out };
}

function level(t: Take): unknown {
  const out = t.notes.filter((n) => !n.tag.sync).map((n) => ({ tag: n.tag, db: sustain(t, n) }));
  const top = out.find((o) => o.tag.loudness === 99)!.db;
  console.log(out.map((o) => `${o.tag.loudness}: ${fmt(o.db - top)}`).join(', '));
  return { top, notes: out };
}

function vellevel(t: Take): unknown {
  const out = t.notes.filter((n) => !n.tag.sync).map((n) => ({ tag: n.tag, db: sustain(t, n, 0.2) }));
  const top = Math.max(...out.map((o) => o.db));
  for (const amount of [...new Set(out.map((o) => o.tag.velLoudness))]) {
    console.log(`VEL>LEVEL ${amount}: ${out.filter((o) => o.tag.velLoudness === amount)
      .map((o) => `v${o.tag.velocity} ${fmt(o.db - top)}`).join(', ')} dB`);
  }
  return { top, notes: out };
}

/** The release's fall: dB per second fitted from 5 to 50 dB down, and the time to -60 dB that gives */
function fall(t: Take, n: Note): { held: number; dbPerSecond: number | null; t60: number | null; r2: number;
  falls: (number | null)[]; curve: { t: number; db: number }[] } {
  const next = t.notes[t.notes.indexOf(n) + 1];
  const r = release(t, n, next ? next.start - Math.round(t.rate * 0.01) : t.data.length);
  const pts = r.curve.filter((c) => c.t > 0 && c.db < r.held - 5 && c.db > Math.max(r.held - 50, t.floor + 10));
  if (pts.length < 5) {
    return { ...r, dbPerSecond: null, t60: null, r2: 0 };
  }
  const line = fitLine(pts.map((p) => p.t), pts.map((p) => p.db));
  return { ...r, dbPerSecond: -line.slope, t60: 60 / -line.slope, r2: line.r2,
    curve: r.curve.filter((_, i) => i % 5 === 0) };
}

function releases(t: Take): unknown {
  const out = t.notes.filter((n) => !n.tag.sync).map((n) => {
    const f = fall(t, n);
    console.log(`${JSON.stringify(n.tag)}: held ${fmt(f.held)} dBFS, ${fmt(f.dbPerSecond)} dB/s, T60 ${fmt(f.t60, 3)} s`
      + ` (r² ${fmt(f.r2, 4)}), -10..-60 dB at ${f.falls.map((x) => fmt(x, 3)).join(' ')} s`);
    return { tag: n.tag, ...f };
  });
  return { notes: out };
}

/** The pitch cycle by cycle (rising zero crossings), seconds from the note's start and Hz */
export function pitchTrack(t: Take, n: Note, from: number, to: number): { t: number[]; hz: number[] } {
  const d = t.data;
  const crossings: number[] = [];
  for (let i = n.start + Math.round(from * t.rate); i < Math.min(n.start + Math.round(to * t.rate), d.length); i++) {
    if (d[i - 1] < 0 && d[i] >= 0) {
      crossings.push(i - 1 + -d[i - 1] / (d[i] - d[i - 1]));
    }
  }
  const out = { t: [] as number[], hz: [] as number[] };
  for (let k = 1; k < crossings.length; k++) {
    out.t.push(((crossings[k] + crossings[k - 1]) / 2 - n.start) / t.rate);
    out.hz.push(t.rate / (crossings[k] - crossings[k - 1]));
  }
  return out;
}

const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
const percentile = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.floor((v.length - 1) * p)];

export interface Vibrato {
  /** Hz, null if there's none */
  rate: number | null;
  /** cents either way (half of peak to peak, 2nd to 98th percentile) */
  depth: number;
  /** peak over RMS of the pitch around its middle: sine 1.41, triangle 1.73, square 1 */
  crest: number | null;
  /** the middle's offset from the reference, cents */
  center: number;
  /** seconds from the key on to 10, 50 and 90 % of the full depth */
  rise: (number | null)[];
  /** the pitch, cents, every 10 ms */
  curve: { t: number; cents: number }[];
}

/** The strongest rate in a series, by a DFT over a range of rates */
function strongestRate(ts: number[], vs: number[], lo = 0.05, hi = 40): number {
  let best = lo;
  let bestPower = -1;
  const scan = (from: number, to: number, step: number) => {
    for (let f = from; f <= to; f += step) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < ts.length; i++) {
        re += vs[i] * Math.cos(2 * Math.PI * f * ts[i]);
        im += vs[i] * Math.sin(2 * Math.PI * f * ts[i]);
      }
      if (re * re + im * im > bestPower) {
        bestPower = re * re + im * im;
        best = f;
      }
    }
  };
  scan(lo, hi, 0.02);
  const coarse = best;
  scan(Math.max(lo, coarse - 0.03), coarse + 0.03, 0.0005);
  return best;
}

export function vibrato(t: Take, n: Note, refHz: number, settled = 0.3): Vibrato {
  const hold = (n.stop - n.start) / t.rate;
  const p = pitchTrack(t, n, 0.02, hold - 0.03);
  const cents = p.hz.map((f) => 1200 * Math.log2(f / refHz));
  // 10 ms means for the curve
  const curve: { t: number; cents: number }[] = [];
  for (let i = 0; i < p.t.length;) {
    const until = p.t[i] + 0.01;
    let s = 0;
    let c = 0;
    for (; i < p.t.length && p.t[i] < until; i++) {
      s += cents[i];
      c++;
    }
    curve.push({ t: p.t[i - 1], cents: s / c });
  }
  // the full vibrato: the last part of the note, from `settled` on
  const tail = p.t.map((x, i) => [x, cents[i]]).filter(([x]) => x >= Math.max(settled, hold - 3));
  const ts = tail.map(([x]) => x);
  const vs = tail.map(([, v]) => v);
  const center = median(vs);
  const depth = (percentile(vs, 0.98) - percentile(vs, 0.02)) / 2;
  if (depth < 1.5) {
    return { rate: null, depth, crest: null, center, rise: [null, null, null], curve };
  }
  const rate = strongestRate(ts, vs.map((v) => v - center));
  const rmsDev = Math.sqrt(vs.reduce((s, v) => s + (v - center) ** 2, 0) / vs.length);
  // depth over time: the spread in windows of one LFO cycle
  const win = Math.max(0.05, 1 / rate);
  const spreads: { t: number; depth: number }[] = [];
  for (let at = 0.02; at + win < hold; at += win / 4) {
    const w = p.t.map((x, i) => [x, cents[i]]).filter(([x]) => x >= at && x < at + win).map(([, v]) => v);
    if (w.length > 3) {
      spreads.push({ t: at + win / 2, depth: (Math.max(...w) - Math.min(...w)) / 2 });
    }
  }
  const rise = [0.1, 0.5, 0.9].map((f) => spreads.find((s) => s.depth >= f * depth)?.t ?? null);
  return { rate, depth, crest: (depth * 1.0) / rmsDev, center, rise, curve };
}

function lfo(t: Take): unknown {
  // the pitch without vibrato: the sync note's
  const sync = t.notes.find((n) => n.tag.sync)!;
  const refHz = median(pitchTrack(t, sync, 0.1, 0.45).hz);
  console.log(`reference ${refHz.toFixed(2)} Hz (the sample: 988.86 Hz at the top rate)`);
  const out = t.notes.filter((n) => !n.tag.sync && !n.during).map((n) => {
    // with a delay, the full vibrato is the last 2 s
    const v = vibrato(t, n, n.sound.recordPitch === 96 ? refHz / 4 : refHz, n.tag.lfoDelay ? (n.stop - n.start) / t.rate - 2 : 0.3);
    console.log(`${JSON.stringify(n.tag)}: rate ${fmt(v.rate, 3)} Hz, depth ±${fmt(v.depth)} cents, crest ${fmt(v.crest, 2)}`
      + `, center ${fmt(v.center)} c, 10/50/90 % at ${v.rise.map((x) => fmt(x, 2)).join(' ')} s`);
    return { tag: n.tag, ...v };
  });
  return { refHz, notes: out };
}

/** The vibrato in a part of a note: depth (cents either way) and rate */
function vibratoIn(t: Take, n: Note, refHz: number, from: number, to: number): { depth: number; rate: number | null;
  center: number } {
  const p = pitchTrack(t, n, from, to);
  const cents = p.hz.map((f) => 1200 * Math.log2(f / refHz));
  const center = median(cents);
  const depth = (percentile(cents, 0.98) - percentile(cents, 0.02)) / 2;
  return { depth, center, rate: depth >= 1.5 ? strongestRate(p.t, cents.map((c) => c - center), 0.5, 40) : null };
}

function pressure(t: Take): unknown {
  const sync = t.notes.find((n) => n.tag.sync)!;
  const refHz = median(pitchTrack(t, sync, 0.1, 0.45).hz);
  const out = t.notes.filter((n) => n.during?.length && !n.tag.reset).map((n) => {
    // before the first message, then from each to the next (or the key off)
    const during = n.during!;
    const hold = (n.stop - n.start) / t.rate;
    const ref = n.sound.recordPitch === 96 ? refHz / 4 : refHz;
    const parts = [{ value: 'none' as number | string, ...vibratoIn(t, n, ref, 0.3, during[0].at - 0.02) },
      ...during.map((d, i) => ({ value: d.bytes[d.bytes.length - 1],
        ...vibratoIn(t, n, ref, d.at + 0.15, (during[i + 1]?.at ?? hold) - 0.02) }))];
    console.log(`${JSON.stringify(n.tag)}: ${parts.map((p) => `${p.value}: ±${fmt(p.depth)}c`
      + `${p.rate ? ` ${fmt(p.rate, 2)}Hz` : ''}`).join(', ')}`);
    return { tag: n.tag, parts };
  });
  return { refHz, notes: out };
}

/** How a note ends: the level every 50 ms from its start, dB */
function scan(t: Take): unknown {
  const out = t.notes.filter((n) => !n.tag.sync).map((n) => {
    const next = t.notes[t.notes.indexOf(n) + 1];
    const env = envelope(t.data, n.start, next ? next.start : t.data.length, Math.round(t.rate * 0.05));
    const levels = Array.from(env, (v) => Math.round(dbAmp(v)));
    const quiet = levels.findIndex((v) => v < t.floor + 10);
    console.log(`${JSON.stringify(n.tag)}: key off at ${((n.stop - n.start) / t.rate).toFixed(2)} s, quiet at `
      + `${quiet >= 0 ? (quiet * 0.05).toFixed(2) : '-'} s | ${levels.slice(0, 50).join(' ')}`);
    return { tag: n.tag, keyOff: (n.stop - n.start) / t.rate, quiet: quiet >= 0 ? quiet * 0.05 : null, levels };
  });
  return { notes: out };
}

/** The first 30 ms of each note, 1 ms RMS, dB under its held level: the attack */
function attack(t: Take): unknown {
  return t.notes.filter((n) => (n.stop - n.start) / t.rate > 0.4).map((n) => {
    const held = sustain(t, n);
    const env = envelope(t.data, n.start - Math.round(t.rate * 0.002), n.start + Math.round(t.rate * 0.03),
      Math.round(t.rate * 0.001));
    return { tag: n.tag, attack: Array.from(env, (v) => Math.round(dbAmp(v) - held)) };
  });
}

/** When the vibrato's depth reaches each step, for DELAY: half the spread of the pitch over one LFO cycle */
function delaySteps(t: Take): unknown {
  const sync = t.notes.find((n) => n.tag.sync)!;
  const refHz = median(pitchTrack(t, sync, 0.1, 0.45).hz) / 4;
  const LEVELS = [9.1, 15.5, 21.9, 28.4];
  const out = t.notes.filter((n) => !n.tag.sync).map((n) => {
    const hold = (n.stop - n.start) / t.rate;
    const p = pitchTrack(t, n, 0.01, hold - 0.02);
    const cents = p.hz.map((f) => 1200 * Math.log2(f / refHz));
    const period = 1 / 8.3;
    const depthAt = (at: number) => {
      const w = cents.filter((_, i) => p.t[i] >= at && p.t[i] < at + period);
      return w.length > 3 ? (Math.max(...w) - Math.min(...w)) / 2 : 0;
    };
    const reached = LEVELS.map((level) => {
      for (let at = 0; at + period < hold; at += 0.005) {
        if (depthAt(at) >= level - 3) {
          return at + period / 2;
        }
      }
      return null;
    });
    console.log(`DELAY ${n.tag.lfoDelay}: steps at ${reached.map((x) => fmt(x, 3)).join(' ')} s`);
    return { tag: n.tag, reached };
  });
  return { notes: out };
}

const ANALYSES: Record<string, (t: Take) => unknown> = { pressure, scan, attack, sens: pressure, lfodelay2: delaySteps,
  lfofine: (t) => ({ lfo: lfo(t), pressure: pressure(t) }), pilot, filter, velfilter, level, vellevel,
  release: releases, velrelease: releases, release2: releases, velrelease2: releases, lfospeed: lfo, lfodepth: lfo, lfodelay: lfo };

const names = process.argv.slice(2).filter((n, i, all) => !n.startsWith('--') && !all[i - 1]?.startsWith('--'));
const peekAt = process.argv.indexOf('--peek');
if (peekAt >= 0) {
  // the strongest lines of one note's spectrum: --peek <tag json part>
  const t = load(names[0]);
  const want = process.argv[peekAt + 1];
  for (const n of t.notes.filter((x) => JSON.stringify(x.tag).includes(want))) {
    const s = spectrum(t, n, 16384);
    const lines = Array.from(s.db, (v, k) => [k * s.hz, v]).filter(([f]) => f > 2000)
      .filter(([, v], i, a) => i > 0 && i < a.length - 1 && v > a[i - 1][1] && v >= a[i + 1][1])
      .sort((a, b) => b[1] - a[1]).slice(0, 8);
    const floor = [...s.db].sort((a, b) => a - b)[Math.floor(s.db.length / 2)];
    console.log(`${JSON.stringify(n.tag)}: median ${fmt(floor)} dB; ${lines.map(([f, v]) => `${Math.round(f)} Hz ${fmt(v)}`).join(', ')}`);
  }
  process.exit(0);
}
for (const name of names) {
  const t = load(name);
  console.log(`${name}: ${t.notes.length} notes, ${(t.data.length / t.rate).toFixed(1)} s, floor ${fmt(t.floor)} dBFS,`
    + ` ${t.notes.filter((n) => !n.heard).length} not heard`);
  const late = t.notes.filter((n) => n.before > t.floor + 12);
  if (late.length) {
    console.log(`  started while the one before still sounded: ${late.map((n) => JSON.stringify(n.tag)).join(' ')}`);
  }
  // --as <analysis>: another analysis of the recording, written to <analysis>.json beside it
  const asAt = process.argv.indexOf('--as');
  const as = asAt >= 0 ? process.argv[asAt + 1] : null;
  const results = (ANALYSES[as ?? name] ?? pilot)(t);
  fs.writeFileSync(`${DATA}/${name}/${as ? `${as}.json` : 'results.json'}`, JSON.stringify(results, null, 1));
}
