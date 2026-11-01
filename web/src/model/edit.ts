// The edits a sample is rendered with: normalize and 12 bit, what sending does, and the room an attack has.

import type { Sample } from './types';

const clamp = (v: number) => Math.max(-1, Math.min(1, v));

/** The highest level between start and end */
export function portionPeak(data: Float32Array, start: number, end: number): number {
  let max = 0;
  for (let i = start; i < end; i++) {
    max = Math.max(max, Math.abs(data[i]));
  }
  return max;
}

/** Scales the data so the part between start and end peaks at full level */
export function normalizeData(data: Float32Array, start: number, end: number): Float32Array {
  const max = portionPeak(data, start, end);
  const gain = max > 0 ? 1 / max : 1;
  return data.map((v) => clamp(v * gain));
}

/** A sample value to the sampler's 12 bit offset binary, as a dump has it (as the Java version scales) */
export function to12BitCode(v: number): number {
  return Math.max(0, Math.min(4095, Math.trunc(v * 2047 + 2048)));
}

/** The values the data has after a trip to the sampler */
export function quantize12Data(data: Float32Array): Float32Array {
  return data.map((v) => (to12BitCode(v) - 2048) / 2048);
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

/** How far into the part that is played an attack has room for: it has to end before the loop starts */
export function attackRoom(s: Pick<Sample, 'start' | 'end' | 'loopStart' | 'loopEnd' | 'loopMode' | 'reverse'>)
  : number {
  const looped = s.loopMode === 'forward' || s.loopMode === 'alternating';
  if (!looped) {
    return s.end - s.start;
  }
  return Math.max(0, s.reverse ? s.end - s.loopEnd : s.loopStart - s.start);
}
