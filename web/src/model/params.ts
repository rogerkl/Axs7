// From a sample's 0-99 values (its OUT and LFO settings, as on the X7000) to the physical units the engine works
// in. The layout matches engine/src/params.rs. The curves are measured on an X7000 (tools/x7000-lab, and
// doc/x7000-measurements.md).

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
const CUTOFF_MIN = 10;
const CUTOFF_MAX = 11;
const RELEASE_MIN = 12;
const RELEASE_MAX_AT = 13;

/** LEVEL in dB: 0 at 99, 0.345 dB less a step, -34.2 dB at 0 (not silent) */
export function levelDb(v: number): number {
  return -34.2 * (1 - v / 99);
}

export function levelGain(v: number): number {
  return 10 ** (levelDb(v) / 20);
}

/** How many dB VEL>LEVEL puts between the softest and the hardest note: 40 at 99 */
export function velLevelRange(v: number): number {
  return (40.3 * v) / 99;
}

/** FILTER steps for an octave of cutoff */
const FILTER_OCTAVE = 17.29;

/** FILTER: the cutoff of the 6-pole lowpass, from 306 Hz at 0 to 16.2 kHz at 99, an octave every 17.3 */
export function cutoffHz(v: number): number {
  return 306 * 2 ** (v / FILTER_OCTAVE);
}

/**
 * VEL>FILTER: the octaves the cutoff moves from velocity 64 to 0 (down) or to 128 (up). On the sampler it moves
 * VEL>FILTER × (velocity - 64) / 64 FILTER steps, within FILTER 0-99.
 */
export function velFilterOctaves(v: number): number {
  return v / FILTER_OCTAVE;
}

/**
 * RELEASE: seconds to fall 60 dB (exponentially) after key off. As measured, 22.8 s over a whole number that halves
 * every 10 steps and falls in a straight line between, at least 2: 17 ms at 0, 0.57 s at 50, 4.6 s at 80, 11.4 s
 * from 90.
 */
export function releaseTime(v: number): number {
  const r = Math.max(0, Math.min(99, Math.round(v)));
  const tenth = 40 * 2 ** ((50 - 10 * Math.floor(r / 10)) / 10);
  return 22.8 / Math.max(2, Math.floor(tenth * (1 - (r % 10) / 20)));
}

/** The longest release */
export const RELEASE_MAX = releaseTime(99);

/** VEL>RELEASE: the doublings of the release from note off velocity 64 to 0, or halvings to 128 */
export function velReleaseDoublings(v: number): number {
  return v / 10;
}

/** SPEED: Hz, in a straight line from 1.7 at 1 to 7.9 at 99 (4 % faster for a sample played well under its rate); 0
 * stops the LFO */
export function lfoRate(v: number): number {
  return v <= 0 ? 0 : 1.65 + 0.0634 * v;
}

/**
 * The vibrato comes in 8 depths, 6.4 cents apart: none, then ±9 to ±47 cents. DEPTH picks one, and so do channel
 * aftertouch and the modulation wheel (by sixteenths of their range at PRESSURE 99).
 */
export function vibratoStep(step: number): number {
  return step <= 0 ? 0 : (2.7 + 6.4 * Math.min(7, step)) / 100;
}

/** DEPTH's step: none to 12, ±9 cents from 13, ±47 from 89 */
export function lfoDepthStep(v: number): number {
  return Math.max(0, Math.min(7, Math.floor((8 * v) / 101)));
}

/** DEPTH: semitones either way */
export function lfoDepth(v: number): number {
  return vibratoStep(lfoDepthStep(v));
}

/** DELAY: seconds between the depth's steps as the vibrato comes in, 2.35 / (100 - DELAY): 24 ms at 0, 2.35 s at 99 */
export function lfoDelay(v: number): number {
  return 2.35 / (100 - Math.max(0, Math.min(99, v)));
}

/** PRESSURE (the sens): the steps full channel aftertouch gives, 7 at 99 */
export function pressureSteps(v: number): number {
  return Math.floor((7 * Math.max(0, Math.min(99, v))) / 99);
}

export function engineParams(s: Sound): Float32Array {
  const out = new Float32Array(PARAM_COUNT);
  out[LEVEL] = levelGain(s.level);
  out[VEL_LEVEL] = s.velLevel / 99;
  out[CUTOFF] = cutoffHz(s.filter);
  out[VEL_FILTER] = velFilterOctaves(s.velFilter);
  out[RELEASE] = releaseTime(s.release);
  out[VEL_RELEASE] = velReleaseDoublings(s.velRelease);
  out[LFO_RATE] = lfoRate(s.lfoSpeed);
  out[LFO_DEPTH] = lfoDepthStep(s.lfoDepth); // in steps, as the engine brings it in a step at a time
  out[LFO_DELAY] = lfoDelay(s.lfoDelay);
  out[PRESSURE_DEPTH] = s.pressure / 99;
  out[CUTOFF_MIN] = cutoffHz(0);
  out[CUTOFF_MAX] = cutoffHz(99);
  out[RELEASE_MIN] = releaseTime(0);
  out[RELEASE_MAX_AT] = RELEASE_MAX;
  return out;
}

/** Shown on the LCD */
export function formatSeconds(t: number): string {
  return t < 1 ? `${Math.round(t * 1000)}MS` : `${t.toFixed(t < 10 ? 2 : 1)}S`;
}

export function formatHz(hz: number): string {
  return hz < 1000 ? `${hz < 10 ? hz.toFixed(1) : Math.round(hz)}HZ` : `${(hz / 1000).toFixed(1)}KHZ`;
}
