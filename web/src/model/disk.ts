// S700/X7000 disk images (.qd), and loading the S612's. An S700 disk side holds one sample with its points, scan
// mode, rate and sound, and its keygroups in the sampler's 32 programs (see s700.ts). It holds the sampler's own 12
// bit audio, so a loaded sample is marked as from the sampler: it is kept and sent as it is. A reversed sample is
// stored as it plays.

import { MAX_SAMPLES } from '../protocol/akai';
import { S612_RATE, readS612Disk } from '../protocol/s612disk';
import { NotS700DiskError, buildS700Block, readS700Disk, writeS700Disk } from '../protocol/s700disk';
import type { S700Disk } from '../protocol/s700disk';
import type { Resampler } from './convert';
import { defaultSound, newId } from './mapping';
import { plainRecipe } from './recipe';
import { sampleFromS700Params, samplerImage } from './s700';
import type { KeyRange, SamplerSample } from './s700';
import type { Program, Sample } from './types';

/**
 * A sample from a disk. An S612 disk has no program data: its sample goes in a program of its own, as on the X7000,
 * with S612_KEYGROUP.
 */
export interface DiskSample extends SamplerSample {
  /** S700 for the S700's and X7000's disks */
  format: 'S700' | 'S612';
}

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
  const { params, samples, crcOk, skipped } = disk;
  const notes: string[] = [];
  if (!crcOk) {
    notes.push('The disk is damaged (CRC error), the sample may have clicks or noise');
  }
  if (skipped > 0) {
    notes.push('Passed over an older, damaged copy on the disk');
  }
  // the sampler's memory holds 32752 samples, the disk a few more
  const got = sampleFromS700Params(params, Float32Array.from(samples.subarray(0, MAX_SAMPLES), (v) => v / 2048), name);
  return { format: 'S700', ...got, notes: [...notes, ...got.notes] };
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

/**
 * A disk image of a sample, as the S700 saves one: at one of the sampler's rates, 12 bit, with its points, scan
 * mode and sound, and its keygroups in the first 32 programs. A disk has a START, so all of the sample is saved if it
 * fits, else from START (or a loop start before it). See samplerImage.
 */
export async function diskFromSample(sample: Sample, programs: Program[], resample: Resampler)
  : Promise<DiskImage> {
  const { params, samples, inProgram, notes } = await samplerImage(sample, programs, resample, 'saved');
  if (!inProgram) {
    notes.push('In no program: the sampler plays it from no key until it gets a key range');
  }
  return { bytes: writeS700Disk(buildS700Block(params, samples)), notes };
}
