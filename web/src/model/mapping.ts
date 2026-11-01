import type { Keygroup, LoopMode, Program, Sample, Sound } from './types';

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function newProgram(name: string): Program {
  return { id: newId(), name, keygroups: [] };
}

/** By default over the whole keyboard, with the sample's own pitch at C3 like the sampler */
export function newKeygroup(sampleId: string | null, init: Partial<Keygroup> = {}): Keygroup {
  return { id: newId(), sampleId, low: 0, high: 127, root: 60, semitones: 0, cents: 0, fixedPitch: false, ...init };
}

/** A program as this version has them, from storage or a bank of an older version (sound settings were the program's) */
export function normalizeProgram(p: Partial<Program>): Program {
  return {
    id: p.id ?? newId(),
    name: p.name ?? 'PROGRAM',
    keygroups: (p.keygroups ?? []).map((k) => {
      const { id, sampleId, low, high, root, semitones, cents, fixedPitch } = newKeygroup(k.sampleId ?? null, k);
      return { id, sampleId, low, high, root, semitones, cents, fixedPitch };
    }),
  };
}

/** A new sample's sound: a little below full level, filter open, a short release, no vibrato */
export function defaultSound(): Sound {
  return { level: 80, velLevel: 50, filter: 99, velFilter: 0, release: 30, velRelease: 0, lfoSpeed: 60, lfoDepth: 0,
    lfoDelay: 0, pressure: 0 };
}

export const LOOP_MODE_CODE: Record<LoopMode, number> = { off: 0, forward: 1, alternating: 2, drum: 3 };

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
      // constant pitch plays every key at the root's pitch
      const semitones = (keygroup.fixedPitch ? 0 : note - keygroup.root) + keygroup.semitones + keygroup.cents / 100;
      voices.push({ keygroup, sample, ratio: 2 ** (semitones / 12), gain: 1 });
    }
  }
  return voices;
}
