// S700/X7000 disk images (.qd), and loading the S612's. An S700 disk side holds one sample with its points, scan
// mode, rate and sound, and its keygroups in the sampler's 32 programs. It holds the sampler's own 12 bit audio, so a
// loaded sample is marked as from the sampler: it is kept and sent as it is.
//
// A reversed sample is stored as it plays, the S700 only shows that it is reversed. Loading reverses it back, so it
// shows as reversed here too.

import { BANDWIDTHS, MAX_SAMPLES, encodeSamples, nearestBandwidth, samplerBandwidth } from '../protocol/akai';
import { S612_RATE, readS612Disk } from '../protocol/s612disk';
import {
  NotS700DiskError, S700_NOT_IN_PROGRAM, S700_PROGRAMS, S700_SCAN, bandwidthRate, buildS700Block, readS700Disk,
  writeS700Disk,
} from '../protocol/s700disk';
import type { S700Disk, S700KeyRange, S700SampleParams } from '../protocol/s700disk';
import type { Resampler } from './convert';
import { isTwelveBit } from './edit';
import { defaultSound, newId } from './mapping';
import { usedStart } from './points';
import { plainRecipe } from './recipe';
import { isLooped } from './types';
import type { Keygroup, LoopMode, Program, Sample, Sound } from './types';

/** A keygroup's settings, without its id and sample */
export type KeyRange = Omit<Keygroup, 'id' | 'sampleId'>;

export interface DiskSample {
  /** S700 for the S700's and X7000's disks */
  format: 'S700' | 'S612';
  sample: Sample;
  /**
   * The sample's keygroup in each of the sampler's programs, null where it isn't in the program. An S612 disk has no
   * program data: its sample goes in a program of its own, as on the X7000, with S612_KEYGROUP.
   */
  programs: (KeyRange | null)[];
  /** what wasn't as it should be, for the log */
  notes: string[];
}

const SCAN_MODES = new Map<number, LoopMode>([[S700_SCAN.oneShot, 'off'], [S700_SCAN.looping, 'forward'],
  [S700_SCAN.alternating, 'alternating'], [S700_SCAN.drum, 'drum']]);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Where the X7000 puts an S612 disk's sample */
export const S612_KEYGROUP: KeyRange = { low: 36, high: 96, root: 60, semitones: 0, cents: 0, fixedPitch: false };

/**
 * The sample on an S700, X7000 or S612 disk image
 *
 * @throws Error if it isn't one
 */
export function sampleFromDisk(image: Uint8Array, name: string): DiskSample {
  let disk: S700Disk;
  try {
    disk = readS700Disk(image);
  } catch (e) {
    if (e instanceof NotS700DiskError) {
      return sampleFromS612Disk(image, name);
    }
    throw e;
  }
  const { params: p, samples, crcOk, skipped } = disk;
  const notes: string[] = [];
  if (!crcOk) {
    notes.push('The disk is damaged (CRC error), the sample may have clicks or noise');
  }
  if (skipped > 0) {
    notes.push('Passed over an older, damaged copy on the disk');
  }
  // the sampler's memory holds 32752 samples, the disk a few more
  const data = Float32Array.from(samples.subarray(0, MAX_SAMPLES), (v) => v / 2048);
  const end = clamp(p.end, 2, data.length);
  let loopMode = SCAN_MODES.get(p.scanMode);
  if (!loopMode) {
    notes.push(`Unknown scan mode ${p.scanMode}, played as one shot`);
    loopMode = 'off';
  }
  const rate = samplerBandwidth(bandwidthRate(p.bandwidth))?.rate ?? bandwidthRate(p.bandwidth);
  if (!samplerBandwidth(rate)) {
    notes.push(`Rate code ${p.bandwidth} isn't one of the sampler's, ${rate.toFixed(0)} Hz`);
  }
  const level = (v: number) => clamp(v, 0, 99);
  const sound: Sound = { level: level(p.loudness), velLevel: level(p.velLoudness), filter: level(p.filter),
    velFilter: level(p.velFilter), release: level(p.release), velRelease: level(p.velRelease),
    lfoSpeed: level(p.lfoSpeed), lfoDepth: level(p.lfoDepth), lfoDelay: level(p.lfoDelay),
    pressure: defaultSound().pressure };
  // the X7000's loop runs from the loop point to END
  let points = { start: clamp(p.start, 0, end - 2), end, loopStart: clamp(p.loop, 0, end - 2), loopEnd: end };
  if (p.reversed) {
    const n = data.length;
    data.reverse();
    points = { start: n - points.end, end: n - points.start, loopStart: n - points.loopEnd,
      loopEnd: n - points.loopStart };
  }
  const sample: Sample = {
    id: newId(), name, source: data, sourceRate: rate, recipe: plainRecipe(), fromSampler: true, rate, data,
    ...points, loopMode, reverse: p.reversed, sound,
  };
  const programs = p.programs.map((r): KeyRange | null => (r.low > r.high ? null : {
    low: r.low, high: r.high, root: p.recordPitch, semitones: r.transpose,
    cents: Math.round((p.fineTune * 100) / 16), fixedPitch: r.constantPitch,
  }));
  return { format: 'S700', sample, programs, notes };
}

