// From the 0-99 values the user edits to the physical units the engine works in. The layout matches
// engine/src/params.rs.

import type { Program } from './types';

export const PARAM_COUNT = 16;
const LEVEL = 0;
const VELOCITY = 1;
const CUTOFF = 2;
const RESONANCE = 3;
const ENV_AMOUNT = 4;
const FILTER_ATTACK = 5;
const AMP_ATTACK = 9;

/** 0 → 1 ms, 50 → 1.3 s, 99 → 10 s, most of the range for the shorter times */
export function envTime(v: number): number {
  return 0.001 + 10 * (v / 99) ** 3;
}

/** 20 Hz to 20 kHz, exponentially */
export function cutoffHz(v: number): number {
  return 20 * 1000 ** (v / 99);
}

/** Q from flat (0.707) to a strong peak (20) */
export function resonanceQ(v: number): number {
  return 0.7071 + 19.3 * (v / 99) ** 2;
}

/** -99..99 → -8..8 octaves at full envelope */
export function envOctaves(v: number): number {
  return (v / 99) * 8;
}

/** 0-99 → linear gain */
export function levelGain(v: number): number {
  return (v / 99) ** 2;
}

export function engineParams(p: Program): Float32Array {
  const out = new Float32Array(PARAM_COUNT);
  out[LEVEL] = levelGain(p.level);
  out[VELOCITY] = p.velocity / 99;
  out[CUTOFF] = cutoffHz(p.cutoff);
  out[RESONANCE] = resonanceQ(p.resonance);
  out[ENV_AMOUNT] = envOctaves(p.envAmount);
  for (const [first, env] of [[FILTER_ATTACK, p.filterEnv], [AMP_ATTACK, p.ampEnv]] as const) {
    out[first] = envTime(env.attack);
    out[first + 1] = envTime(env.decay);
    out[first + 2] = env.sustain / 99;
    out[first + 3] = envTime(env.release);
  }
  return out;
}

/** Shown on the LCD for an envelope time */
export function formatTime(v: number): string {
  const t = envTime(v);
  return t < 1 ? `${Math.round(t * 1000)}MS` : `${t.toFixed(t < 10 ? 2 : 1)}S`;
}

export function formatHz(v: number): string {
  const hz = cutoffHz(v);
  return hz < 1000 ? `${Math.round(hz)}HZ` : `${(hz / 1000).toFixed(1)}KHZ`;
}
