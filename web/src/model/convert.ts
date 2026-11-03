// Between samples in memory and the sampler's dumps and wav files.

import {
  MAX_SAMPLES, buildDump, encodeSamples, isOneShot, matchesBandwidth, nearestBandwidth, samplerBandwidth,
} from '../protocol/akai';
import type { Dump, FillerOptions, ParsedDump } from '../protocol/akai';
import { S700_SCAN } from '../protocol/s700disk';
import type { S700SampleParams } from '../protocol/s700disk';
import type { Wav, WavLoop } from '../protocol/wav';
import { isTwelveBit } from './edit';
import { defaultSound, newId } from './mapping';
import { plainRecipe } from './recipe';
import { samplerImage } from './s700';
import { isLooped } from './types';
import { usedStart } from './points';
import type { Program, Sample } from './types';

/**
 * A received dump as a sample, marked as from the sampler: it is sent back as it came. The sampler ends a sample at
 * its loop end, so what comes after it is left out.
 */
export function sampleFromDump(r: ParsedDump, name: string): Sample {
  const data = r.data ?? new Float32Array(0);
  const loopEnd = Math.min(r.loopEnd ?? data.length, data.length);
  const loopStart = r.loopStart ?? 0;
  const end = loopEnd > 0 ? loopEnd : data.length;
  const oneShot = isOneShot(loopStart, loopEnd);
  const kept = data.slice(0, end);
  return {
    id: newId(),
    name,
    source: kept,
    sourceRate: r.header!.sampleRate,
    recipe: plainRecipe(),
    fromSampler: true,
    rate: r.header!.sampleRate,
    data: kept,
    start: 0,
    end,
    loopStart: oneShot ? 0 : loopStart,
    loopEnd: end,
    loopMode: oneShot ? 'off' : r.header!.alternating ? 'alternating' : 'forward',
    reverse: false,
    sound: defaultSound(),
  };
}

/**
 * A wav file as a sample, with the first loop of its smpl chunk, or as one shot without one, without edits. A wav
 * file only has whole Hz, so a rate that is one of the sampler's (like 39555 for 39555.4) gets the sampler's exact
 * rate. A file saved from a sample that came from the sampler is marked so again.
 */
export function sampleFromWav(wav: Wav, name: string): Sample {
  const n = wav.data.length;
  const loop = wav.loops?.[0];
  const loopEnd = loop ? Math.min(loop.end, n) : n;
  const rate = samplerBandwidth(wav.sampleRate)?.rate ?? wav.sampleRate;
  return {
    id: newId(),
    name,
    source: wav.data,
    sourceRate: rate,
    recipe: plainRecipe(),
    fromSampler: !!wav.meta.fromSampler,
    rate,
    data: wav.data,
    start: 0,
    end: n,
    loopStart: loop ? Math.min(loop.start, loopEnd) : 0,
    loopEnd,
    loopMode: loop ? (loop.alternating ? 'alternating' : 'forward') : 'off',
    reverse: false,
    sound: defaultSound(),
  };
}

export function wavLoops(sample: Sample): WavLoop[] {
  return !isLooped(sample.loopMode) ? []
    : [{ start: sample.loopStart, end: sample.loopEnd, alternating: sample.loopMode === 'alternating' }];
}

export type Resampler = (data: Float32Array, fromRate: number, toRate: number) => Promise<Float32Array>;

export interface SamplerFit {
  /** the rate the sample goes to the sampler at: its own if it is one of the sampler's, else the nearest */
  sendRate: number;
  /** how many of the sample's own samples the sampler takes, counted from where what is sent begins */
  limit: number;
  /** where the sampler's limit is in the sample: the start of what is sent + limit, or END - limit when reversed */
  limitAt: number;
  /** how much of the sample the sampler keeps: from START (or a loop start before it) to the loop end of a looped
   * sample, from END to the loop start when reversed, all of a one shot */
  used: number;
  fits: boolean;
  /** the longest sample the sampler takes at the send rate */
  maxSeconds: number;
}

/**
 * Whether a sample fits on the sampler. Only the part from START (or a loop start before it) to END is sent, and the
 * sampler ends a loop at its end. A reversed sample is sent reversed, so it starts at END and its loop ends at the
 * loop start.
 */
export function samplerFit(sample: Sample, sendRate = (samplerBandwidth(sample.rate)
  ?? nearestBandwidth(sample.rate)).rate): SamplerFit {
  const { end, loopStart, loopEnd, reverse } = sample;
  const from = usedStart(sample);
  // the tolerance keeps 32752 * r / r from flooring to 32751
  const limit = Math.floor((MAX_SAMPLES * sample.rate) / sendRate + 1e-6);
  const used = !isLooped(sample.loopMode) ? end - from : reverse ? end - loopStart : loopEnd - from;
  return { sendRate, limit, limitAt: reverse ? end - limit : from + limit, used, fits: used <= limit,
    maxSeconds: MAX_SAMPLES / sendRate };
}

export interface SendOptions {
  /** from 0 */
  slot: number;
  filler?: FillerOptions;
}

