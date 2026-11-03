import type { Bank, Keygroup, LoopMode, Program, Sample, Sound } from './types';

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function newProgram(name: string): Program {
  return { id: newId(), name, keygroups: [] };
}

/** The programs in a bank, as the sampler has: P1-P32 */
export const BANK_PROGRAMS = 32;
/** The slots a bank keeps, as many as the sampler can have (16 with a memory expansion) */
export const BANK_SLOTS = 16;

const programName = (i: number) => `PROGRAM ${i + 1}`;

/** A bank with its 32 programs empty and no samples in its slots */
export function newBank(name: string): Bank {
  return { id: newId(), name, programs: Array.from({ length: BANK_PROGRAMS }, (_, i) => newProgram(programName(i))),
    slots: new Array<string | null>(BANK_SLOTS).fill(null) };
}

/** A bank as this version has them: its 32 programs, and its slots */
export function normalizeBank(b: Partial<Bank>): Bank {
  const programs = (b.programs ?? []).slice(0, BANK_PROGRAMS).map(normalizeProgram);
  while (programs.length < BANK_PROGRAMS) {
    programs.push(newProgram(programName(programs.length)));
  }
  const slots = Array.from({ length: BANK_SLOTS }, (_, i) => b.slots?.[i] ?? null);
  return { id: b.id ?? newId(), name: b.name ?? 'BANK', programs, slots };
}

/** Banks for the programs of a version before banks: 32 to a bank, in order */
export function banksFromPrograms(programs: Partial<Program>[]): Bank[] {
  const banks: Bank[] = [];
  for (let i = 0; i === 0 || i < programs.length; i += BANK_PROGRAMS) {
    banks.push(normalizeBank({ name: `BANK ${banks.length + 1}`, programs: programs.slice(i, i + BANK_PROGRAMS)
      .map((p) => normalizeProgram(p)) }));
  }
  return banks;
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
