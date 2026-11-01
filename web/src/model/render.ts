// Renders a sample from its original by its recipe: resample, normalize, crossfade, attack, 12 bit. The crossfade
// comes before the attack, so it fades into the audio as it was, not into a fade in.

import { crossfadeRoom } from '../audio/dsp';
import type { AttackShape, FadeShape } from '../audio/dsp';
import type { Resampler } from './convert';
import { attackRoom, normalizeData, quantize12Data } from './edit';
import { plainRecipe } from './recipe';
import type { Sample } from './types';

/** The sample edits in Rust (see audio/dsp.ts) */
export interface RenderDsp {
  crossfadeLoop(data: Float32Array, loopStart: number, loopEnd: number, length: number, shape: FadeShape)
    : { data: Float32Array; length: number };
  fadeIn(data: Float32Array, at: number, length: number, shape: AttackShape, backwards: boolean)
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
    data = normalizeData(data, points.start, points.end);
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
  if (r.twelveBit) {
    data = quantize12Data(data);
  }
  return { data, rate, ...points };
}
