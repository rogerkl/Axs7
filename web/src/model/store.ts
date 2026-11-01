// The sampler's memory: samples and programs, with events for whoever shows or keeps them.

import { newKeygroup, newProgram } from './mapping';
import { normalizeSample } from './points';
import type { Envelope, Keygroup, Program, Sample } from './types';

/**
 * samples, programs and keygroups: the lists changed. sample: one sample's values changed (its id is passed).
 * program: the current program's values changed. selection: the selected sample or keygroup changed.
 */
export type StoreEvent = 'samples' | 'sample' | 'programs' | 'program' | 'keygroups' | 'selection';
type Listener = (id?: string) => void;

export type SamplePatch = Partial<Omit<Sample, 'id' | 'data'>>;

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

  updateSample(id: string, patch: SamplePatch): void {
    const sample = this.samples.get(id);
    if (sample) {
      Object.assign(sample, patch);
      this.emit('sample', id);
    }
  }

  /** Replaces a sample's audio, as when resampling it. Keygroups keep playing it. */
  replaceData(id: string, data: Pick<Sample, 'data' | 'rate' | 'start' | 'end' | 'loopStart' | 'loopEnd'>): void {
    const sample = this.samples.get(id);
    if (sample) {
      Object.assign(sample, data);
      this.emit('sample', id);
      this.emit('samples');
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

  updateProgram(patch: Partial<Omit<Program, 'id' | 'keygroups' | 'filterEnv' | 'ampEnv'>>): void {
    Object.assign(this.program, patch);
    this.emit('program');
  }

  updateEnvelope(which: 'filterEnv' | 'ampEnv', patch: Partial<Envelope>): void {
    Object.assign(this.program[which], patch);
    this.emit('program');
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
    this.programs = programs.length ? programs : [newProgram('PROGRAM 1')];
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
