// What a sample can do without, to make it smaller for a sampler or player with little memory: the tail after its
// sound has died away (FIND END), and the rate above what its content needs (FIND RATE). Both look at the original,
// so what the sample's edits do (a fade out, a resampling) doesn't move what they find.

import { BANDWIDTHS, BW16, samplerBandwidth } from '../protocol/akai';
import { usedStart } from './points';
import { isLooped } from './types';
import type { Sample } from './types';

/** A level, dB under another, as a factor */
export const dbLevel = (db: number): number => 10 ** (db / 20);

/** The fade out FIND END gives a sample that has none, so where it now ends doesn't click */
export const FOUND_END_FADE_MS = 10;

/** Where a sample's sound has died away, or why it has no such place */
export type FoundEnd =
  /** the point to move (START when the sample plays backwards), its new place, and the samples that no longer play */
  | { point: 'end' | 'start'; at: number; cut: number }
  | { why: 'LOOPED' | 'SILENT' };

/** The original's samples a sample of the sample's own is: more than one when it is resampled lower */
const scale = (s: Pick<Sample, 'rate' | 'sourceRate'>) => s.sourceRate / s.rate;

/**
 * Where a one shot's sound has died away for good: nothing after it that plays comes up to `db` under the loudest of
 * what plays. It can end there, with a short fade out, and TRIM then lets go of the rest. Playing backwards, it ends
 * at START, which goes to the first sample at the level. A looped sample plays on while held, it has no such end.
 *
 * @param db under the loudest, negative
 */
export function findEnd(s: Sample, db: number): FoundEnd {
  if (isLooped(s.loopMode)) {
    return { why: 'LOOPED' };
  }
  const k = scale(s);
  const source = s.source;
  const from = Math.max(0, Math.floor(s.start * k));
  const to = Math.min(source.length, Math.ceil(s.end * k));
  let peak = 0;
  for (let i = from; i < to; i++) {
    peak = Math.max(peak, Math.abs(source[i]));
  }
  if (peak === 0) {
    return { why: 'SILENT' };
  }
  const level = peak * dbLevel(Math.min(0, db));
  if (s.reverse) {
    let first = from;
    while (Math.abs(source[first]) < level) {
      first++;
    }
    const at = Math.max(s.start, Math.min(s.end - 2, Math.floor(first / k)));
    return { point: 'start', at, cut: at - s.start };
  }
  let last = to - 1;
  while (Math.abs(source[last]) < level) {
    last--;
  }
  const at = Math.min(s.end, Math.max(s.start + 2, Math.ceil((last + 1) / k)));
  return { point: 'end', at, cut: s.end - at };
}

/** A spectrum's frame for a rate: about 50 ms, a power of two, so its frequencies are about 20 Hz apart */
export function spectrumSize(rate: number): number {
  return 2 ** Math.max(8, Math.min(13, Math.round(Math.log2(rate / 20))));
}

/** Where in the original the part that plays is (see playedAudio) */
function playedPart(s: Sample) {
  const k = scale(s);
  const at = (i: number) => Math.max(0, Math.min(s.source.length, Math.round(i * k)));
  const looped = isLooped(s.loopMode) && s.loopEnd > s.loopStart;
  return { from: at(usedStart(s)), to: at(s.end), loop: looped ? { from: at(s.loopStart), to: at(s.loopEnd) } : null };
}

/** What playedAudio gives for a sample, the same while what it gives is */
export function playedKey(s: Sample, size: number): string {
  return JSON.stringify([playedPart(s), s.loopMode, s.reverse, size, s.source.length, s.sourceRate]);
}

/**
 * What of the original plays, in the order it plays, to look at its content: START (or a loop start before it) to
 * END, backwards when reversed, and a looped sample's loop repeated after it (`size` samples of it at least), so the
 * loop counts as much as the rest and the analysis doesn't end in a cut that isn't there.
 */
export function playedAudio(s: Sample, size: number): Float32Array {
  const { from, to, loop: part } = playedPart(s);
  const loop = part && part.to > part.from ? s.source.subarray(part.from, part.to) : null;
  const turns = loop ? Math.ceil(size / loop.length) + 1 : 0;
  const audio = new Float32Array(to - from + turns * (loop?.length ?? 0));
  audio.set(s.source.subarray(from, to));
  if (s.reverse) {
    audio.subarray(0, to - from).reverse();
  }
  for (let t = 0; loop && t < turns; t++) {
    const turn = audio.subarray(to - from + t * loop.length, to - from + (t + 1) * loop.length);
    turn.set(loop);
    // a loop runs the way the sample plays; an alternating one turns at its ends, so it goes back first
    const backwards = s.loopMode === 'alternating' ? (t % 2 === 0) !== s.reverse : s.reverse;
    if (backwards) {
      turn.reverse();
    }
  }
  return audio;
}

/**
 * How high the content of a peak spectrum (see Dsp.peakSpectrum) goes: the highest frequency that comes up to `db`
 * under the loudest. An offset (0 Hz) doesn't count.
 *
 * @returns Hz, null if it is silent
 */
export function highestFrequency(spectrum: Float32Array, rate: number, db: number): number | null {
  let peak = 0;
  for (let k = 1; k < spectrum.length; k++) {
    peak = Math.max(peak, spectrum[k]);
  }
  if (peak === 0) {
    return null;
  }
  const level = peak * dbLevel(Math.min(0, db));
  let k = spectrum.length - 1;
  while (spectrum[k] < level) {
    k--;
  }
  return (k * rate) / (2 * (spectrum.length - 1));
}

/**
 * The lowest of the sampler's rates that holds frequencies up to `hz` (a rate holds up to half of it), its highest
 * if none does. Null if that is no lower than the original's own rate, when it is one of the sampler's: resampling
 * it higher adds nothing.
 */
export function rateForContent(hz: number, sourceRate: number): number | null {
  const holds = BANDWIDTHS.map((b) => b.rate).filter((rate) => rate >= 2 * hz * (1 - 1e-9));
  const rate = holds.length ? Math.min(...holds) : BW16.rate;
  const own = samplerBandwidth(sourceRate);
  return own && rate >= own.rate - 0.01 ? null : rate;
}
