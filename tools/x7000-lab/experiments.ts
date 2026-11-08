// The test samples and the experiments: series of notes with the test samples' sound changed between them. measure.ts
// plays and records them, analyze.ts analyses the recordings.

import { noise, sine, toCodes } from './sampler';
import type { Sound, TestSample } from './sampler';
import { S700_SCAN } from '../../web/src/protocol/s700disk';

export const DATA = process.env.LAB_DATA ?? '/home/klarog/Develop/div/axs7-lab';

export const SAMPLES: Record<'noise' | 'sine', TestSample> = {
  // noise for the filter: looped, 0.83 s
  noise: { name: 'noise', slot: 1, codes: toCodes(noise(32752)), root: 48, low: 36, high: 59,
    scanMode: S700_SCAN.looping },
  // 800 cycles in the loop: 988.9 Hz at the root
  sine: { name: 'sine', slot: 2, codes: toCodes(sine(32000, 800)), root: 72, low: 60, high: 96,
    scanMode: S700_SCAN.looping },
};

export interface Hit {
  sample: keyof typeof SAMPLES;
  note: number;
  velocity: number;
  /** seconds held */
  hold: number;
  /** seconds after the key off before the next */
  after: number;
  sound: Partial<Sound>;
  /** MIDI messages sent while it is held, at seconds from the key on (aftertouch, controllers) */
  during?: { at: number; bytes: number[] }[];
  /** the key off: a note off with this velocity (0 by default), or a note on with velocity 0 */
  keyOff?: { velocity?: number; asNoteOn?: boolean };
  /** what the analysis groups it by */
  tag: Record<string, number | string>;
}

export interface Event extends Hit {
  /** seconds from the sync note's key on, as sent */
  on: number;
  off: number;
}

/** aftertouch and controller values, a second each, from a second after the key on */
export const PRESSURE_STEPS = [32, 64, 96, 127, 0];
const VELOCITIES = [1, 16, 32, 48, 64, 80, 96, 112, 127];
const steps = (from: number, to: number, by: number) => {
  const out: number[] = [];
  for (let v = from; v <= to; v += by) {
    out.push(v);
  }
  if (out[out.length - 1] !== to) {
    out.push(to);
  }
  return out;
};
export const hit = (sample: Hit['sample'], sound: Partial<Sound>, tag: Hit['tag'], o: Partial<Hit> = {}): Hit => ({
  sample, note: SAMPLES[sample].root, velocity: 127, hold: 1, after: 0.4, sound, tag, ...o });

