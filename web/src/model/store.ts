// The sampler's memory: samples and programs, with events for whoever shows or keeps them.

import { newKeygroup, newProgram, normalizeProgram } from './mapping';
import { normalizeSample } from './points';
import type { Rendered } from './render';
import type { Keygroup, Program, Recipe, Sample, Sound } from './types';

/**
 * samples, programs and keygroups: the lists changed. sample: one sample's values changed (its id is passed).
 * audio: one sample's rendered audio changed (its id is passed).
 * program: the current program's values changed. selection: the selected sample or keygroup changed.
 */
export type StoreEvent = 'samples' | 'sample' | 'audio' | 'programs' | 'program' | 'keygroups' | 'selection';
type Listener = (id?: string) => void;

export type SamplePatch = Partial<Omit<Sample, 'id' | 'data' | 'source' | 'sourceRate' | 'recipe' | 'rate'>>;

export class Store {
  samples = new Map<string, Sample>();
  programs: Program[] = [newProgram('PROGRAM 1')];
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
   * Adds a sample from the sampler's disk with its keygroups, in the programs it had on the sampler, by number (made
   * as needed), and selects it. Without any it is added as addSample adds it.
   *
   * @param keygroups the sample's keygroup in each program, null where it isn't in the program
   */
  addSampleToPrograms(sample: Sample, keygroups: (Omit<Keygroup, 'id' | 'sampleId'> | null)[]): void {
    if (!keygroups.some(Boolean)) {
      this.addSample(sample);
      return;
    }
    this.samples.set(sample.id, normalizeSample(sample));
    this.selectedSampleId = sample.id;
    keygroups.forEach((k, i) => {
      if (k) {
        while (this.programs.length <= i) {
          this.programs.push(newProgram(`PROGRAM ${this.programs.length + 1}`));
        }
        const keygroup = newKeygroup(sample.id, k);
        this.programs[i].keygroups.push(keygroup);
        if (i === this.programIndex) {
          this.selectedKeygroupId = keygroup.id;
        }
      }
    });
    this.emit('samples');
    this.emit('programs');
    this.emit('keygroups');
    this.emit('program');
    this.emit('selection');
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

  /** Removes a sample, keygroups that played it are left without a sample */
  removeSample(id: string): void {
    const ids = [...this.samples.keys()];
    if (!this.samples.delete(id)) {
      return;
    }
    for (const program of this.programs) {
      for (const keygroup of program.keygroups.filter((k) => k.sampleId === id)) {
        keygroup.sampleId = null;
      }
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

  selectProgram(index: number): void {
    const i = Math.max(0, Math.min(index, this.programs.length - 1));
    if (i !== this.programIndex) {
      this.programIndex = i;
      this.selectedKeygroupId = this.program.keygroups[0]?.id ?? null;
      this.emit('programs');
      this.emit('selection');
    }
  }

  addProgram(): Program {
    const program = newProgram(`PROGRAM ${this.programs.length + 1}`);
    this.programs.push(program);
    this.programIndex = this.programs.length - 1;
    this.selectedKeygroupId = null;
    this.emit('programs');
    this.emit('selection');
    return program;
  }

  /** Removes the current program, there is always at least one */
  removeProgram(): void {
    this.programs.splice(this.programIndex, 1);
    if (this.programs.length === 0) {
      this.programs.push(newProgram('PROGRAM 1'));
    }
    this.programIndex = Math.min(this.programIndex, this.programs.length - 1);
    this.selectedKeygroupId = this.program.keygroups[0]?.id ?? null;
    this.emit('programs');
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

  /** Replaces everything, as when loading a bank */
  replaceAll(samples: Sample[], programs: Program[], programIndex = 0): void {
    // samples kept from before start and end points get them
    this.samples = new Map(samples.map((s) => [s.id, normalizeSample(s)]));
    this.programs = programs.length ? programs.map(normalizeProgram) : [newProgram('PROGRAM 1')];
    this.programIndex = Math.max(0, Math.min(programIndex, this.programs.length - 1));
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
