// The memory: the samples, each in a slot of a bank or in none, with its key ranges in the programs of its bank, and
// the banks (their 32 programs' names), with events for whoever shows or keeps them. As on the sampler, the key ranges
// are the sample's: a bank's program is the keygroups of the samples in the bank.

import { BANK_PROGRAMS, audibleKeygroups, bankPrograms, newBank, newKeygroup, normalizeBank } from './mapping';
import { normalizeSample } from './points';
import { newSm87Banks, sm87Bank } from './sm87';
import { plainRecipe } from './recipe';
import type { Rendered, Trimmed, Written } from './render';
import type { Bank, Keygroup, Program, Recipe, Sample, Sound } from './types';

/** A keygroup's settings, without its id, sample and program */
export type KeyRange = Omit<Keygroup, 'id' | 'sampleId' | 'program'>;

/**
 * samples, programs and keygroups: the lists changed (programs: also the banks, the current bank or program, and
 * which samples are in a bank's slots). sample: one sample's values changed (its id is passed). audio: one sample's
 * rendered audio changed (its id is passed). program: the current program's values changed. selection: the selected
 * sample or keygroup changed.
 */
export type StoreEvent = 'samples' | 'sample' | 'audio' | 'programs' | 'program' | 'keygroups' | 'selection';
type Listener = (id?: string) => void;

export type SamplePatch = Partial<Omit<Sample, 'id' | 'data' | 'source' | 'sourceRate' | 'recipe' | 'rate' | 'bankId'
  | 'slot' | 'keygroups'>>;

export class Store {
  samples = new Map<string, Sample>();
  banks: Bank[] = [newBank('BANK 1')];
  bankIndex = 0;
  /** in the current bank, 0-31 */
  programIndex = 0;
  selectedSampleId: string | null = null;
  selectedKeygroupId: string | null = null;
  /**
   * Keygroups muted and soloed, by id, to listen to some of a program where keygroups overlap. Only for playing here:
   * not kept, saved or sent.
   */
  readonly muted = new Set<string>();
  readonly soloed = new Set<string>();
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

  private emitAll(): void {
    this.emit('samples');
    this.emit('programs');
    this.emit('keygroups');
    this.emit('program');
    this.emit('selection');
  }

  get bank(): Bank {
    return this.banks[this.bankIndex];
  }

  /** A bank's P1-P32, each with the keygroups of the bank's samples in it */
  programsOf(bank: Bank): Program[] {
    return bankPrograms(bank, this.samples.values());
  }