/**
 * An S612 disk's sample: its audio at the S612's rate. Its settings aren't known, so it is a one shot of the whole
 * memory; as it isn't at one of the X7000's rates it is loaded as a file is, its edits up to the loader.
 */
function sampleFromS612Disk(image: Uint8Array, name: string): DiskSample {
  const { samples, crcOk, skipped } = readS612Disk(image);
  const notes = ['S612 disk: its start, end and loop aren\'t read (not known yet), it loads as a one shot of all of '
    + 'its memory'];
  if (!crcOk) {
    notes.push('The disk is damaged (CRC error), the sample may have clicks or noise');
  }
  if (skipped > 0) {
    notes.push('Passed over an older, damaged copy on the disk');
  }
  const data = Float32Array.from(samples, (v) => v / 2048);
  const sample: Sample = {
    id: newId(), name, source: data, sourceRate: S612_RATE, recipe: plainRecipe(), fromSampler: false,
    rate: S612_RATE, data, start: 0, end: data.length, loopStart: 0, loopEnd: data.length, loopMode: 'off',
    reverse: false, sound: defaultSound(),
  };
  return { format: 'S612', sample, programs: [], notes };
}

export interface DiskImage {
  /** the .qd file */
  bytes: Uint8Array;
  /** what had to be changed for the sampler, for the log */
  notes: string[];
}

const SCAN_CODES: Record<LoopMode, number> = { off: S700_SCAN.oneShot, forward: S700_SCAN.looping,
  alternating: S700_SCAN.alternating, drum: S700_SCAN.drum };

/** The sampler's lowest key range limit and its highest key */
const HIGHEST_KEY = 99;

/**
 * A disk image of a sample, as the S700 saves one: at one of the sampler's rates, 12 bit, with its points, scan
 * mode and sound, and its keygroups in the first 32 programs. A disk has a START, so all of the sample is saved if it
 * fits, else from START (or a loop start before it).
 *
 * On the sampler the root and the fine tune are the sample's: the first keygroup's are saved, the others' roots go in
 * their transpose.
 */
