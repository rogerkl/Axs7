// Edits that make a sample what the sampler will get, so it can be heard and edited that way: normalized like
// sending normalizes it, and in the 12 bits the sampler keeps.

import type { SampleData } from './convert';
import { sampleData } from './convert';
import type { Sample } from './types';

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** The highest level between START and END, the part that is sent */
export function portionPeak(sample: Sample): number {
  let max = 0;
  for (let i = sample.start; i < sample.end; i++) {
    max = Math.max(max, Math.abs(sample.data[i]));
  }
  return max;
}

/** Scales the sample so the part between START and END peaks at full level, as sending with NORMALIZE does */
export function normalizeLevel(sample: Sample): SampleData {
  const max = portionPeak(sample);
  const gain = max > 0 ? 1 / max : 1;
  return { ...sampleData(sample), data: sample.data.map((v) => clamp(v * gain)) };
}

/** A sample value to the sampler's 12 bit offset binary, as a dump has it (as the Java version scales) */
export function to12BitCode(v: number): number {
  return Math.max(0, Math.min(4095, Math.trunc(v * 2047 + 2048)));
}

/** Makes the sample 12 bit, the values it has after a trip to the sampler */
export function quantize12(sample: Sample): SampleData {
  return { ...sampleData(sample), data: sample.data.map((v) => (to12BitCode(v) - 2048) / 2048) };
}

/**
 * True if every value is one of the sampler's 12 bit values: made 12 bit, or received from it. Such a sample is
 * sent as it is.
 */
export function isTwelveBit(data: Float32Array): boolean {
  for (let i = 0; i < data.length; i++) {
    const c = data[i] * 2048;
    if (Math.abs(c - Math.round(c)) > 1e-3 || c < -2048 || c > 2047) {
      return false;
    }
  }
  return data.length > 0;
}

/** How far into the part that is played the attack has room for: it has to end before the loop starts */
export function attackRoom(s: Pick<Sample, 'start' | 'end' | 'loopStart' | 'loopEnd' | 'loopMode' | 'reverse'>)
  : number {
  const looped = s.loopMode === 'forward' || s.loopMode === 'alternating';
  if (!looped) {
    return s.end - s.start;
  }
  return Math.max(0, s.reverse ? s.end - s.loopEnd : s.loopStart - s.start);
}
