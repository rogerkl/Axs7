import type { Bank, Keygroup, LoopMode, OldBank, OldKeygroup, Program, ProgramName, Sample, Sound } from './types';

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The programs in a bank, as the sampler has: P1-P32 */
export const BANK_PROGRAMS = 32;
/** The slots a bank can have, as many as the sampler can have (16 with a memory expansion) */
export const BANK_SLOTS = 16;

const programName = (i: number) => `PROGRAM ${i + 1}`;

/** A bank with its 32 programs, named PROGRAM 1-32 */
export function newBank(name: string): Bank {
  return { id: newId(), name, programs: Array.from({ length: BANK_PROGRAMS },
    (_, i): ProgramName => ({ id: newId(), name: programName(i) })) };
}

/** A bank as this version has them: its name, 32 programs' names, and SM-87's role and pans if it has them */
export function normalizeBank(b: Partial<Bank> | OldBank): Bank {
  const programs = (b.programs ?? []).slice(0, BANK_PROGRAMS).map((p, i): ProgramName => {
    const pan = (p as Partial<ProgramName> | undefined)?.pan;
    return { id: p?.id ?? newId(), name: p?.name ?? programName(i),
      ...(Number.isInteger(pan) && Math.abs(pan!) <= 3 ? { pan } : {}) };
  });
  while (programs.length < BANK_PROGRAMS) {
    programs.push({ id: newId(), name: programName(programs.length) });
  }
  const role = (b as Partial<Bank>).sm87;
  return { id: b.id ?? newId(), name: b.name ?? 'BANK', programs,
    ...(role === 'drums' || role === 'samples' ? { sm87: role } : {}) };
}

/** By default over the whole keyboard, with the sample's own pitch at C3 like the sampler */
export function newKeygroup(sampleId: string, program: number, init: Partial<Keygroup> = {}): Keygroup {
  return { id: newId(), sampleId, program, low: 0, high: 127, root: 60, semitones: 0, cents: 0, fixedPitch: false,
    ...init };
}

/** A keygroup as this version has them, for a sample (its sampleId is the sample's) */
export function normalizeKeygroup(k: Partial<Keygroup>, sampleId: string): Keygroup | null {
  const program = Number(k.program);
  if (!Number.isInteger(program) || program < 0 || program >= BANK_PROGRAMS) {
    return null;
  }
  const { id, low, high, root, semitones, cents, fixedPitch } = newKeygroup(sampleId, program, k);
  return { id, sampleId, program, low, high, root, semitones, cents, fixedPitch };
}

/** The programs of a bank, each with the keygroups of the bank's samples in it, in slot order */
export function bankPrograms(bank: Bank, samples: Iterable<Sample>): Program[] {
  const mine = [...samples].filter((s) => s.bankId === bank.id).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  return bank.programs.map((p, i) => ({ ...p, keygroups: mine.flatMap((s) => s.keygroups.filter((k) => k.program === i)) }));
}

/**
 * Banks and samples from a version before samples had their bank, slot and keygroups: the banks kept the sample in
 * each slot and the keygroups in their programs. A sample takes the first bank and slot it was in, and the keygroups
 * of that bank that played it. One in programs but in no slot goes in a free slot of the bank. What can't be had (a
 * sample in two banks, keygroups without a sample) is left out, and said in the notes.
 *
 * @param samples set in place: their bankId, slot and keygroups
 */
export function migrateBanks(old: OldBank[], samples: Sample[]): { banks: Bank[]; notes: string[] } {
  const notes: string[] = [];
  const byId = new Map(samples.map((s) => [s.id, s]));
  for (const s of samples) {
    s.bankId = null;
    s.slot = null;
    s.keygroups = [];
  }
  const banks = old.map((b) => normalizeBank(b));
  const taken = new Map(banks.map((b) => [b.id, new Set<number>()]));
  old.forEach((b, i) => {
    const bank = banks[i];
    (b.slots ?? []).forEach((id, slot) => {
      const s = id ? byId.get(id) : undefined;
      if (!s || slot >= BANK_SLOTS) {
        return;
      }
      if (s.bankId === null) {
        s.bankId = bank.id;
        s.slot = slot;
        taken.get(bank.id)!.add(slot);
      } else if (s.bankId !== bank.id) {
        notes.push(`${s.name} was in ${bankName(banks, s.bankId)} and ${bank.name}: a sample is in one bank now, it is `
          + `in ${bankName(banks, s.bankId)}`);
      }
    });
  });
  old.forEach((b, i) => {
    const bank = banks[i];
    (b.programs ?? []).slice(0, BANK_PROGRAMS).forEach((p, program) => {
      for (const k of p?.keygroups ?? []) {
        const s = k.sampleId ? byId.get(k.sampleId) : undefined;
        if (!s) {
          continue;
        }
        if (s.bankId === null) {
          const free = Array.from({ length: BANK_SLOTS }, (_, n) => n).find((n) => !taken.get(bank.id)!.has(n));
          if (free === undefined) {
            notes.push(`${s.name} played in P${program + 1} of ${bank.name}, which has no free slot for it: left out`);
            continue;
          }
          s.bankId = bank.id;
          s.slot = free;
          taken.get(bank.id)!.add(free);
        }
        if (s.bankId !== bank.id) {
          notes.push(`P${program + 1} of ${bank.name} played ${s.name}, which is in ${bankName(banks, s.bankId)}: `
            + 'that keygroup is left out');
          continue;
        }
        const kg = normalizeKeygroup({ ...(k as Partial<OldKeygroup>), sampleId: s.id, program } as Partial<Keygroup>,
          s.id);
        if (kg) {
          s.keygroups.push(kg);
        }
      }
    });
  });
  return { banks, notes: [...new Set(notes)] };
}

const bankName = (banks: Bank[], id: string | null) => banks.find((b) => b.id === id)?.name ?? 'another bank';

/** Banks for the programs of a version before banks: 32 to a bank, in order */
export function banksFromPrograms(programs: OldBank['programs'] & object): OldBank[] {
  const banks: OldBank[] = [];
  for (let i = 0; i === 0 || i < programs.length; i += BANK_PROGRAMS) {
    banks.push({ name: `BANK ${banks.length + 1}`, programs: programs.slice(i, i + BANK_PROGRAMS) });
  }
  return banks;
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

/**
 * The keygroups that play, to listen to some of a program: the soloed ones if any is, else all but the muted ones
 */
export function audibleKeygroups(keygroups: Keygroup[], muted: ReadonlySet<string>, soloed: ReadonlySet<string>)
  : Keygroup[] {
  return keygroups.some((k) => soloed.has(k.id)) ? keygroups.filter((k) => soloed.has(k.id))
    : keygroups.filter((k) => !muted.has(k.id));
}

/**
 * @returns what a note plays in a program: one voice for each keygroup with a sample covering the note, of the
 *   keygroups given (all of the program's if not)
 */
export function voicesFor(program: Program, samples: Map<string, Sample>, note: number,
  keygroups = program.keygroups): VoiceStart[] {
  const voices: VoiceStart[] = [];
  for (const keygroup of keygroups) {
    const sample = keygroup.sampleId ? samples.get(keygroup.sampleId) : undefined;
    if (sample && note >= keygroup.low && note <= keygroup.high) {
      // constant pitch plays every key at the root's pitch
      const semitones = (keygroup.fixedPitch ? 0 : note - keygroup.root) + keygroup.semitones + keygroup.cents / 100;
      voices.push({ keygroup, sample, ratio: 2 ** (semitones / 12), gain: 1 });
    }
  }
  return voices;
}
