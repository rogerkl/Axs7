// A memory file is the whole memory in a zip file: memory.json with the banks (their programs' names) and each
// sample's settings, bank, slot and keygroups, and each sample as a wav file with its loop, so they can be used in
// other programs too. That is the rendered audio, what plays; a sample with edits has its original in originals/ as
// well, so editing goes on from it. Older files are read too: from before samples had their bank, slot and keygroups
// (the banks had them), and from before banks (bank.json, axs7-bank), their programs 32 to a bank.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { encodeWav, readWav } from '../protocol/wav';
import { wavLoops } from './convert';
import { BANK_PROGRAMS, banksFromPrograms, defaultSound, migrateBanks, normalizeBank } from './mapping';
import { plainRecipe } from './recipe';
import type { Bank, Keygroup, LoopMode, OldBank, Recipe, Sample, Sound } from './types';

export const MEMORY_FORMAT = 'axs7-memory';
/**
 * 5: samples have their bank, slot and keygroups, banks only their programs' names. 4: banks of 32 programs (with the
 * keygroups) and slots. Before that a list of programs (axs7-bank, bank.json).
 */
export const MEMORY_VERSION = 5;
const OLD_FORMAT = 'axs7-bank';
/** 2: samples have their sound, programs only key ranges. 3: samples have their original and recipe. */
const OLD_VERSION = 3;

export interface Memory {
  samples: Sample[];
  banks: Bank[];
  bankIndex: number;
  programIndex: number;
  /** SLOTS when it was saved, how many slots the sampler had; not in files from before */
  slotCount?: number;
  /** what couldn't be had from an older file, for the log */
  notes?: string[];
}

interface SampleEntry {
  id: string;
  name: string;
  /** the rendered audio */
  file: string;
  /** exact, the wav file only has whole Hz */
  rate: number;
  /** the original, if it differs from the rendered audio */
  original?: string;
  sourceRate?: number;
  recipe?: Recipe;
  fromSampler?: boolean;
  /** missing in banks from before start and end points */
  start?: number;
  end?: number;
  loopStart: number;
  loopEnd: number;
  loopMode: LoopMode;
  /** missing in version 1 banks */
  sound?: Sound;
  reverse?: boolean;
  /** from version 5: its bank by id (null for none), slot and keygroups */
  bankId?: string | null;
  slot?: number | null;
  keygroups?: Keygroup[];
}

interface MemoryJson {
  format: string;
  version: number;
  /** SLOTS when it was saved */
  slotCount?: number;
  bankIndex?: number;
  programIndex: number;
  samples: SampleEntry[];
  /** before version 5 with the slots and the programs' keygroups */
  banks?: (Bank | OldBank)[];
  /** before banks */
  programs?: OldBank['programs'];
}

function fileName(dir: string, index: number, name: string): string {
  const safe = name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'sample';
  return `${dir}/${String(index + 1).padStart(3, '0')}-${safe}.wav`;
}

export function memoryToZip(memory: Memory): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const samples = memory.samples.map((s, i): SampleEntry => {
    const meta = s.fromSampler ? { fromSampler: true } : undefined;
    const file = fileName('samples', i, s.name);
    files[file] = encodeWav(s.data, s.rate, wavLoops(s), meta);
    let original: string | undefined;
    if (s.source !== s.data) {
      original = fileName('originals', i, s.name);
      files[original] = encodeWav(s.source, s.sourceRate, [], meta);
    }
    return { id: s.id, name: s.name, file, rate: s.rate, original, sourceRate: s.sourceRate, recipe: s.recipe,
      fromSampler: s.fromSampler, start: s.start, end: s.end, loopStart: s.loopStart, loopEnd: s.loopEnd,
      loopMode: s.loopMode, reverse: s.reverse, sound: s.sound, bankId: s.bankId, slot: s.slot, keygroups: s.keygroups };
  });
  const json: MemoryJson = { format: MEMORY_FORMAT, version: MEMORY_VERSION, slotCount: memory.slotCount,
    bankIndex: memory.bankIndex, programIndex: memory.programIndex, samples, banks: memory.banks };
  files['memory.json'] = strToU8(JSON.stringify(json, null, 2));
  return zipSync(files, { level: 6 });
}

/** @throws Error if it isn't a memory file (or a bank file from before banks) this version can read */
export function zipToMemory(zip: Uint8Array): Memory {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new Error('Not a zip file');
  }
  const file = files['memory.json'] ?? files['bank.json'];
  if (!file) {
    throw new Error('No memory.json in the zip file');
  }
  const json = JSON.parse(strFromU8(file)) as MemoryJson;
  const readable = (json.format === MEMORY_FORMAT && json.version <= MEMORY_VERSION)
    || (json.format === OLD_FORMAT && json.version <= OLD_VERSION);
  if (!readable) {
    throw new Error(`Not a memory file this version can read (${json.format} ${json.version})`);
  }
  const wavFile = (entry: SampleEntry, path: string) => {
    const bytes = files[path];
    const wav = bytes && readWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    if (!wav) {
      throw new Error(`Sample ${entry.name}: ${path} is missing or not a wav file`);
    }
    return wav;
  };
  const samples = json.samples.map((entry): Sample => {
    const wav = wavFile(entry, entry.file);
    const n = wav.data.length;
    const end = Math.min(entry.end ?? n, n);
    const loopEnd = Math.min(entry.loopEnd, end);
    const rate = entry.rate || wav.sampleRate;
    // before version 3 the audio was all there was: it is the original
    const source = entry.original ? wavFile(entry, entry.original).data : wav.data;
    return {
      id: entry.id, name: entry.name, rate, data: wav.data, source, sourceRate: entry.sourceRate ?? rate,
      recipe: { ...plainRecipe(), ...entry.recipe }, fromSampler: !!(entry.fromSampler ?? wav.meta.fromSampler),
      start: Math.min(entry.start ?? 0, end), end, loopStart: Math.min(entry.loopStart, loopEnd), loopEnd,
      loopMode: entry.loopMode, reverse: !!entry.reverse, sound: { ...defaultSound(), ...entry.sound },
      bankId: entry.bankId ?? null, slot: entry.slot ?? null, keygroups: entry.keygroups ?? [],
    };
  });
  const old = json.format === OLD_FORMAT ? json.programIndex ?? 0 : 0;
  const where = { bankIndex: json.bankIndex ?? Math.floor(old / BANK_PROGRAMS),
    programIndex: json.format === OLD_FORMAT ? old % BANK_PROGRAMS : json.programIndex ?? 0,
    ...(Number.isInteger(json.slotCount) && json.slotCount! > 0 ? { slotCount: json.slotCount } : {}) };
  if (json.format === MEMORY_FORMAT && json.version >= 5) {
    return { samples, banks: (json.banks ?? []).map(normalizeBank), ...where };
  }
  // the banks had the slots and the keygroups; version 1 programs had the sound settings, they are left out; before
  // version 4 the programs were a list
  const { banks, notes } = migrateBanks(json.banks ?? banksFromPrograms(json.programs ?? []), samples);
  return { samples, banks, ...where, notes };
}

/**
 * How many slots the sampler needs for a memory: SLOTS when it was saved, at least as many as the highest slot a
 * sample of a bank is in (a file from before SLOTS was saved has only that)
 */
export function slotsUsed(memory: Memory): number {
  return Math.max(memory.slotCount ?? 0, ...memory.samples.map((s) => (s.bankId !== null && s.slot !== null ? s.slot + 1
    : 0)));
}
