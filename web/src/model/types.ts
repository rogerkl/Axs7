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
  /** how much velocity moves the cutoff, up over 64, down under it */
  velFilter: number;
  /** after key off: for every scan mode but drum trigger (a one shot too, as measured on the X7000) */
  release: number;
  /** how much the note off's velocity changes the release */
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
  /** the bank it is in, by id; null for none, then no program plays it */
  bankId: string | null;
  /**
   * its slot on the sampler, from 0, null for none yet. In a bank no other sample has the same slot: one put there
   * takes it, the other is left in no bank.
   */
  slot: number | null;
  /**
   * its key ranges in the programs of its bank, as the sampler keeps them with the sample. They go with it to
   * another bank, and are kept while it is in none.
   */
  keygroups: Keygroup[];
}

/** A sample's key range in a program of its bank ("P1:S1:L=36:H=96" on the X7000) */
export interface Keygroup {
  id: string;
  /** the sample it plays, whose keygroup it is */
  sampleId: string;
  /** the program, P1-P32 as 0-31 */
  program: number;
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

/** A program as a bank keeps it: its name. Its keygroups are its bank's samples'. */
export interface ProgramName {
  id: string;
  name: string;
}

/** A program with the keygroups of its bank's samples in it, in slot order (see Store.program) */
export interface Program extends ProgramName {
  keygroups: Keygroup[];
}

/**
 * What the sampler holds at once: its 32 programs (BANK_PROGRAMS), P1-P32. Which sample is in each of its slots, and
 * the key ranges, are the samples' (Sample.bankId, slot and keygroups).
 */
export interface Bank {
  id: string;
  name: string;
  /** P1-P32, always BANK_PROGRAMS of them */
  programs: ProgramName[];
}

/** A keygroup of a version before samples had them: in a bank's program, its sample by id */
export interface OldKeygroup extends Omit<Keygroup, 'program' | 'sampleId'> {
  sampleId: string | null;
}

/** A bank of a version before samples had their bank, slot and keygroups */
export interface OldBank {
  id?: string;
  name?: string;
  programs?: { id?: string; name?: string; keygroups?: Partial<OldKeygroup>[] }[];
  /** the sample in each slot, by id */
  slots?: (string | null)[];
}
