// Keeps the memory in IndexedDB, so samples and programs are there after a reload.

import type { Store } from './store';
import type { Program, Sample } from './types';

const DB_NAME = 'axs7';
const SAMPLES = 'samples';
const META = 'meta';
const PROGRAMS_KEY = 'programs';

interface ProgramsRecord {
  programs: Program[];
  programIndex: number;
}

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class Persistence {
  private saved = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  private constructor(private db: IDBDatabase, private onError: (e: unknown) => void) {}

  static async open(onError: (e: unknown) => void): Promise<Persistence> {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore(SAMPLES, { keyPath: 'id' });
      open.result.createObjectStore(META);
    };
    return new Persistence(await request(open), onError);
  }

  async load(): Promise<{ samples: Sample[]; programs: Program[]; programIndex: number }> {
    const tx = this.db.transaction([SAMPLES, META], 'readonly');
    const samples = await request(tx.objectStore(SAMPLES).getAll() as IDBRequest<Sample[]>);
    const record = await request(tx.objectStore(META).get(PROGRAMS_KEY) as IDBRequest<ProgramsRecord | undefined>);
    this.saved = new Set(samples.map((s) => s.id));
    return { samples, programs: record?.programs ?? [], programIndex: record?.programIndex ?? 0 };
  }

  /** Saves the store's changes from now on */
  attach(store: Store): void {
    store.on('samples', () => this.syncSamples(store));
    store.on('sample', (id) => id && this.later(`sample:${id}`, () => {
      const sample = store.samples.get(id);
      return sample ? this.putSample(sample) : Promise.resolve();
    }));
    const programs = () => this.later('programs', () => this.putPrograms(store));
    for (const event of ['programs', 'program', 'keygroups'] as const) {
      store.on(event, programs);
    }
  }

  /** Runs the save after changes have settled, a data knob turn makes many */
  private later(key: string, save: () => Promise<void>): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key);
      save().catch(this.onError);
    }, 400));
  }

  private async syncSamples(store: Store): Promise<void> {
    try {
      const tx = this.db.transaction(SAMPLES, 'readwrite');
      const os = tx.objectStore(SAMPLES);
      for (const id of this.saved) {
        if (!store.samples.has(id)) {
          os.delete(id);
        }
      }
      for (const sample of store.samples.values()) {
        if (!this.saved.has(sample.id)) {
          os.put(sample);
        }
      }
      await done(tx);
      this.saved = new Set(store.samples.keys());
    } catch (e) {
      this.onError(e);
    }
  }

  private async putSample(sample: Sample): Promise<void> {
    const tx = this.db.transaction(SAMPLES, 'readwrite');
    tx.objectStore(SAMPLES).put(sample);
    await done(tx);
  }

  private async putPrograms(store: Store): Promise<void> {
    const tx = this.db.transaction(META, 'readwrite');
    const record: ProgramsRecord = { programs: store.programs, programIndex: store.programIndex };
    tx.objectStore(META).put(record, PROGRAMS_KEY);
    await done(tx);
  }
}
