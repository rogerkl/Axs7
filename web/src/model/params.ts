// From a sample's 0-99 values (its OUT and LFO settings, as on the X7000) to the physical units the engine works
// in. The layout matches engine/src/params.rs.

import type { Sound } from './types';

export const PARAM_COUNT = 16;
const LEVEL = 0;
const VEL_LEVEL = 1;
const CUTOFF = 2;
const VEL_FILTER = 3;
const RELEASE = 4;
const VEL_RELEASE = 5;
const LFO_RATE = 6;
const LFO_DEPTH = 7;
const LFO_DELAY = 8;
const PRESSURE_DEPTH = 9;

/** 0-99 → linear gain */
export function levelGain(v: number): number {
  return (v / 99) ** 2;
}

/** 20 Hz to 20 kHz, exponentially */
export function cutoffHz(v: number): number {
  return 20 * 1000 ** (v / 99);
}

/** octaves the cutoff rises at full velocity, up to 6 */
export function velFilterOctaves(v: number): number {
  return (v / 99) * 6;
}

/** 0 stops at once (5 ms against clicks), 50 → 1.3 s, 99 → 10 s, most of the range for the shorter times */
export function releaseTime(v: number): number {
  return 0.005 + 10 * (v / 99) ** 3;
}

/** 0.5 Hz to 20 Hz */
export function lfoRate(v: number): number {
  return 0.5 * 40 ** (v / 99);
}

/** semitones either way, up to one */
export function lfoDepth(v: number): number {
  return (v / 99) ** 2;
}

/** seconds, up to 4 */
export function lfoDelay(v: number): number {
  return 4 * (v / 99) ** 2;
}

export function engineParams(s: Sound): Float32Array {
  const out = new Float32Array(PARAM_COUNT);
  out[LEVEL] = levelGain(s.level);
  out[VEL_LEVEL] = s.velLevel / 99;
  out[CUTOFF] = cutoffHz(s.filter);
  out[VEL_FILTER] = velFilterOctaves(s.velFilter);
  out[RELEASE] = releaseTime(s.release);
  out[VEL_RELEASE] = s.velRelease / 99;
  out[LFO_RATE] = lfoRate(s.lfoSpeed);
  out[LFO_DEPTH] = lfoDepth(s.lfoDepth);
  out[LFO_DELAY] = lfoDelay(s.lfoDelay);
  out[PRESSURE_DEPTH] = lfoDepth(s.pressure); // the same scale as the LFO's depth
  return out;
}

/** Shown on the LCD */
export function formatSeconds(t: number): string {
  return t < 1 ? `${Math.round(t * 1000)}MS` : `${t.toFixed(t < 10 ? 2 : 1)}S`;
}

export function formatHz(hz: number): string {
  return hz < 1000 ? `${hz < 10 ? hz.toFixed(1) : Math.round(hz)}HZ` : `${(hz / 1000).toFixed(1)}KHZ`;
}