export async function diskFromSample(sample: Sample, programs: Program[], resample: Resampler)
  : Promise<DiskImage> {
  const notes: string[] = [];
  const own = samplerBandwidth(sample.rate);
  const bw = own ?? nearestBandwidth(sample.rate);
  const ratio = own ? 1 : bw.rate / sample.rate;
  let from = 0;
  let to = sample.data.length;
  if (to * ratio > MAX_SAMPLES + 0.5) {
    from = usedStart(sample);
    to = sample.end;
    if (from > 0 || to < sample.data.length) {
      notes.push('Too long for the sampler: saved from START to END');
    }
  }
  let data = sample.data.subarray(from, to);
  const at = (x: number) => clamp(x - from, 0, data.length);
  let points = { start: at(sample.start), end: at(sample.end), loopStart: at(sample.loopStart),
    loopEnd: at(sample.loopEnd) };
  if (sample.reverse) {
    // stored as it plays
    const n = data.length;
    data = data.slice().reverse();
    points = { start: n - points.end, end: n - points.start, loopStart: n - points.loopEnd,
      loopEnd: n - points.loopStart };
  }
  if (ratio !== 1) {
    data = await resample(data, sample.rate, bw.rate);
    const scaled = (x: number) => clamp(Math.round(x * ratio), 0, data.length);
    points = { start: scaled(points.start), end: scaled(points.end), loopStart: scaled(points.loopStart),
      loopEnd: scaled(points.loopEnd) };
    notes.push(`Resampled from ${Math.round(sample.rate)} to ${bw.rate} Hz (${bw.name})`);
  }
  if (data.length > MAX_SAMPLES) {
    notes.push(`Truncated from ${data.length} to ${MAX_SAMPLES} samples, ${(MAX_SAMPLES / bw.rate).toFixed(2)} s`);
    data = data.subarray(0, MAX_SAMPLES);
    const cut = (x: number) => Math.min(x, MAX_SAMPLES);
    points = { start: cut(points.start), end: cut(points.end), loopStart: cut(points.loopStart),
      loopEnd: cut(points.loopEnd) };
  }
  // its own values if it is 12 bit already (from the sampler, or made so), as sending does
  const samples = ratio === 1 && isTwelveBit(data) ? Int16Array.from(data, (v) => Math.round(v * 2048))
    : Int16Array.from(encodeSamples(data), (code) => code - 2048);
  // the sampler's END is the end of a loop
  const looped = isLooped(sample.loopMode);
  const end = Math.max(points.start + 2, looped ? points.loopEnd : points.end);
  if (looped && points.loopEnd < points.end) {
    notes.push('The sampler\'s END is the loop end');
  }
  const loop = looped ? points.loopStart : Math.min(points.loopStart, end - 1);

  const { ranges, root, cents } = keyRanges(sample.id, programs, notes);
  const s = sample.sound;
  const params: S700SampleParams = {
    programs: ranges, scanMode: SCAN_CODES[sample.loopMode], start: points.start, end, loop,
    lfoSpeed: s.lfoSpeed, lfoDepth: s.lfoDepth, lfoDelay: s.lfoDelay, filter: s.filter, release: s.release,
    loudness: s.level, fineTune: clamp(Math.round((cents * 16) / 100), -16, 16), recordPitch: root,
    bandwidth: 76 - BANDWIDTHS.indexOf(bw), reversed: sample.reverse, velFilter: s.velFilter,
    velLoudness: s.velLevel, velRelease: s.velRelease,
  };
  return { bytes: writeS700Disk(buildS700Block(params, samples)), notes: [...new Set(notes)] };
}

/** The sample's key range in each of the sampler's programs, and the root and fine tune the sampler has for it */
function keyRanges(sampleId: string, programs: Program[], notes: string[])
  : { ranges: S700KeyRange[]; root: number; cents: number } {
  const mine = programs.map((p) => p.keygroups.filter((k) => k.sampleId === sampleId));
  if (mine.slice(S700_PROGRAMS).some((k) => k.length)) {
    notes.push(`The sampler has ${S700_PROGRAMS} programs, only those are saved`);
  }
  const first: Keygroup | undefined = mine.flat()[0];
  if (!first) {
    notes.push('In no program: the sampler plays it from no key until it gets a key range');
  }
  // the S700's nominal recording pitch goes from 24 to 96, a root outside goes in the transpose
  const root = clamp(first?.root ?? 60, 24, 96);
  const cents = first?.cents ?? 0;
  const ranges = mine.slice(0, S700_PROGRAMS).map((keygroups, i): S700KeyRange => {
    const k = keygroups[0];
    if (!k) {
      return S700_NOT_IN_PROGRAM;
    }
    if (keygroups.length > 1) {
      notes.push(`Program ${i + 1} has the sample in ${keygroups.length} keygroups, the sampler in one: saved the `
        + 'first');
    }
    if (k.cents !== cents) {
      notes.push(`The fine tune is the sample's on the sampler: saved with ${cents} cents`);
    }
    if (k.low > HIGHEST_KEY) {
      notes.push(`Program ${i + 1}: the key range is above the sampler's keys, left out`);
      return S700_NOT_IN_PROGRAM;
    }
    // constant pitch plays the sample's own pitch, transposed
    const transpose = k.semitones + (k.fixedPitch ? 0 : root - k.root);
    if (Math.abs(transpose) > 60) {
      notes.push(`Program ${i + 1}: the transpose is more than the sampler's 5 octaves`);
    }
    return { low: k.low, high: Math.min(k.high, HIGHEST_KEY), transpose: clamp(transpose, -60, 60),
      constantPitch: k.fixedPitch, audioTrigger: null };
  });
  while (ranges.length < S700_PROGRAMS) {
    ranges.push(S700_NOT_IN_PROGRAM);
  }
  return { ranges, root, cents };
}
