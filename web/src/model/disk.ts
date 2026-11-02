// Samples from S700/X7000 disk images (.qd): the sample with its points, scan mode, rate and sound, and the keygroups
// it has in the sampler's 32 programs. A disk holds the sampler's own 12 bit audio, so the sample is marked as from
// the sampler: it is kept and sent as it is.

import { MAX_SAMPLES, samplerBandwidth } from '../protocol/akai';
import { S700_SCAN, bandwidthRate, readS700Disk } from '../protocol/s700disk';
import { defaultSound, newId } from './mapping';
import { plainRecipe } from './recipe';
import type { Keygroup, LoopMode, Sample, Sound } from './types';

/** A keygroup's settings, without its id and sample */
export type KeyRange = Omit<Keygroup, 'id' | 'sampleId'>;

export interface DiskSample {
  sample: Sample;
  /** the sample's keygroup in each of the sampler's programs, null where it isn't in the program */
  programs: (KeyRange | null)[];
  /** what wasn't as it should be, for the log */
  notes: string[];
}

const SCAN_MODES = new Map<number, LoopMode>([[S700_SCAN.oneShot, 'off'], [S700_SCAN.looping, 'forward'],
  [S700_SCAN.alternating, 'alternating'], [S700_SCAN.drum, 'drum']]);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The sample on an S700 or X7000 disk image
 *
 * @throws Error if it isn't one
 */
export function sampleFromDisk(image: Uint8Array, name: string): DiskSample {
  const { params: p, samples, crcOk, skipped } = readS700Disk(image);
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
  if (p.reversed) {
    notes.push('Reversed on the sampler: it is stored as it plays, so it plays the same here');
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
  const sample: Sample = {
    id: newId(), name, source: data, sourceRate: rate, recipe: plainRecipe(), fromSampler: true, rate, data,
    // the X7000's loop runs from the loop point to END
    start: clamp(p.start, 0, end - 2), end, loopStart: clamp(p.loop, 0, end - 2), loopEnd: end, loopMode,
    reverse: false, sound,
  };
  const programs = p.programs.map((r): KeyRange | null => (r.low > r.high ? null : {
    low: r.low, high: r.high, root: p.recordPitch, semitones: r.transpose,
    cents: Math.round((p.fineTune * 100) / 16), fixedPitch: r.constantPitch,
  }));
  return { sample, programs, notes };
}
