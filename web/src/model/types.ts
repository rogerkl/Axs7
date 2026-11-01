export type LoopMode = 'off' | 'forward' | 'alternating';

export interface Sample {
  id: string;
  name: string;
  /** the sample's own rate, kept as loaded or received */
  rate: number;
  /** mono, -1..1 */
  data: Float32Array;
  /** where playing starts, the part from here to END is what is used and sent to the sampler */
  start: number;
  /** after the last sample used */
  end: number;
  loopStart: number;
  /** after the last sample in the loop */
  loopEnd: number;
  loopMode: LoopMode;
}

/** A sample mapped to a key range of a program */
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
  /** 0-99 */
  level: number;
}

/** 0-99 like on the sampler */
export interface Envelope {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/** Parameters are 0-99 like on the sampler, env amount -99..99 */
export interface Program {
  id: string;
  name: string;
  keygroups: Keygroup[];
  level: number;
  velocity: number;
  cutoff: number;
  resonance: number;
  envAmount: number;
  filterEnv: Envelope;
  ampEnv: Envelope;
}
