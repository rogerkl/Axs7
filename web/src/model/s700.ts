// The S700's parameters of a sample (protocol/s700disk.ts) as a sample here: its points, scan mode, rate and sound,
// and its keygroups in the sampler's 32 programs. A disk has them with the audio. Over MIDI they come apart from the
// audio, in the S700's sample parameter message (protocol/sprm.ts), as a sample dump has none of them.
//
// A reversed sample is stored as it plays, the S700 only shows that it is reversed. It is reversed back here, so it
// shows as reversed too.

import { BANDWIDTHS, MAX_SAMPLES, encodeSamples, nearestBandwidth, samplerBandwidth } from '../protocol/akai';
import type { ParsedDump } from '../protocol/akai';
import { S700_NOT_IN_PROGRAM, S700_PROGRAMS, S700_SCAN, bandwidthRate } from '../protocol/s700disk';
import type { S700KeyRange, S700SampleParams } from '../protocol/s700disk';
import type { Resampler } from './convert';
import { isTwelveBit } from './edit';
import { defaultSound, newId } from './mapping';
import { usedStart } from './points';
import { plainRecipe } from './recipe';
import { isLooped } from './types';
import type { Keygroup, LoopMode, Program, Sample, Sound } from './types';

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
 * A slot whose sample is in no program: no key plays it on the sampler, so it isn't worth receiving with the bank. A
 * slot with nothing loaded is so: the X7000 has a test tone there (START 0, END 360, LOOP 0), in no program, but
 * not always that short after it is switched on.
 */
export function inNoProgram(p: S700SampleParams): boolean {
  return p.programs.every((k) => k.low > k.high);
}

/** The part of the sampler's memory a dump has: its START to its END when it sent it */
export interface Dumped {
  start: number;
  end: number;
}

/**
 * A sample received from the sampler with the parameters it sent for it. The sampler dumps its memory from START to
 * END; for the receive they may have been set to 0 and to the most (`dumped`, else told by the dump's length). The
 * sample has all the dump has, with its points where they are on the sampler; a loop point before what the dump has
 * can't be had. The rate is the parameters': a dump an X7000 sent once had no usable period in its header.
 */
export function sampleFromDumpWithParams(r: ParsedDump, p: S700SampleParams, name: string, dumped?: Dumped)
  : SamplerSample {
  const data = (r.data ?? new Float32Array(0)).slice(0, MAX_SAMPLES);
  const notes: string[] = [];
  const words = r.header?.totalWords;
  const sent = dumped ?? (words === MAX_SAMPLES ? { start: 0, end: MAX_SAMPLES }
    : { start: words === p.end ? 0 : p.start, end: p.end });
  const from = sent.start;
  if (data.length !== sent.end - from) {
    notes.push(`The dump has ${data.length} samples, the sampler's ${from} to ${sent.end} is ${sent.end - from}`);
  }
  const loopMode = SCAN_MODES.get(p.scanMode);
  if (p.loop < from && loopMode && isLooped(loopMode)) {
    notes.push(`LOOP ${p.loop} is before START ${p.start}, and the dump has START to END only: the loop is lost, `
      + 'it starts at START here.');
  }
  const moved = { ...p, start: Math.max(0, p.start - from), end: p.end - from, loop: Math.max(0, p.loop - from) };
  const got = sampleFromS700Params(moved, data, name);
  const header = r.header;
  if (header?.periodValid && Math.abs(header.sampleRate - got.sample.rate) > 1) {
    notes.push(`The dump's header has ${header.sampleRate.toFixed(1)} Hz, the parameters ${got.sample.rate} Hz: `
      + 'took the parameters\'');
  }
  return { ...got, notes: [...notes, ...got.notes] };
}

const SCAN_CODES: Record<LoopMode, number> = { off: S700_SCAN.oneShot, forward: S700_SCAN.looping,
  alternating: S700_SCAN.alternating, drum: S700_SCAN.drum };

/** The sampler's lowest key range limit and its highest key */
const HIGHEST_KEY = 99;

