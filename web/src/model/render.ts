// Renders a sample from its original by its recipe: resample, normalize, crossfade, attack, fade out, 12 bit. The
// crossfade comes before the attack, so it fades into the audio as it was, not into a fade in.

import { crossfadeRoom } from '../audio/dsp';
import type { AttackShape, FadeShape } from '../audio/dsp';
import type { Resampler } from './convert';
import { attackRoom, fadeOutRoom, normalizeData, quantize12Data } from './edit';
import { usedStart } from './points';
import { plainRecipe } from './recipe';
import type { Sample } from './types';

/** The sample edits in Rust (see audio/dsp.ts) */
export interface RenderDsp {
  crossfadeLoop(data: Float32Array, loopStart: number, loopEnd: number, length: number, shape: FadeShape)
    : { data: Float32Array; length: number };
  fadeIn(data: Float32Array, at: number, length: number, shape: AttackShape, backwards: boolean)
    : { data: Float32Array; length: number };
  fadeOut(data: Float32Array, last: number, length: number, shape: AttackShape, backwards: boolean)
    : { data: Float32Array; length: number };
}

export interface Rendered {
  data: Float32Array;
  rate: number;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
}

/**
 * Renders the audio that plays and is sent. A sample from the sampler is its original. Without edits the data is
 * the original itself, not a copy.
 *
 * The points are in the samples of the sample's current rate, a new rate moves them to the same places in time.
 */
export async function renderSample(s: Sample, resample: Resampler, dsp: RenderDsp): Promise<Rendered> {
  const r = s.fromSampler ? plainRecipe() : s.recipe;
  const rate = r.resampleTo !== null && Math.abs(r.resampleTo - s.sourceRate) > 0.01 ? r.resampleTo : s.sourceRate;
  let data = rate === s.sourceRate ? s.source : await resample(s.source, s.sourceRate, rate);
  const n = data.length;
  // a point at the very end stays there, rounding could leave it a sample or two short
  const at = (i: number) => (i >= s.data.length ? n : Math.max(0, Math.min(Math.round((i * rate) / s.rate), n)));
  const points = { start: at(s.start), end: at(s.end), loopStart: at(s.loopStart), loopEnd: at(s.loopEnd) };
  const shaped = { ...s, ...points };
  if (r.normalize) {
    // all that plays, a loop before START too
    data = normalizeData(data, usedStart(shaped), points.end);
  }
  if (r.crossfadeMs > 0 && s.loopMode === 'forward') {
    const length = Math.min(crossfadeRoom({ ...shaped, data }), Math.round((r.crossfadeMs / 1000) * rate));
    if (length > 0 && s.reverse) {
      // reversed, the seam is at the loop start: crossfade the sample mirrored, and mirror it back
      data = dsp.crossfadeLoop(data.slice().reverse(), n - points.loopEnd, n - points.loopStart, length,
        r.crossfadeShape).data.reverse();
    } else if (length > 0) {
      data = dsp.crossfadeLoop(data, points.loopStart, points.loopEnd, length, r.crossfadeShape).data;
    }
  }
  if (r.attackMs > 0) {
    const length = Math.min(attackRoom(shaped), Math.round((r.attackMs / 1000) * rate));
    if (length > 0) {
      data = dsp.fadeIn(data, s.reverse ? points.end - 1 : points.start, length, r.attackShape, s.reverse).data;
    }
  }
  if (r.fadeOutMs > 0) {
    // to silence where playing ends: END, or START when reversed
    const length = Math.min(fadeOutRoom(shaped), Math.round((r.fadeOutMs / 1000) * rate));
    if (length > 0) {
      data = dsp.fadeOut(data, s.reverse ? points.start : points.end - 1, length, r.fadeOutShape, s.reverse).data;
    }
  }
  if (r.twelveBit) {
    data = quantize12Data(data);
  }
  return { data, rate, ...points };
}

/** What a sample becomes when its edits are written: its new original, without edits */
export type Written = Pick<Sample, 'source' | 'sourceRate' | 'data' | 'rate' | 'start' | 'end' | 'loopStart' | 'loopEnd'
  | 'recipe'>;

/**
 * The sample as rendered made its original: the edits are in the audio, and only the part that plays is kept, from
 * START (or a loop start before it) to END. The points move with it.
 *
 * @param r the sample rendered as its settings are now
 */
export function writtenEdits(r: Rendered, s: Pick<Sample, 'loopMode'>): Written {
  const from = usedStart({ ...r, loopMode: s.loopMode });
  const data = r.data.slice(from, r.end);
  const at = (x: number) => Math.max(0, Math.min(x - from, data.length));
  return { source: data, sourceRate: r.rate, data, rate: r.rate, start: at(r.start), end: at(r.end),
    loopStart: at(r.loopStart), loopEnd: at(r.loopEnd), recipe: plainRecipe() };
}

/** A sample trimmed: its original and audio, and the points in them */
export type Trimmed = Pick<Sample, 'source' | 'data' | 'start' | 'end' | 'loopStart' | 'loopEnd'>;

/**
 * Why the part of a sample that doesn't play can't be cut off with its edits as they are, null if it can. Resampled,
 * the points aren't in the original's samples; crossfaded, the crossfade takes audio from before the loop, which may
 * be outside the part that plays. APPLY EDITS writes those in and keeps only the part that plays.
 */
export function trimBlocked(s: Sample): 'RESAMPLED' | 'CROSSFADED' | null {
  if (s.fromSampler) {
    return null; // played as it came
  }
  if (Math.abs(s.rate - s.sourceRate) > 0.01) {
    return 'RESAMPLED';
  }
  return s.recipe.crossfadeMs > 0 && s.loopMode === 'forward' ? 'CROSSFADED' : null;
}

/** Samples that don't play: before START (or a loop start before it), and after END */
export function unplayed(s: Pick<Sample, 'data' | 'start' | 'end' | 'loopStart' | 'loopMode'>): { before: number;
  after: number } {
  return { before: usedStart(s), after: Math.max(0, s.data.length - s.end) };
}

/**
 * The sample with only the part that plays, from START (or a loop start before it) to END, of its original and of
 * its audio alike: the rest is let go. Its edits stay and render the same from it (see trimBlocked), and a sample
 * from the sampler plays as it came. Points outside it, a one shot's loop, come inside.
 */
export function trimmed(s: Sample): Trimmed {
  const from = usedStart(s);
  const to = s.end;
  const source = s.source.slice(from, to);
  const data = s.data === s.source ? source : s.data.slice(from, to);
  const at = (x: number) => Math.max(0, Math.min(x - from, to - from));
  return { source, data, start: at(s.start), end: at(s.end), loopStart: at(s.loopStart), loopEnd: at(s.loopEnd) };
}
