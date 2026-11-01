// A sample's four points: START and END mark the part of it that is used (playing starts at START, a one shot ends
// at END, only that part is sent to the sampler), the loop is inside them.

import { defaultSound } from './mapping';
import type { Sample } from './types';

export type PointName = 'start' | 'end' | 'loopStart' | 'loopEnd';
export type Points = Pick<Sample, PointName>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Moves one point and keeps them in order, 0 ≤ start ≤ loopStart < loopEnd ≤ end ≤ length, with at least two
 * samples between start and end and in the loop. START and END push the loop along, the loop stops at them.
 */
export function movePoint(sample: Sample, which: PointName, value: number): Points {
  const len = sample.data.length;
  let { start, end, loopStart, loopEnd } = sample;
  const v = Math.round(value);
  switch (which) {
    case 'start':
      start = clamp(v, 0, Math.max(0, end - 2));
      break;
    case 'end':
      end = clamp(v, Math.min(len, start + 2), len);
      break;
    case 'loopStart':
      loopStart = clamp(v, start, loopEnd - 2);
      break;
    case 'loopEnd':
      loopEnd = clamp(v, loopStart + 2, end);
      break;
  }
  return order({ start, end, loopStart, loopEnd }, len);
}

function order(p: Points, len: number): Points {
  const end = clamp(p.end, 0, len);
  const start = clamp(p.start, 0, end);
  const loopStart = clamp(p.loopStart, start, Math.max(start, end - 2));
  const loopEnd = clamp(p.loopEnd, Math.min(end, loopStart + 2), end);
  return { start, end, loopStart, loopEnd };
}

/** A sample from an older version (without start and end points, or a sound of its own), or with points out of order */
export function normalizeSample(sample: Sample): Sample {
  const len = sample.data.length;
  sample.sound = { ...defaultSound(), ...sample.sound };
  sample.reverse = !!sample.reverse;
  return Object.assign(sample, order({
    start: sample.start ?? 0, end: sample.end ?? len, loopStart: sample.loopStart, loopEnd: sample.loopEnd,
  }, len));
}

/** True if START or END leave part of the sample out */
export function isPortion(sample: Sample): boolean {
  return sample.start > 0 || sample.end < sample.data.length;
}