  /** The current bank's P1-P32 */
  get programs(): Program[] {
    return this.programsOf(this.bank);
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

  /** The samples in a bank, in slot order */
  samplesIn(bank: Bank): Sample[] {
    return [...this.samples.values()].filter((s) => s.bankId === bank.id).sort((a, b) => a.slot! - b.slot!);
  }

  /** The sample in a slot of a bank, null if none */
  sampleAt(bank: Bank, slot: number): Sample | null {
    return [...this.samples.values()].find((s) => s.bankId === bank.id && s.slot === slot) ?? null;
  }

  /** The first slot of a bank no sample is in, of `count`; null if all have one */
  freeSlot(bank: Bank, count: number): number | null {
    const taken = new Set(this.samplesIn(bank).map((s) => s.slot));
    for (let slot = 0; slot < count; slot++) {
      if (!taken.has(slot)) {
        return slot;
      }
    }
    return null;
  }

  bankOf(sample: Sample): Bank | null {
    return this.banks.find((b) => b.id === sample.bankId) ?? null;
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

  /**
   * Adds a sample with its keygroups and selects it, in a slot of a bank (see place), or in none (its slot kept). In
   * the current bank, one in no program there is put in the current program if that has no keygroups, so it can be
   * played at once.
   *
   * @returns the sample that was in the slot before, now in no bank; null if none
   */
  addSample(sample: Sample, bank: Bank | null = null, slot: number | null = sample.slot): Sample | null {
    const added = normalizeSample(sample);
    added.bankId = null;
    this.samples.set(added.id, added);
    this.selectedSampleId = added.id;
    const out = bank && slot !== null ? this.putInSlot(added, bank, slot) : null;
    if (!bank) {
      added.slot = slot;
    }
    if (bank === this.bank && added.keygroups.length === 0 && this.program.keygroups.length === 0) {
      added.keygroups.push(newKeygroup(added.id, this.programIndex));
    }
    this.selectedKeygroupId = this.program.keygroups.find((k) => k.sampleId === added.id)?.id
      ?? this.validKeygroup(this.selectedKeygroupId);
    this.emitAll();
    return out;
  }

  /**
   * Puts a sample in a slot of a bank, with its keygroups. A sample already in that slot of the bank is left in no
   * bank, with its keygroups and slot, as on the sampler a slot has one sample. With no bank, the sample is in none
   * and keeps its slot (a slot given is its new one).
   *
   * @returns the sample that was in the slot, now in no bank; null if none
   */
  place(id: string, bank: Bank | null, slot: number | null): Sample | null {
    const sample = this.samples.get(id);
    if (!sample) {
      return null;
    }
    let out: Sample | null = null;
    if (bank && slot !== null) {
      out = this.putInSlot(sample, bank, slot);
    } else {
      sample.bankId = null;
      sample.slot = slot ?? sample.slot;
    }
    this.selectedKeygroupId = this.validKeygroup(this.selectedKeygroupId);
    // the samples are the same: no 'samples'
    this.emit('programs');
    this.emit('keygroups');
    this.emit('program');
    this.emit('selection');
    return out;
  }

  private putInSlot(sample: Sample, bank: Bank, slot: number): Sample | null {
    const was = this.sampleAt(bank, slot);
    if (was && was !== sample) {
      was.bankId = null;
    }
    sample.bankId = bank.id;
    sample.slot = slot;
    return was && was !== sample ? was : null;
  }

  /** Leaves a slot of a bank empty, as when it is empty on the sampler: its sample is in no bank after */
  clearSlot(bank: Bank, slot: number): void {
    const was = this.sampleAt(bank, slot);
    if (was) {
      this.place(was.id, null, null);
    }
  }

  /** The keygroup if it is in the current program, else the program's first; null if it has none */
  private validKeygroup(id: string | null): string | null {
    const keygroups = this.program.keygroups;
    return keygroups.some((k) => k.id === id) ? id : keygroups[0]?.id ?? null;
  }

  /**
   * Adds a sample in a program of its own, in a slot of the current bank: the current program if it has no keygroups,
   * else the first that has none in the bank, named after it (the current program if none is empty), with one
   * keygroup, and selects both. As the X7000 loads an S612 disk, which has no program data.
   */
  addSampleToOwnProgram(sample: Sample, range: Partial<KeyRange>, slot: number | null): void {
    const programs = this.programs;
    if (programs[this.programIndex].keygroups.length > 0) {
      const empty = programs.findIndex((p) => p.keygroups.length === 0);
      if (empty >= 0) {
        this.programIndex = empty;
        this.bank.programs[empty].name = sample.name.toUpperCase();
      }
    }
    sample.keygroups = [newKeygroup(sample.id, this.programIndex, range)];
    this.addSample(sample, slot === null ? null : this.bank, slot);
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

  /** A sample with its edits written: a new original, and audio, without edits (see writtenEdits) */
  replaceOriginal(id: string, written: Written): void {
    const sample = this.samples.get(id);
    if (sample && !sample.fromSampler) {
      Object.assign(sample, written);
      this.emit('sample', id);
      this.emit('audio', id);
    }
  }

  /** A sample with only the part that plays (see trimmed): also one from the sampler */
  trimSample(id: string, t: Trimmed): void {
    const sample = this.samples.get(id);
    if (sample) {
      Object.assign(sample, t);
      this.emit('sample', id);
      this.emit('audio', id);
    }
  }

  /**
   * A sample from the sampler made like a loaded one: its audio can be edited, and it is then sent and saved as
   * edited, no longer as it came
   */
  allowEdits(id: string): void {
    const sample = this.samples.get(id);
    if (sample?.fromSampler) {
      sample.fromSampler = false;
      sample.recipe = plainRecipe();
      this.emit('samples');
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

  /** Removes a sample, with its keygroups */
  removeSample(id: string): void {
    const ids = [...this.samples.keys()];
    const sample = this.samples.get(id);
    if (!sample) {
      return;
    }
    this.samples.delete(id);
    sample.keygroups.forEach((k) => this.forgetKeygroup(k.id));
    if (this.selectedSampleId === id) {
      const index = ids.indexOf(id);
      this.selectedSampleId = ids[index + 1] ?? ids[index - 1] ?? null;
    }
    this.selectedKeygroupId = this.validKeygroup(this.selectedKeygroupId);
    this.emitAll();
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
    const i = Math.max(0, Math.min(index, BANK_PROGRAMS - 1));
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

  /**
   * SM-87's banks (model/sm87.ts), the ones there are none of yet, after the others: DRUMS, its programs the HR-16's
   * drums, and SAMPLES. Selects DRUMS.
   *
   * @returns the banks added
   */
  addSm87Banks(): Bank[] {
    const added = newSm87Banks().filter((b) => !sm87Bank(this.banks, b.sm87!));
    this.banks.push(...added);
    this.bankIndex = this.banks.indexOf(sm87Bank(this.banks, 'drums')!);
    this.programIndex = 0;
    this.selectedKeygroupId = this.program.keygroups[0]?.id ?? null;
    this.emit('programs');
    this.emit('selection');
    return added;
  }

  /**
   * Samples taken from SM-87's firmware package (sm87Taken) into its banks, which there have to be (addSm87Banks):
   * what DRUMS and SAMPLES held is left in no bank, with its keygroups, as when a slot gets another sample; the
   * drums' pans and levels are the package's. A name another sample has gets a number after it.
   */
  takeSm87(samples: Sample[], pans: number[], levels: (number | undefined)[] = []): void {
    const drums = sm87Bank(this.banks, 'drums');
    const mine = sm87Bank(this.banks, 'samples');
    if (!drums || !mine) {
      return;
    }
    for (const s of this.samples.values()) {
      if (s.bankId === drums.id || s.bankId === mine.id) {
        s.bankId = null;
      }
    }
    for (const s of samples) {
      s.name = this.uniqueSampleName(s.name);
      this.samples.set(s.id, normalizeSample(s));
    }
    pans.forEach((pan, i) => {
      drums.programs[i].pan = pan;
    });
    levels.forEach((level, i) => {
      if (level === undefined) {
        delete drums.programs[i].level;
      } else {
        drums.programs[i].level = level;
      }
    });
    this.selectedSampleId = samples[0]?.id ?? this.selectedSampleId;
    this.selectedKeygroupId = this.validKeygroup(this.selectedKeygroupId);
    this.emitAll();
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

  /**
   * Removes the current bank, there is always at least one. Its samples stay in memory, in no bank, with their
   * keygroups.
   */
  removeBank(): void {
    const [removed] = this.banks.splice(this.bankIndex, 1);
    for (const s of this.samples.values()) {
      if (s.bankId === removed.id) {
        s.bankId = null;
      }
    }
    if (this.banks.length === 0) {
      this.banks.push(newBank('BANK 1'));
    }
    this.bankIndex = Math.min(this.bankIndex, this.banks.length - 1);
    this.selectedKeygroupId = this.program.keygroups[0]?.id ?? null;
    this.emitAll();
  }

  updateBank(patch: Partial<Pick<Bank, 'name'>>): void {
    Object.assign(this.bank, patch);
    this.emit('programs');
  }

  /** Takes the current program's keygroups out, of the bank's samples; the samples stay */
  clearProgram(): void {
    for (const s of this.samplesIn(this.bank)) {
      s.keygroups.filter((k) => k.program === this.programIndex).forEach((k) => this.forgetKeygroup(k.id));
      s.keygroups = s.keygroups.filter((k) => k.program !== this.programIndex);
    }
    this.selectedKeygroupId = null;
    this.emit('keygroups');
    this.emit('program');
    this.emit('selection');
  }

  /** Its name, and in SM-87's DRUMS bank the drum's pan and level */
  updateProgram(patch: Partial<Pick<Program, 'name' | 'pan' | 'level'>>): void {
    Object.assign(this.bank.programs[this.programIndex], patch);
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

  /** A keygroup and the sample it is in */
  private findKeygroup(id: string): { sample: Sample; keygroup: Keygroup } | null {
    for (const sample of this.samples.values()) {
      const keygroup = sample.keygroups.find((k) => k.id === id);
      if (keygroup) {
        return { sample, keygroup };
      }
    }
    return null;
  }

  /**
   * Adds a keygroup to its sample, in the current program, and selects it. Only for a sample in the current bank: a
   * program plays its bank's samples.
   *
   * @returns false if its sample isn't in the current bank
   */
  addKeygroup(keygroup: Keygroup): boolean {
    const sample = this.samples.get(keygroup.sampleId);
    if (!sample || sample.bankId !== this.bank.id) {
      return false;
    }
    sample.keygroups.push({ ...keygroup, program: this.programIndex });
    this.selectedKeygroupId = keygroup.id;
    this.emit('keygroups');
    this.emit('program');
    this.emit('selection');
    return true;
  }

  /** Changes a keygroup. A new sample for it has to be in the same bank: the keygroup goes to that sample. */
  updateKeygroup(id: string, patch: Partial<Omit<Keygroup, 'id' | 'program'>>): void {
    const found = this.findKeygroup(id);
    if (!found) {
      return;
    }
    const { sample, keygroup } = found;
    const { sampleId, ...range } = patch;
    Object.assign(keygroup, range);
    if (keygroup.low > keygroup.high) {
      [keygroup.low, keygroup.high] = 'low' in patch ? [keygroup.low, keygroup.low] : [keygroup.high, keygroup.high];
    }
    const to = sampleId && sampleId !== sample.id ? this.samples.get(sampleId) : undefined;
    if (to && to.bankId === sample.bankId) {
      sample.keygroups = sample.keygroups.filter((k) => k !== keygroup);
      keygroup.sampleId = to.id;
      to.keygroups.push(keygroup);
      this.emit('keygroups');
    }
    this.emit('program');
  }

  removeKeygroup(id: string): void {
    const found = this.findKeygroup(id);
    if (!found) {
      return;
    }
    const index = this.program.keygroups.findIndex((k) => k.id === id);
    found.sample.keygroups = found.sample.keygroups.filter((k) => k.id !== id);
    this.forgetKeygroup(id);
    if (this.selectedKeygroupId === id) {
      const keygroups = this.program.keygroups;
      this.selectedKeygroupId = keygroups[Math.min(Math.max(index, 0), keygroups.length - 1)]?.id ?? null;
    }
    this.emit('keygroups');
    this.emit('program');
    this.emit('selection');
  }

  /**
   * Moves a keygroup of the current program to another program of the bank (from 0). It stays its sample's, and a
   * sample plays in its own bank's programs: to another bank the sample goes, with all its keygroups (place).
   *
   * @returns false if there is no such keygroup or program, or it is the current one
   */
  moveKeygroup(id: string, programIndex: number): boolean {
    const keygroup = this.program.keygroups.find((k) => k.id === id);
    if (!keygroup || programIndex === this.programIndex || programIndex < 0 || programIndex >= BANK_PROGRAMS) {
      return false;
    }
    const index = this.program.keygroups.indexOf(keygroup);
    keygroup.program = programIndex;
    this.forgetKeygroup(id);
    if (this.selectedKeygroupId === id) {
      const keygroups = this.program.keygroups;
      this.selectedKeygroupId = keygroups[Math.min(index, keygroups.length - 1)]?.id ?? null;
    }
    this.emit('programs');
    this.emit('keygroups');
    this.emit('program');
    this.emit('selection');
    return true;
  }

  /** The current program's keygroups that play: the soloed ones if any is, else all but the muted ones */
  get audibleKeygroups(): Keygroup[] {
    return audibleKeygroups(this.program.keygroups, this.muted, this.soloed);
  }

  toggleMute(id: string): void {
    this.toggle(this.muted, id);
  }

  toggleSolo(id: string): void {
    this.toggle(this.soloed, id);
  }

  private toggle(set: Set<string>, id: string): void {
    if (!set.delete(id)) {
      set.add(id);
    }
    this.emit('keygroups');
    this.emit('program');
  }

  /** A keygroup that leaves its program isn't muted or soloed any more */
  private forgetKeygroup(id: string): void {
    this.muted.delete(id);
    this.soloed.delete(id);
  }

  /**
   * Replaces everything, as when loading a memory file. A sample in a bank that isn't there, or in a slot another
   * sample of its bank is in already, is left in no bank.
   */
  replaceAll(samples: Sample[], banks: Bank[], bankIndex = 0, programIndex = 0): void {
    this.muted.clear();
    this.soloed.clear();
    // samples kept from before start and end points get them
    this.samples = new Map(samples.map((s) => [s.id, normalizeSample(s)]));
    this.banks = banks.length ? banks.map(normalizeBank) : [newBank('BANK 1')];
    const taken = new Set<string>();
    for (const s of this.samples.values()) {
      const where = `${s.bankId}:${s.slot}`;
      if (s.bankId !== null && (!this.banks.some((b) => b.id === s.bankId) || taken.has(where))) {
        s.bankId = null;
      } else if (s.bankId !== null) {
        taken.add(where);
      }
    }
    this.bankIndex = Math.max(0, Math.min(bankIndex, this.banks.length - 1));
    this.programIndex = Math.max(0, Math.min(programIndex, BANK_PROGRAMS - 1));
    this.selectedSampleId = samples[0]?.id ?? null;
    this.selectedKeygroupId = this.program.keygroups[0]?.id ?? null;
    this.emitAll();
  }

  memoryBytes(): number {
    let bytes = 0;
    for (const s of this.samples.values()) {
      bytes += s.data.byteLength;
    }
    return bytes;
  }
}
