// The memory: samples, and banks of the sampler's 32 programs and its slots, with events for whoever shows or keeps
// them.

import { BANK_PROGRAMS, newBank, newKeygroup, normalizeBank } from './mapping';
import { normalizeSample } from './points';
import type { Rendered } from './render';
import type { Bank, Keygroup, Program, Recipe, Sample, Sound } from './types';

/** A keygroup's settings, without its id and sample */
type KeyRange = Omit<Keygroup, 'id' | 'sampleId'>;

/**
 * samples, programs and keygroups: the lists changed (programs: also the banks, the current bank or program, and the
 * slots). sample: one sample's values changed (its id is passed). audio: one sample's rendered audio changed (its id
 * is passed). program: the current program's values changed. selection: the selected sample or keygroup changed.
 */
export type StoreEvent = 'samples' | 'sample' | 'audio' | 'programs' | 'program' | 'keygroups' | 'selection';
type Listener = (id?: string) => void;

export type SamplePatch = Partial<Omit<Sample, 'id' | 'data' | 'source' | 'sourceRate' | 'recipe' | 'rate'>>;

export class Store {
  samples = new Map<string, Sample>();
  banks: Bank[] = [newBank('BANK 1')];
  bankIndex = 0;
  /** in the current bank, 0-31 */
  programIndex = 0;
  selectedSampleId: string | null = null;
  selectedKeygroupId: string | null = null;
  private listeners = new Map<StoreEvent, Set<Listener>>();

