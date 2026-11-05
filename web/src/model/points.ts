// A sample's four points: playing starts at START, a one shot ends at END, the loop ends at END at the latest. As on
// the X7000, START may be inside the loop or the loop may start before it: a sample can play its end once, then loop
// back to a loop start far before it.

import { defaultSound, normalizeKeygroup } from './mapping';
import { plainRecipe } from './recipe';
import { isLooped } from './types';
import type { Sample } from './types';

export type PointName = 'start' | 'end' | 'loopStart' | 'loopEnd';
export type Points = Pick<Sample, PointName>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Moves one point and keeps them in order: 0 ≤ start < end ≤ length, 0 ≤ loopStart < loopEnd ≤ end, and start
 * before loopEnd, at least two samples apart each. The loop start may be before START. END pushes the loop back,
 * START pushes the loop end along when it passes it; the loop end stops at START.
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
      loopStart = clamp(v, 0, loopEnd - 2);
      break;
    case 'loopEnd':
      loopEnd = clamp(v, Math.max(loopStart, start) + 2, end);
      break;
  }
  return order({ start, end, loopStart, loopEnd }, len);
}

function order(p: Points, len: number): Points {
  const end = clamp(p.end, 0, len);
  const start = clamp(p.start, 0, Math.max(0, end - 2));
  const loopEnd = clamp(p.loopEnd, Math.min(end, start + 2), end);
  const loopStart = clamp(p.loopStart, 0, Math.max(0, loopEnd - 2));
  return { start, end, loopStart, loopEnd };
}

/**
 * Where the part of the sample that plays begins: START, or the loop start when a loop goes back before START. It
 * is what is sent to the sampler, normalized and checked.
 */
export function usedStart(s: Pick<Sample, 'start' | 'loopStart' | 'loopMode'>): number {
  return isLooped(s.loopMode) ? Math.min(s.start, s.loopStart) : s.start;
}

/** A sample from an older version (without start and end points, or a sound of its own), or with points out of order */
export function normalizeSample(sample: Sample): Sample {
  const len = sample.data.length;
  sample.sound = { ...defaultSound(), ...sample.sound };
  sample.reverse = !!sample.reverse;
  // from before the original was kept: what it has is its original
  sample.source ??= sample.data;
  sample.sourceRate ??= sample.rate;
  sample.recipe = { ...plainRecipe(), ...sample.recipe };
  sample.fromSampler = !!sample.fromSampler;
  // from before samples had their bank, slot and keygroups
  sample.bankId = typeof sample.bankId === 'string' ? sample.bankId : null;
  sample.slot = Number.isInteger(sample.slot) && (sample.slot as number) >= 0 ? sample.slot : null;
  sample.keygroups = (Array.isArray(sample.keygroups) ? sample.keygroups : [])
    .flatMap((k) => normalizeKeygroup(k, sample.id) ?? []);
  if (sample.slot === null) {
    sample.bankId = null;
  }
  return Object.assign(sample, order({
    start: sample.start ?? 0, end: sample.end ?? len, loopStart: sample.loopStart, loopEnd: sample.loopEnd,
  }, len));
}

/** True if START or END leave part of the sample out */
export function isPortion(sample: Sample): boolean {
  return sample.start > 0 || sample.end < sample.data.length;
}