export interface SamplerImage {
  /** the sampler's parameters for it, its key ranges from the programs */
  params: S700SampleParams;
  /** 12 bit, -2048..2047, the sampler's memory from its start */
  samples: Int16Array;
  /** the sampler's rate it is at */
  rate: number;
  /** false if it is in no program: no key plays it with these key ranges */
  inProgram: boolean;
  notes: string[];
}

/**
 * A sample as the sampler keeps it, as on a disk: at one of its rates, 12 bit, with its points, scan mode and sound,
 * and its keygroups in the first 32 programs. All of the sample if it fits, else from START (or a loop start before
 * it) to END. A reversed sample is stored as it plays.
 *
 * On the sampler the root and the fine tune are the sample's: the first keygroup's are taken, the others' roots go in
 * their transpose.
 *
 * @param done for the notes: 'saved' or 'sent'
 */
export async function samplerImage(sample: Sample, programs: Program[], resample: Resampler, done: string)
  : Promise<SamplerImage> {
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
      notes.push(`Too long for the sampler: ${done} from START to END`);
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
  // its own values if it is 12 bit already (from the sampler, or made so)
  const samples = ratio === 1 && isTwelveBit(data) ? Int16Array.from(data, (v) => Math.round(v * 2048))
    : Int16Array.from(encodeSamples(data), (code) => code - 2048);
  // the sampler's END is the end of a loop
  const looped = isLooped(sample.loopMode);
  const end = Math.max(points.start + 2, looped ? points.loopEnd : points.end);
  if (looped && points.loopEnd < points.end) {
    notes.push('The sampler\'s END is the loop end');
  }
  const loop = looped ? points.loopStart : Math.min(points.loopStart, end - 1);

  const { ranges, root, cents, inProgram } = keyRanges(sample.id, programs, notes, done);
  const s = sample.sound;
  const params: S700SampleParams = {
    programs: ranges, scanMode: SCAN_CODES[sample.loopMode], start: points.start, end, loop,
    lfoSpeed: s.lfoSpeed, lfoDepth: s.lfoDepth, lfoDelay: s.lfoDelay, filter: s.filter, release: s.release,
    loudness: s.level, fineTune: clamp(Math.round((cents * 16) / 100), -16, 16), recordPitch: root,
    bandwidth: 76 - BANDWIDTHS.indexOf(bw), reversed: sample.reverse, velFilter: s.velFilter,
    velLoudness: s.velLevel, velRelease: s.velRelease,
  };
  return { params, samples, rate: bw.rate, inProgram, notes: [...new Set(notes)] };
}

/** The sample's key range in each of the sampler's programs, and the root and fine tune the sampler has for it */
function keyRanges(sampleId: string, programs: Program[], notes: string[], done: string)
  : { ranges: S700KeyRange[]; root: number; cents: number; inProgram: boolean } {
  const mine = programs.map((p) => p.keygroups.filter((k) => k.sampleId === sampleId));
  if (mine.slice(S700_PROGRAMS).some((k) => k.length)) {
    notes.push(`The sampler has ${S700_PROGRAMS} programs, only those are ${done}`);
  }
  const first: Keygroup | undefined = mine.flat()[0];
  // the S700's nominal recording pitch goes from 24 to 96, a root outside goes in the transpose
  const root = clamp(first?.root ?? 60, 24, 96);
  const cents = first?.cents ?? 0;
  const ranges = mine.slice(0, S700_PROGRAMS).map((keygroups, i): S700KeyRange => {
    const k = keygroups[0];
    if (!k) {
      return S700_NOT_IN_PROGRAM;
    }
    if (keygroups.length > 1) {
      notes.push(`Program ${i + 1} has the sample in ${keygroups.length} keygroups, the sampler in one: ${done} the `
        + 'first');
    }
    if (k.cents !== cents) {
      notes.push(`The fine tune is the sample's on the sampler: ${done} with ${cents} cents`);
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
  return { ranges, root, cents, inProgram: !!first };
}