  on(event: StoreEvent, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  private emit(event: StoreEvent, id?: string): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(id);
    }
  }

  get bank(): Bank {
    return this.banks[this.bankIndex];
  }

  /** the current bank's P1-P32 */
  get programs(): Program[] {
    return this.bank.programs;
  }

  get program(): Program {
    return this.programs[this.programIndex];
  }

  get selectedSample(): Sample | null {
    return (this.selectedSampleId && this.samples.get(this.selectedSampleId)) || null;
  }

  get selectedKeygroup(): Keygroup | null {
    return this.program.keygroups.find((k) => k.id === this.selectedKeygroupId) ?? null;
  }

  /** @returns the name, or with a number after it if a sample already has it */
  uniqueSampleName(name: string): string {
    const names = new Set([...this.samples.values()].map((s) => s.name));
    let candidate = name;
    for (let i = 2; names.has(candidate); i++) {
      candidate = `${name} ${i}`;
    }
    return candidate;
  }

  /** Adds a sample and selects it. A program without keygroups gets one for it, so it can be played at once. */
  addSample(sample: Sample): void {
    this.samples.set(sample.id, normalizeSample(sample));
    this.selectedSampleId = sample.id;
    this.emit('samples');
    this.emit('selection');
    if (this.program.keygroups.length === 0) {
      this.addKeygroup(newKeygroup(sample.id));
    }
  }

  /**
   * Adds a sample from the sampler with its keygroups, in the current bank's programs it had on the sampler, by
   * number, and selects it. Without any it is added as addSample adds it.
   *
   * @param keygroups the sample's keygroup in each program, null where it isn't in the program
   */
  addSampleToPrograms(sample: Sample, keygroups: (KeyRange | null)[]): void {
    if (!keygroups.some(Boolean)) {
      this.addSample(sample);
      return;
    }
    this.samples.set(sample.id, normalizeSample(sample));
    this.selectedSampleId = sample.id;
    this.placeInPrograms(sample.id, keygroups);
    this.emitAll();
  }

  /**
   * Adds a sample received from a slot of the sampler, in that slot of the current bank. The bank is then as the
   * sampler is: with the keygroups the sampler sent for the slot (the sample that was in the slot here leaves the
   * bank's programs), or without them, the keygroups the slot's sample had here, now with this one.
   *
   * @param keygroups from the sampler's parameters, null if it didn't send them
   * @param bank the bank the receive began in, the current one if not given
   */
  addSampleToSlot(sample: Sample, slot: number, keygroups: (KeyRange | null)[] | null, bank = this.bank): void {
    const was = bank.slots[slot];
    this.samples.set(sample.id, normalizeSample(sample));
    this.selectedSampleId = sample.id;
    const theirs = was ? bank.programs.flatMap((p) => p.keygroups.filter((k) => k.sampleId === was)) : [];
    if (keygroups) {
      for (const program of bank.programs) {
        program.keygroups = program.keygroups.filter((k) => !was || k.sampleId !== was);
      }
      this.placeInPrograms(sample.id, keygroups, bank);
    } else if (theirs.length) {
      theirs.forEach((k) => {
        k.sampleId = sample.id;
      });
    }
    bank.slots[slot] = sample.id;
    // in no program: in the current one if it is empty, so it can be played, as addSample does
    const program = bank.programs[this.programIndex];
    const placed = bank.programs.some((p) => p.keygroups.some((k) => k.sampleId === sample.id));
    if (!placed && program.keygroups.length === 0) {
      program.keygroups.push(newKeygroup(sample.id));
    }
    this.selectedKeygroupId = this.program.keygroups.find((k) => k.sampleId === sample.id)?.id
      ?? this.selectedKeygroupId;
    this.emitAll();
  }

  /** The sample in a slot of a bank (the current one if not given), as when it is sent there */
  setSlot(slot: number, sampleId: string | null, bank = this.bank): void {
    if (bank.slots[slot] !== sampleId) {
      bank.slots[slot] = sampleId;
      this.emit('programs');
    }
  }

  private placeInPrograms(sampleId: string, keygroups: (KeyRange | null)[], bank = this.bank): void {
    keygroups.slice(0, BANK_PROGRAMS).forEach((k, i) => {
      if (k) {
        const keygroup = newKeygroup(sampleId, k);
        bank.programs[i].keygroups.push(keygroup);
        if (bank === this.bank && i === this.programIndex) {
          this.selectedKeygroupId = keygroup.id;
        }
      }
    });
  }

  private emitAll(): void {
    this.emit('samples');
    this.emit('programs');
    this.emit('keygroups');
    this.emit('program');
    this.emit('selection');
  }

  /**
   * Adds a sample in a program of its own: the current program if it is empty, else the first empty one in the bank,
   * named after it (the current program if none is empty), with one keygroup, and selects both. As the X7000 loads an
   * S612 disk, which has no program data.
   */
  addSampleToOwnProgram(sample: Sample, keygroup: KeyRange): void {
    this.samples.set(sample.id, normalizeSample(sample));
    this.selectedSampleId = sample.id;
    if (this.program.keygroups.length > 0) {
      const empty = this.programs.findIndex((p) => p.keygroups.length === 0);
      if (empty >= 0) {
        this.programIndex = empty;
        this.program.name = sample.name.toUpperCase();
      }
    }
    const added = newKeygroup(sample.id, keygroup);
    this.program.keygroups.push(added);
    this.selectedKeygroupId = added.id;
    this.emitAll();
  }

  updateSample(id: string, patch: SamplePatch): void {
    const sample = this.samples.get(id);
    if (sample) {
      Object.assign(sample, patch);
      this.emit('sample', id);
    }
  }

  /** Changes how a sample is rendered from its original, it is rendered again */
  updateRecipe(id: string, patch: Partial<Recipe>): void {
    const sample = this.samples.get(id);
    if (sample && !sample.fromSampler) {
      Object.assign(sample.recipe, patch);
      this.emit('sample', id);
    }
  }

  /** A sample's newly rendered audio, with its points if a new rate moved them */
  setRendered(id: string, rendered: Rendered): void {
    const sample = this.samples.get(id);
    if (sample) {
      Object.assign(sample, rendered);
      this.emit('audio', id);
    }
  }

  /** Removes a sample, keygroups that played it are left without a sample, and slots that had it empty */
  removeSample(id: string): void {
    const ids = [...this.samples.keys()];
    if (!this.samples.delete(id)) {
      return;
    }
    for (const bank of this.banks) {
      for (const program of bank.programs) {
        for (const keygroup of program.keygroups.filter((k) => k.sampleId === id)) {
          keygroup.sampleId = null;
        }
      }
      bank.slots = bank.slots.map((s) => (s === id ? null : s));
    }
    if (this.selectedSampleId === id) {
      const index = ids.indexOf(id);
      this.selectedSampleId = ids[index + 1] ?? ids[index - 1] ?? null;
    }
    this.emit('samples');
    this.emit('programs');
    this.emit('selection');
  }

  selectSample(id: string | null): void {
    this.selectedSampleId = id;
    this.emit('selection');
  }

  selectKeygroup(id: string | null): void {
    this.selectedKeygroupId = id;
    this.emit('selection');
  }

  /** P1-P32 of the current bank, from 0 */
  selectProgram(index: number): void {
    const i = Math.max(0, Math.min(index, this.programs.length - 1));
    if (i !== this.programIndex) {
      this.programIndex = i;
      this.selectedKeygroupId = this.program.keygroups[0]?.id ?? null;
      this.emit('programs');
      this.emit('selection');
    }
  }

  /** The program with the same number in another bank */
  selectBank(index: number): void {
    const i = Math.max(0, Math.min(index, this.banks.length - 1));
    if (i !== this.bankIndex) {
      this.bankIndex = i;
      this.selectedKeygroupId = this.program.keygroups[0]?.id ?? null;
      this.emit('programs');
      this.emit('selection');
    }
  }

  /** A new bank after the others, empty, and selects it */
  addBank(): Bank {
    const bank = newBank(`BANK ${this.banks.length + 1}`);
    this.banks.push(bank);
    this.bankIndex = this.banks.length - 1;
    this.selectedKeygroupId = null;
    this.emit('programs');
    this.emit('selection');
    return bank;
  }

  /** Removes the current bank, there is always at least one. The samples stay in memory. */
  removeBank(): void {
    this.banks.splice(this.bankIndex, 1);
    if (this.banks.length === 0) {
      this.banks.push(newBank('BANK 1'));
    }
    this.bankIndex = Math.min(this.bankIndex, this.banks.length - 1);
    this.selectedKeygroupId = this.program.keygroups[0]?.id ?? null;
    this.emit('programs');
    this.emit('selection');
  }

  updateBank(patch: Partial<Pick<Bank, 'name'>>): void {
    Object.assign(this.bank, patch);
    this.emit('programs');
  }

  /** Takes the current program's keygroups out, the samples stay in memory */
  clearProgram(): void {
    this.program.keygroups = [];
    this.selectedKeygroupId = null;
    this.emit('keygroups');
    this.emit('program');
    this.emit('selection');
  }

  updateProgram(patch: Partial<Pick<Program, 'name'>>): void {
    Object.assign(this.program, patch);
    this.emit('program');
  }

  /** Changes a sample's OUT and LFO settings */
  updateSound(id: string, patch: Partial<Sound>): void {
    const sample = this.samples.get(id);
    if (sample) {
      Object.assign(sample.sound, patch);
      this.emit('sample', id);
    }
  }

  addKeygroup(keygroup: Keygroup): void {
    this.program.keygroups.push(keygroup);
    this.selectedKeygroupId = keygroup.id;
    this.emit('keygroups');
    this.emit('program');
    this.emit('selection');
  }

  updateKeygroup(id: string, patch: Partial<Omit<Keygroup, 'id'>>): void {
    const keygroup = this.program.keygroups.find((k) => k.id === id);
    if (keygroup) {
      Object.assign(keygroup, patch);
      if (keygroup.low > keygroup.high) {
        [keygroup.low, keygroup.high] = 'low' in patch ? [keygroup.low, keygroup.low] : [keygroup.high, keygroup.high];
      }
      this.emit('program');
    }
  }

  removeKeygroup(id: string): void {
    const keygroups = this.program.keygroups;
    const index = keygroups.findIndex((k) => k.id === id);
    if (index >= 0) {
      keygroups.splice(index, 1);
      if (this.selectedKeygroupId === id) {
        this.selectedKeygroupId = keygroups[Math.min(index, keygroups.length - 1)]?.id ?? null;
      }
      this.emit('keygroups');
      this.emit('program');
      this.emit('selection');
    }
  }

  /** Replaces everything, as when loading a memory file */
  replaceAll(samples: Sample[], banks: Bank[], bankIndex = 0, programIndex = 0): void {
    // samples kept from before start and end points get them
    this.samples = new Map(samples.map((s) => [s.id, normalizeSample(s)]));
    this.banks = banks.length ? banks.map(normalizeBank) : [newBank('BANK 1')];
    this.bankIndex = Math.max(0, Math.min(bankIndex, this.banks.length - 1));
    this.programIndex = Math.max(0, Math.min(programIndex, BANK_PROGRAMS - 1));
    this.selectedSampleId = samples[0]?.id ?? null;
    this.selectedKeygroupId = this.program.keygroups[0]?.id ?? null;
    this.emit('samples');
    this.emit('programs');
    this.emit('selection');
  }

  memoryBytes(): number {
    let bytes = 0;
    for (const s of this.samples.values()) {
      bytes += s.data.byteLength;
    }
    return bytes;
  }
}