export const EXPERIMENTS: Record<string, () => Hit[]> = {
  /** the levels, and how long the longest release is */
  pilot: () => [
    hit('noise', {}, { what: 'noise' }, { hold: 2 }),
    hit('sine', {}, { what: 'sine' }, { hold: 1.5 }),
    hit('sine', { release: 50 }, { release: 50 }, { after: 12 }),
    hit('sine', { release: 99 }, { release: 99 }, { after: 30 }),
  ],
  /** the cutoff for each FILTER, at the root, and above and below it */
  filter: () => [
    ...steps(0, 99, 5).reverse().map((filter) => hit('noise', { filter }, { filter, note: 48 }, { hold: 2.5 })),
    ...[36, 42, 54, 59].flatMap((note) => [99, 60, 30].map((filter) =>
      hit('noise', { filter }, { filter, note }, { note, hold: 2.5 }))),
    hit('noise', { filter: 99 }, { filter: 99, note: 48, again: 1 }, { hold: 2.5 }),
  ],
  /** how velocity moves the cutoff */
  velfilter: () => [
    hit('noise', { filter: 99 }, { filter: 99, velFilter: 0, velocity: 127 }, { hold: 2 }),
    ...[0, 33, 66, 99].flatMap((velFilter) => VELOCITIES.map((velocity) =>
      hit('noise', { filter: 30, velFilter }, { filter: 30, velFilter, velocity }, { velocity, hold: 2 }))),
    ...[60].flatMap((filter) => [99].flatMap((velFilter) => VELOCITIES.map((velocity) =>
      hit('noise', { filter, velFilter }, { filter, velFilter, velocity }, { velocity, hold: 2 })))),
  ],
  /** the level for each LEVEL, at full velocity */
  level: () => steps(0, 99, 5).reverse().map((loudness) =>
    hit('sine', { loudness }, { loudness }, { hold: 1.2 })),
  /** how velocity changes the level */
  vellevel: () => [0, 25, 50, 75, 99].flatMap((velLoudness) => [1, 8, ...VELOCITIES.slice(1)].map((velocity) =>
    hit('sine', { velLoudness }, { velLoudness, velocity }, { velocity, hold: 1 }))),
  /** the release for each RELEASE */
  release: () => [0, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 99].map((release) =>
    hit('sine', { release }, { release }, { hold: 1, after: 1.5 + 20 * (release / 99) ** 2 })),
  /** the vibrato's rate for each SPEED (its depth and shape too) */
  lfospeed: () => [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99].map((lfoSpeed) =>
    hit('sine', { lfoSpeed, lfoDepth: 60 }, { lfoSpeed, lfoDepth: 60 }, { hold: lfoSpeed <= 10 ? 9 : lfoSpeed <= 30 ? 5 : 3 })),
  /** the vibrato's depth for each DEPTH */
  lfodepth: () => [0, 5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99].map((lfoDepth) =>
    hit('sine', { lfoSpeed: 60, lfoDepth }, { lfoSpeed: 60, lfoDepth }, { hold: 3 })),
  /** how the vibrato comes in for each DELAY */
  lfodelay: () => [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99].map((lfoDelay) =>
    hit('sine', { lfoSpeed: 60, lfoDepth: 60, lfoDelay }, { lfoSpeed: 60, lfoDepth: 60, lfoDelay },
      { hold: lfoDelay >= 60 ? 12 : 6 })),
  /**
   * vibrato from aftertouch (the sampler's pressure sens) and the modulation wheel: a second at each value, channel
   * pressure, then polyphonic, then controller 1; without the LFO's own depth, then with some, then with a long delay
   */
  pressure: () => [{ lfoDepth: 0, lfoDelay: 0 }, { lfoDepth: 30, lfoDelay: 0 }, { lfoDepth: 0, lfoDelay: 99 }]
    .flatMap((lfo) => ([[0xd0], [0xa0, 72], [0xb0, 1]] as number[][]).map((head) =>
      hit('sine', { lfoSpeed: 60, ...lfo }, { ...lfo, via: head[0].toString(16) }, {
        hold: 7, during: PRESSURE_STEPS.map((v, i) => ({ at: 1 + i, bytes: [...head, v] })) })))
    .concat(hit('sine', { lfoSpeed: 60 }, { reset: 1 }, { hold: 0.5,
      during: [{ at: 0.1, bytes: [0xd0, 0] }, { at: 0.1, bytes: [0xb0, 1, 0] }] })),
  /** the release from 80 up, where it stops getting longer */
  release2: () => [80, 82, 84, 86, 88, 90, 92, 95, 99].map((release) =>
    hit('sine', { release }, { release }, { hold: 1, after: Math.min(13, 1 + 1.2 * 0.569 * 2 ** ((release - 50) / 10)) })),
  /** which velocity VEL>RELEASE follows: the key on's or the key off's */
  velrelease2: () => [
    ...[0, 32, 64, 96, 127].map((offVelocity) => hit('sine', { release: 50, velRelease: 99 },
      { release: 50, velRelease: 99, velocity: 127, offVelocity }, { keyOff: { velocity: offVelocity }, after: 12 })),
    ...[1, 64].map((velocity) => hit('sine', { release: 50, velRelease: 99 },
      { release: 50, velRelease: 99, velocity, offVelocity: 64 }, { velocity, keyOff: { velocity: 64 }, after: 12 })),
    hit('sine', { release: 50, velRelease: 99 }, { release: 50, velRelease: 99, velocity: 127, offBy: 'note on 0' },
      { keyOff: { asNoteOn: true }, after: 12 }),
    ...[0, 64, 127].map((offVelocity) => hit('sine', { release: 50, velRelease: 50 },
      { release: 50, velRelease: 50, velocity: 127, offVelocity }, { keyOff: { velocity: offVelocity }, after: 12 })),
    ...[0, 127].map((offVelocity) => hit('sine', { release: 50, velRelease: 0 },
      { release: 50, velRelease: 0, velocity: 127, offVelocity }, { keyOff: { velocity: offVelocity }, after: 4 })),
  ],
  /**
   * the scan modes at the key off: a one shot let go before its end (0.81 s), with and without RELEASE, and held
   * past it; a drum trigger let go early; alternating with a release
   */
  scan: () => [
    hit('sine', { scanMode: S700_SCAN.oneShot, release: 0 }, { scan: 'one shot', release: 0 }, { hold: 0.3, after: 1.5 }),
    hit('sine', { scanMode: S700_SCAN.oneShot, release: 50 }, { scan: 'one shot', release: 50 }, { hold: 0.3, after: 1.5 }),
    hit('sine', { scanMode: S700_SCAN.oneShot, release: 0 }, { scan: 'one shot', release: 0, long: 1 }, { hold: 1.5, after: 1 }),
    hit('sine', { scanMode: S700_SCAN.drum, release: 0 }, { scan: 'drum', release: 0 }, { hold: 0.3, after: 1.5 }),
    hit('sine', { scanMode: S700_SCAN.drum, release: 50 }, { scan: 'drum', release: 50 }, { hold: 0.3, after: 1.5 }),
    hit('sine', { scanMode: S700_SCAN.alternating, release: 50 }, { scan: 'alternating', release: 50 }, { hold: 1, after: 1.5 }),
  ],
  /**
   * the vibrato two octaves down (ROOT 96, key 72: 247 Hz at 9.9 kHz), where the pitch has finer steps than at the
   * top rate: DEPTH, the shape at the slowest and fastest SPEED, aftertouch and the wheel in eighths
   */
  lfofine: () => {
    const low = { recordPitch: 96 };
    const at = (head: number[]) => Array.from({ length: 8 }, (_, i) => ({ at: 0.8 + i * 0.8, bytes: [...head,
      Math.min(127, 16 * (i + 1))] })).concat({ at: 0.8 + 8 * 0.8, bytes: [...head, 0] });
    return [
      ...steps(0, 99, 5).map((lfoDepth) => hit('sine', { ...low, lfoSpeed: 60, lfoDepth }, { lfoSpeed: 60, lfoDepth },
        { note: 72, hold: 3 })),
      hit('sine', { ...low, lfoSpeed: 5, lfoDepth: 99 }, { lfoSpeed: 5, lfoDepth: 99, shape: 1 }, { note: 72, hold: 6 }),
      hit('sine', { ...low, lfoSpeed: 99, lfoDepth: 99 }, { lfoSpeed: 99, lfoDepth: 99, shape: 1 }, { note: 72, hold: 3 }),
      ...([[0xd0], [0xb0, 1]] as number[][]).map((head) => hit('sine', { ...low, lfoSpeed: 60, lfoDepth: 0 },
        { lfoSpeed: 60, lfoDepth: 0, via: head[0].toString(16) }, { note: 72, hold: 8, during: at(head) })),
    ];
  },
  /** aftertouch and the wheel in eighths, low, as in lfofine: for another PRESSURE setting on the panel */
  sens: () => ([[0xd0], [0xb0, 1]] as number[][]).map((head) => hit('sine', { recordPitch: 96, lfoSpeed: 60,
    lfoDepth: 0 }, { lfoSpeed: 60, lfoDepth: 0, via: head[0].toString(16) }, { note: 72, hold: 8,
    during: Array.from({ length: 8 }, (_, i) => ({ at: 0.8 + i * 0.8, bytes: [...head, Math.min(127, 16 * (i + 1))] }))
      .concat({ at: 0.8 + 8 * 0.8, bytes: [...head, 0] }) })),
  /** how DELAY brings the vibrato in, step by step: the fastest SPEED, to follow the depth closely */
  lfodelay2: () => [45, 50, 55, 60, 65, 70, 75, 80, 83, 86, 89, 92, 95, 97, 99].map((lfoDelay) =>
    hit('sine', { recordPitch: 96, lfoSpeed: 99, lfoDepth: 60, lfoDelay }, { lfoSpeed: 99, lfoDepth: 60, lfoDelay },
      { note: 72, hold: lfoDelay <= 80 ? 3 : lfoDelay <= 92 ? 6 : 12 })),
  /** how velocity changes the release */
  velrelease: () => [50, 99].flatMap((velRelease) => [1, 32, 64, 96, 127].map((velocity) =>
    hit('sine', { release: 80, velRelease }, { release: 80, velRelease, velocity },
      { velocity, hold: 1, after: 14 }))),
};

