// FIND LOOP: a forward loop inside the current one, smaller, that is heard as little as possible (the search is
// engine/src/loopfind.rs). Each find looks inside the loop the last one found, so a loop that doesn't satisfy is
// followed by a smaller one.

import type { Sample } from './types';

/** A loop found is at most this much of the loop it was looked for in */
export const LOOP_SHRINK = 0.9;
/** The shortest loop looked for, in seconds */
export const MIN_LOOP_S = 0.01;

/** Where to look for a loop, in the sample's samples, or why not */
export type LoopSearch = { lo: number; hi: number; minLen: number; maxLen: number; minEnd: number }
  | { why: 'NOT LOOPED' | 'ALTERNATING' | 'TOO SHORT' };

export function loopSearch(s: Pick<Sample, 'loopMode' | 'loopStart' | 'loopEnd' | 'start' | 'rate'>): LoopSearch {
  if (s.loopMode === 'alternating') {
    return { why: 'ALTERNATING' };
  }
  if (s.loopMode !== 'forward') {
    return { why: 'NOT LOOPED' };
  }
  const maxLen = Math.floor((s.loopEnd - s.loopStart) * LOOP_SHRINK);
  const minLen = Math.max(16, Math.round(MIN_LOOP_S * s.rate));
  if (maxLen < minLen) {
    return { why: 'TOO SHORT' };
  }
  // START in the loop: the loop has to end after it
  return { lo: s.loopStart, hi: s.loopEnd, minLen, maxLen, minEnd: s.start > s.loopStart ? s.start + 2 : 0 };
}
