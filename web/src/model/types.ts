/** The X7000's scan modes: one shot (stops at key off), looping, alternating, drum trigger (plays to its end) */
export type LoopMode = 'off' | 'forward' | 'alternating' | 'drum';

export function isLooped(mode: LoopMode): boolean {
  return mode === 'forward' || mode === 'alternating';
}

/**
 * A sample's sound, its OUT and LFO settings, 0-99 as on the X7000. They belong to the sample, not the program, and
 * aren't part of a sample dump, so they stay here.
 */
export interface Sound {
  level: number;
  velLevel: number;
  /** lowpass cutoff, no resonance */
  filter: number;
  /** how much velocity raises the cutoff */
  velFilter: number;
  /** for looping and alternating samples */
  release: number;
  velRelease: number;
  lfoSpeed: number;
  lfoDepth: number;
  lfoDelay: number;
  /** vibrato depth from MIDI aftertouch, the X7000's pressure sens */
  pressure: number;
}

/**
 * How a sample is rendered from its original. Edits are settings, the original is never changed: a change renders
 * the sample again from it, in the order resample, normalize, crossfade, attack, 12 bit.
 */
export interface Recipe {
  /** the rate to resample to, null keeps the original's */
  resampleTo: number | null;
  /** the part between START and END to full level */
  normalize: boolean;
  /** the values the sampler keeps */
  twelveBit: boolean;
  /** a fade in of what is played first, the X7000 has no attack: ms, 0 for none */
  attackMs: number;
  attackShape: 'linear' | 'curve';
  /** a forward loop's end faded into what comes before its start: ms, 0 for none */
  crossfadeMs: number;
  crossfadeShape: 'linear' | 'equal';
}

export interface Sample {
  id: string;
  name: string;
  /** the audio as loaded or received, never changed */
  source: Float32Array;
  sourceRate: number;
  recipe: Recipe;
  /** received from the sampler: sent back as it came, so its recipe isn't applied. Kept in its wav files too. */
  fromSampler: boolean;
  /** the rate of `data` */
  rate: number;
  /** rendered from the original by the recipe, mono, -1..1: what plays and is sent. The points are in its samples. */
  data: Float32Array;
  /** where playing starts, the part from here to END is what is used and sent to the sampler */
  start: number;
  /** after the last sample used */
  end: number;
  loopStart: number;
  /** after the last sample in the loop */
  loopEnd: number;
  loopMode: LoopMode;
  /** plays from END back to START, the loop mirrored, the X7000's SCAN DIRECTION R */
  reverse: boolean;
  sound: Sound;
}

/** A sample mapped to a key range of a program ("P1:S1:L=36:H=96" on the X7000) */
export interface Keygroup {
  id: string;
  sampleId: string | null;
  /** MIDI notes, C3 = 60 as on the sampler */
  low: number;
  high: number;
  /** the note the sample plays at its own pitch */
  root: number;
  semitones: number;
  cents: number;
  /** every key plays the same pitch, the X7000's CONSTANT PITCH */
  fixedPitch: boolean;
}

/** Key ranges for samples, like an X7000 program. The sound is the samples'. */
export interface Program {
  id: string;
  name: string;
  keygroups: Keygroup[];
}