/**
 * Makes the dump to send a sample to the sampler: the part between START and END of the rendered audio, from the
 * loop start if a loop goes back before START (a dump has no START, the sampler's START is 0 after it), resampled to the nearest of its rates if it isn't at one (it rounds other rates
 * down and keeps the rest as a fine tune it applies in the wrong direction), truncated to its maximum length.
 * It is sent as it sounds: normalizing is the recipe's, not done again here.
 *
 * @returns the dump and notes about what had to be changed
 */
export async function dumpFromSample(sample: Sample, options: SendOptions, resample: Resampler)
  : Promise<{ dump: Dump; notes: string[] }> {
  const notes: string[] = [];
  const bw = nearestBandwidth(sample.rate);
  const from = usedStart(sample);
  let data = sample.data.subarray(from, sample.end);
  // the loop counted from the start of what is sent
  let [loopFrom, loopTo] = [sample.loopStart - from, sample.loopEnd - from];
  let ratio = 1;
  if (from < sample.start) {
    notes.push(`The loop starts before START: sending from the loop start to END, ${
      ((sample.end - from) / sample.rate).toFixed(2)} s`);
  } else if (from > 0 || sample.end < sample.data.length) {
    notes.push(`Sending the part from START to END, ${((sample.end - from) / sample.rate).toFixed(2)} s`);
  }
  if (sample.reverse) {
    // the sampler's direction isn't in a dump: send it reversed, to play forward there as it sounds here
    data = data.slice().reverse();
    [loopFrom, loopTo] = [data.length - loopTo, data.length - loopFrom];
    notes.push('Sent reversed, leave SCAN DIRECTION at F on the sampler');
  }
  if (!matchesBandwidth(bw, sample.rate)) {
    data = await resample(data, sample.rate, bw.rate);
    ratio = bw.rate / sample.rate;
    notes.push(`Resampled from ${Math.round(sample.rate)} to ${bw.rate} Hz (${bw.name})`);
  }
  if (from < sample.start && !sample.reverse) {
    // reversed, playing starts at END, which is where the sampler starts it
    notes.push(`A dump has no START: set START to ${Math.round((sample.start - from) * ratio)} on the sampler to `
      + 'play from where it starts here');
  }
  let n = data.length;
  if (n > MAX_SAMPLES) {
    notes.push(`Truncated from ${n} to ${MAX_SAMPLES} samples, ${(MAX_SAMPLES / bw.rate).toFixed(2)} s`);
    n = MAX_SAMPLES;
  }
  let loopStart = n;
  let loopEnd = n; // one shot: a loop shorter than 5 samples
  if (isLooped(sample.loopMode)) {
    loopEnd = Math.min(Math.round(loopTo * ratio), n);
    loopStart = Math.min(Math.round(loopFrom * ratio), loopEnd);
    if (isOneShot(loopStart, loopEnd)) {
      notes.push('The loop is shorter than 5 samples, the sampler plays it as one shot');
    } else if (loopEnd < n) {
      notes.push('The sampler ends the sample at the loop end, it drops the rest');
    }
  }
  const slice = data.subarray(0, n);
  let codes: Uint16Array;
  if (ratio === 1 && isTwelveBit(slice)) {
    // made 12 bit, or received from the sampler: its own values, not normalized again
    codes = Uint16Array.from(slice, (v) => Math.round(v * 2048) + 2048);
    notes.push('Already 12 bit, sent as it is');
  } else {
    codes = encodeSamples(slice);
  }
  const dump = buildDump({
    slot: options.slot, sampleRate: bw.rate, numSamples: n, loopStart, loopEnd,
    alternating: sample.loopMode === 'alternating',
  }, codes, options.filler);
  return { dump, notes };
}

export interface DumpWithParams {
  dump: Dump;
  /** to send after the dump, see sampleParamsMessage */
  params: S700SampleParams;
  /** false if it is in no program: its key ranges would have no key play it */
  inProgram: boolean;
  notes: string[];
}

/**
 * Makes the dump to send a sample to a sampler that then gets its parameters (START, END, loop, scan mode, sound
 * and key ranges) with the S700's sample parameters message: all of the sample, as a disk has it, if it fits. The
 * header's loop is the parameters', so the sampler has END and the loop right if it doesn't take them.
 */
export async function dumpWithParams(sample: Sample, programs: Program[], options: SendOptions,
  resample: Resampler): Promise<DumpWithParams> {
  const { params, samples, rate, inProgram, notes } = await samplerImage(sample, programs, resample, 'sent');
  const looped = params.scanMode === S700_SCAN.looping || params.scanMode === S700_SCAN.alternating;
  const dump = buildDump({
    slot: options.slot, sampleRate: rate, numSamples: samples.length,
    // a one shot: a loop shorter than 5 samples
    loopStart: looped ? params.loop : params.end, loopEnd: params.end,
    alternating: params.scanMode === S700_SCAN.alternating,
  }, Uint16Array.from(samples, (v) => v + 2048), options.filler);
  return { dump, params, inProgram, notes };
}
