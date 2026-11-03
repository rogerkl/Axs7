// The S700's parameters of a sample (protocol/s700disk.ts) as a sample here: its points, scan mode, rate and sound,
// and its keygroups in the sampler's 32 programs. A disk has them with the audio. Over MIDI they come apart from the
// audio, in the S700's sample parameter message (protocol/sprm.ts), as a sample dump has none of them.
//
// A reversed sample is stored as it plays, the S700 only shows that it is reversed. It is reversed back here, so it
// shows as reversed too.

import { MAX_SAMPLES, samplerBandwidth } from '../protocol/akai';
import type { ParsedDump } from '../protocol/akai';
import { S700_SCAN, bandwidthRate } from '../protocol/s700disk';
import type { S700SampleParams } from '../protocol/s700disk';
import { defaultSound, newId } from './mapping';
import { plainRecipe } from './recipe';
import { isLooped } from './types';
import type { Keygroup, LoopMode, Sample, Sound } from './types';

/** A keygroup's settings, without its id and sample */
export type KeyRange = Omit<Keygroup, 'id' | 'sampleId'>;

export interface SamplerSample {
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
 * A sample with the S700's parameters, its audio as the sampler has it, so marked as from the sampler
 *
 * @param data the audio the points are in, from the start of the sampler's memory
 */
export function sampleFromS700Params(p: S700SampleParams, data: Float32Array, name: string): SamplerSample {
  const notes: string[] = [];
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
  return { sample, programs, notes };
}

/**
 * A sample received from the sampler with the parameters it sent for it. The sampler dumps its memory from START to
 * END, so the points are moved by START; a loop point before START can't be had. The rate is the parameters': the
 * X7000's dump header doesn't have it right.
 */
export function sampleFromDumpWithParams(r: ParsedDump, p: S700SampleParams, name: string): SamplerSample {
  const data = (r.data ?? new Float32Array(0)).slice(0, MAX_SAMPLES);
  const notes: string[] = [];
  const length = p.end - p.start;
  if (data.length !== length) {
    notes.push(`The dump has ${data.length} samples, START to END on the sampler is ${length}`);
  }
  const loopMode = SCAN_MODES.get(p.scanMode);
  if (p.loop < p.start && loopMode && isLooped(loopMode)) {
    notes.push(`LOOP ${p.loop} is before START ${p.start}: the sampler only sends START to END, so the loop is `
      + `lost and starts at START here. Set START to ${p.loop} or less on the sampler and receive again to keep it.`);
  }
  const moved = { ...p, start: 0, end: length, loop: Math.max(0, p.loop - p.start) };
  const got = sampleFromS700Params(moved, data, name);
  const header = r.header;
  if (header?.periodValid && Math.abs(header.sampleRate - got.sample.rate) > 1) {
    notes.push(`The dump's header has ${header.sampleRate.toFixed(1)} Hz, the parameters ${got.sample.rate} Hz: `
      + 'took the parameters\'');
  }
  return { ...got, notes: [...notes, ...got.notes] };
}
