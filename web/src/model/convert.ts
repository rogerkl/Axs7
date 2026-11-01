// Between samples in memory and the sampler's dumps and wav files.

import {
  MAX_SAMPLES, buildDump, encodeSamples, isOneShot, matchesBandwidth, nearestBandwidth, peak, samplerBandwidth,
} from '../protocol/akai';
import type { Dump, FillerOptions, ParsedDump } from '../protocol/akai';
import type { Wav, WavLoop } from '../protocol/wav';
import { newId } from './mapping';
import type { Sample } from './types';

/**
 * A received dump as a sample. The sampler ends a sample at its loop end, so what comes after it is left out.
 */
export function sampleFromDump(r: ParsedDump, name: string): Sample {
  const data = r.data ?? new Float32Array(0);
  const loopEnd = Math.min(r.loopEnd ?? data.length, data.length);
  const loopStart = r.loopStart ?? 0;
  const end = loopEnd > 0 ? loopEnd : data.length;
  const oneShot = isOneShot(loopStart, loopEnd);
  return {
    id: newId(),
    name,
    rate: r.header!.sampleRate,
    data: data.slice(0, end),
    loopStart: oneShot ? 0 : loopStart,
    loopEnd: end,
    loopMode: oneShot ? 'off' : r.header!.alternating ? 'alternating' : 'forward',
  };
}

/**
 * A wav file as a sample, with the first loop of its smpl chunk, or as one shot without one. A wav file only has
 * whole Hz, so a rate that is one of the sampler's (like 39555 for 39555.4) gets the sampler's exact rate.
 */
export function sampleFromWav(wav: Wav, name: string): Sample {
  const n = wav.data.length;
  const loop = wav.loops?.[0];
  const loopEnd = loop ? Math.min(loop.end, n) : n;
  return {
    id: newId(),
    name,
    rate: samplerBandwidth(wav.sampleRate)?.rate ?? wav.sampleRate,
    data: wav.data,
    loopStart: loop ? Math.min(loop.start, loopEnd) : 0,
    loopEnd,
    loopMode: loop ? (loop.alternating ? 'alternating' : 'forward') : 'off',
  };
}

export function wavLoops(sample: Sample): WavLoop[] {
  return sample.loopMode === 'off' ? []
    : [{ start: sample.loopStart, end: sample.loopEnd, alternating: sample.loopMode === 'alternating' }];
}

export type Resampler = (data: Float32Array, fromRate: number, toRate: number) => Promise<Float32Array>;

export interface SampleData {
  data: Float32Array;
  rate: number;
  loopStart: number;
  loopEnd: number;
}

/** A sample at another rate, with its loop moved to the same place in time */
export async function resampleSample(sample: Sample, toRate: number, resample: Resampler): Promise<SampleData> {
  const data = await resample(sample.data, sample.rate, toRate);
  const ratio = toRate / sample.rate;
  const loopEnd = Math.min(Math.round(sample.loopEnd * ratio), data.length);
  return { data, rate: toRate, loopStart: Math.min(Math.round(sample.loopStart * ratio), loopEnd), loopEnd };
}

export interface SamplerFit {
  /** the rate the sample goes to the sampler at: its own if it is one of the sampler's, else the nearest */
  sendRate: number;
  /** where the sampler's maximum length ends, in the sample's own samples */
  limit: number;
  /** how much of the sample the sampler keeps: to the loop end of a looped sample, all of a one shot */
  used: number;
  fits: boolean;
  /** the longest sample the sampler takes at the send rate */
  maxSeconds: number;
}

/** Whether a sample fits on the sampler. The sampler ends a looped sample at its loop end. */
export function samplerFit(sample: Sample, sendRate = (samplerBandwidth(sample.rate)
  ?? nearestBandwidth(sample.rate)).rate): SamplerFit {
  // the tolerance keeps 32752 * r / r from flooring to 32751
  const limit = Math.floor((MAX_SAMPLES * sample.rate) / sendRate + 1e-6);
  const used = sample.loopMode === 'off' ? sample.data.length : sample.loopEnd;
  return { sendRate, limit, used, fits: used <= limit, maxSeconds: MAX_SAMPLES / sendRate };
}

export interface SendOptions {
  /** 0-5 */
  slot: number;
  normalize: boolean;
  filler?: FillerOptions;
}

/**
 * Makes the dump to send a sample to the sampler: resampled to the nearest of its rates (it rounds other rates
 * down and keeps the rest as a fine tune it applies in the wrong direction), truncated to its maximum length.
 *
 * @returns the dump and notes about what had to be changed
 */
export async function dumpFromSample(sample: Sample, options: SendOptions, resample: Resampler)
  : Promise<{ dump: Dump; notes: string[] }> {
  const notes: string[] = [];
  const bw = nearestBandwidth(sample.rate);
  let data = sample.data;
  let ratio = 1;
  if (!matchesBandwidth(bw, sample.rate)) {
    data = await resample(sample.data, sample.rate, bw.rate);
    ratio = bw.rate / sample.rate;
    notes.push(`Resampled from ${Math.round(sample.rate)} to ${bw.rate} Hz (${bw.name})`);
  }
  let n = data.length;
  if (n > MAX_SAMPLES) {
    notes.push(`Truncated from ${n} to ${MAX_SAMPLES} samples, ${(MAX_SAMPLES / bw.rate).toFixed(2)} s`);
    n = MAX_SAMPLES;
  }
  let loopStart = n;
  let loopEnd = n; // one shot: a loop shorter than 5 samples
  if (sample.loopMode !== 'off') {
    loopEnd = Math.min(Math.round(sample.loopEnd * ratio), n);
    loopStart = Math.min(Math.round(sample.loopStart * ratio), loopEnd);
    if (isOneShot(loopStart, loopEnd)) {
      notes.push('The loop is shorter than 5 samples, the sampler plays it as one shot');
    } else if (loopEnd < n) {
      notes.push('The sampler ends the sample at the loop end, it drops the rest');
    }
  }
  const slice = data.subarray(0, n);
  const max = peak(slice);
  const codes = encodeSamples(slice, options.normalize && max > 0 ? 1 / max : 1);
  const dump = buildDump({
    slot: options.slot, sampleRate: bw.rate, numSamples: n, loopStart, loopEnd,
    alternating: sample.loopMode === 'alternating',
  }, codes, options.filler);
  return { dump, notes };
}
