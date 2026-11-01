import { levelGain } from './params';
import type { Keygroup, LoopMode, Program, Sample } from './types';

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function newProgram(name: string): Program {
  return {
    id: newId(),
    name,
    keygroups: [],
    level: 80,
    velocity: 50,
    cutoff: 99,
    resonance: 0,
    envAmount: 0,
    filterEnv: { attack: 0, decay: 50, sustain: 99, release: 30 },
    ampEnv: { attack: 0, decay: 50, sustain: 99, release: 30 },
  };
}

/** By default over the whole keyboard, with the sample's own pitch at C3 like the sampler */
export function newKeygroup(sampleId: string | null, init: Partial<Keygroup> = {}): Keygroup {
  return { id: newId(), sampleId, low: 0, high: 127, root: 60, semitones: 0, cents: 0, level: 99, ...init };
}

export const LOOP_MODE_CODE: Record<LoopMode, number> = { off: 0, forward: 1, alternating: 2 };

export interface VoiceStart {
  keygroup: Keygroup;
  sample: Sample;
  /** pitch ratio relative to the sample's own pitch */
  ratio: number;
  gain: number;
}

/** @returns what a note plays in a program: one voice for each keygroup with a sample covering the note */
export function voicesFor(program: Program, samples: Map<string, Sample>, note: number): VoiceStart[] {
  const voices: VoiceStart[] = [];
  for (const keygroup of program.keygroups) {
    const sample = keygroup.sampleId ? samples.get(keygroup.sampleId) : undefined;
    if (sample && note >= keygroup.low && note <= keygroup.high) {
      const semitones = note - keygroup.root + keygroup.semitones + keygroup.cents / 100;
      voices.push({ keygroup, sample, ratio: 2 ** (semitones / 12), gain: levelGain(keygroup.level) });
    }
  }
  return voices;
}
