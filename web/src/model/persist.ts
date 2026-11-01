// Keeps the memory between visits: the samples in IndexedDB, the programs (small) in localStorage. localStorage
// writes at once, so a program edited just before the page closes isn't lost, as an IndexedDB write still running
// then would be.

import type { Store } from './store';
import type { Program, Sample } from './types';

const DB_NAME = 'axs7';
const SAMPLES = 'samples';
const META = 'meta';
/** where the programs were kept in IndexedDB before, still read if localStorage has none */
const PROGRAMS_KEY = 'programs';
const PROGRAMS_STORAGE = 'axs7.programs';

interface ProgramsRecord {
  programs: Program[];
  programIndex: number;
  /** the samples' ids in memory order, IndexedDB gives them back by id */
  sampleOrder?: string[];
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
  private pending = new Map<string, () => Promise<void>>();

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
    const record = readPrograms()
      ?? await request(tx.objectStore(META).get(PROGRAMS_KEY) as IDBRequest<ProgramsRecord | undefined>);
    this.saved = new Set(samples.map((s) => s.id));
    const order = new Map((record?.sampleOrder ?? []).map((id, i) => [id, i]));
    samples.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    return { samples, programs: record?.programs ?? [], programIndex: record?.programIndex ?? 0 };
  }

  /** Saves the store's changes from now on */
  attach(store: Store): void {
    store.on('samples', () => this.syncSamples(store));
    for (const event of ['sample', 'audio'] as const) {
      store.on(event, (id) => id && this.later(`sample:${id}`, () => {
        const sample = store.samples.get(id);
        return sample ? this.putSample(sample) : Promise.resolve();
      }));
    }
    const programs = () => this.later('programs', () => this.putPrograms(store));
    for (const event of ['programs', 'program', 'keygroups', 'samples'] as const) {
      store.on(event, programs);
    }
    // saves waiting for changes to settle would be lost when the page closes
    addEventListener('pagehide', () => this.flush());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && this.flush());
  }

  /** Runs the save after changes have settled, a data knob turn makes many */
  private later(key: string, save: () => Promise<void>): void {
    clearTimeout(this.timers.get(key));
    this.pending.set(key, save);
    this.timers.set(key, setTimeout(() => this.run(key), 400));
  }

  private run(key: string): void {
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    const save = this.pending.get(key);
    this.pending.delete(key);
    save?.().catch(this.onError);
  }

  /** Runs the waiting saves now */
  flush(): void {
    for (const key of [...this.pending.keys()]) {
      this.run(key);
    }
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
    const record: ProgramsRecord = { programs: store.programs, programIndex: store.programIndex,
      sampleOrder: [...store.samples.keys()] };
    localStorage.setItem(PROGRAMS_STORAGE, JSON.stringify(record));
  }
}

function readPrograms(): ProgramsRecord | undefined {
  try {
    const json = localStorage.getItem(PROGRAMS_STORAGE);
    return json ? (JSON.parse(json) as ProgramsRecord) : undefined;
  } catch {
    return undefined;
  }
}
