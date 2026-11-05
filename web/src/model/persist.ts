// Keeps the memory between visits: the samples in IndexedDB, the banks and each sample's bank, slot and keygroups
// (small) in localStorage. localStorage writes at once, so a keygroup changed just before the page closes isn't lost,
// as an IndexedDB write still running then would be; and the samples' audio isn't written again for it.

import { BANK_PROGRAMS, banksFromPrograms, migrateBanks, normalizeBank } from './mapping';
import { normalizeSample } from './points';
import type { Store } from './store';
import type { Bank, Keygroup, OldBank, Sample } from './types';

const DB_NAME = 'axs7';
const SAMPLES = 'samples';
const META = 'meta';
/** where the programs were kept in IndexedDB before, still read if localStorage has none */
const PROGRAMS_KEY = 'programs';
const PROGRAMS_STORAGE = 'axs7.programs';
/** a copy of banks that couldn't be read, before they are saved over */
const UNREADABLE_STORAGE = 'axs7.programs.unreadable';

export interface Loaded {
  samples: Sample[];
  banks: Bank[];
  bankIndex: number;
  programIndex: number;
  /** what couldn't be read, for the log */
  problems: string[];
}

/** Where a sample is: its bank, slot and keygroups */
interface Place {
  bankId: string | null;
  slot: number | null;
  keygroups: Keygroup[];
}

interface ProgramsRecord {
  /** before `places`, the banks had their slots and the programs' keygroups */
  banks?: (Bank | OldBank)[];
  bankIndex?: number;
  /** before banks, the programs were a list */
  programs?: OldBank['programs'];
  programIndex: number;
  /** the samples' ids in memory order, IndexedDB gives them back by id */
  sampleOrder?: string[];
  /** each sample's bank, slot and keygroups, by id */
  places?: Record<string, Place>;
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

  /**
   * The memory as it was kept. What can't be read is passed over, said in `problems`, and left as it is: a sample
   * stays in IndexedDB (saving doesn't remove it), the banks are copied to UNREADABLE_STORAGE before they would be
   * saved over.
   */
  async load(): Promise<Loaded> {
    const tx = this.db.transaction([SAMPLES, META], 'readonly');
    const stored = await request(tx.objectStore(SAMPLES).getAll() as IDBRequest<Sample[]>);
    const problems: string[] = [];
    const json = localStorage.getItem(PROGRAMS_STORAGE);
    let record: ProgramsRecord | undefined;
    try {
      record = json ? (JSON.parse(json) as ProgramsRecord) : undefined;
    } catch (e) {
      keepUnreadable(json!, `the banks (${errorText(e)})`, problems);
    }
    record ??= await request(tx.objectStore(META).get(PROGRAMS_KEY) as IDBRequest<ProgramsRecord | undefined>);
    const samples: Sample[] = [];
    for (const sample of stored) {
      try {
        if (!(sample?.data instanceof Float32Array)) {
          throw new Error('it has no audio');
        }
        samples.push(normalizeSample(sample));
      } catch (e) {
        problems.push(`Sample ${sample?.name ?? sample?.id ?? '?'} can't be read (${errorText(e)}), it is left as it `
          + 'is in the browser\'s storage');
      }
    }
    // the ones not read aren't removed by syncSamples
    this.saved = new Set(samples.map((s) => s.id));
    const order = new Map((Array.isArray(record?.sampleOrder) ? record.sampleOrder : []).map((id, i) => [id, i]));
    samples.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    const index = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? v as number : 0);
    if (!record) {
      return { samples, banks: [], bankIndex: 0, programIndex: 0, problems };
    }
    try {
      if (record.places && typeof record.places === 'object') {
        for (const sample of samples) {
          const place = record.places[sample.id];
          if (place) {
            Object.assign(sample, { bankId: place.bankId, slot: place.slot, keygroups: place.keygroups });
            normalizeSample(sample);
          }
        }
        return { samples, banks: (record.banks ?? []).map(normalizeBank), bankIndex: index(record.bankIndex),
          programIndex: index(record.programIndex), problems };
      }
      // the banks had the slots and the keygroups; before banks there were 32 programs to a bank
      const programIndex = index(record.programIndex);
      const { banks, notes } = migrateBanks(record.banks ?? banksFromPrograms(record.programs ?? []), samples);
      problems.push(...notes);
      return { samples, banks, ...(record.banks ? { bankIndex: index(record.bankIndex), programIndex }
        : { bankIndex: Math.floor(programIndex / BANK_PROGRAMS), programIndex: programIndex % BANK_PROGRAMS }),
      problems };
    } catch (e) {
      keepUnreadable(json ?? JSON.stringify(record), `the banks (${errorText(e)})`, problems);
      return { samples, banks: [], bankIndex: 0, programIndex: 0, problems };
    }
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
    const places: Record<string, Place> = {};
    for (const s of store.samples.values()) {
      places[s.id] = { bankId: s.bankId, slot: s.slot, keygroups: s.keygroups };
    }
    const record: ProgramsRecord = { banks: store.banks, bankIndex: store.bankIndex, programIndex: store.programIndex,
      sampleOrder: [...store.samples.keys()], places };
    localStorage.setItem(PROGRAMS_STORAGE, JSON.stringify(record));
  }
}

/** Keeps what can't be read where saving won't write over it */
function keepUnreadable(json: string, what: string, problems: string[]): void {
  try {
    localStorage.setItem(UNREADABLE_STORAGE, json);
    problems.push(`Can't read ${what}: started with an empty bank, what was kept is in localStorage as `
      + UNREADABLE_STORAGE);
  } catch {
    problems.push(`Can't read ${what}: started with an empty bank`);
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
