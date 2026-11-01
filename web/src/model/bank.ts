// A bank is the whole memory in a zip file: bank.json with the programs and sample settings, and each sample as a
// wav file with its loop, so they can be used in other programs too.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { encodeWav, readWav } from '../protocol/wav';
import { wavLoops } from './convert';
import { newKeygroup, newProgram } from './mapping';
import type { LoopMode, Program, Sample } from './types';

export const BANK_FORMAT = 'axs7-bank';
export const BANK_VERSION = 1;

export interface Bank {
  samples: Sample[];
  programs: Program[];
  programIndex: number;
}

interface SampleEntry {
  id: string;
  name: string;
  file: string;
  /** exact, the wav file only has whole Hz */
  rate: number;
  loopStart: number;
  loopEnd: number;
  loopMode: LoopMode;
}

interface BankJson {
  format: string;
  version: number;
  programIndex: number;
  samples: SampleEntry[];
  programs: Program[];
}

function fileName(index: number, name: string): string {
  const safe = name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'sample';
  return `samples/${String(index + 1).padStart(3, '0')}-${safe}.wav`;
}

export function bankToZip(bank: Bank): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const samples = bank.samples.map((s, i): SampleEntry => {
    const file = fileName(i, s.name);
    files[file] = encodeWav(s.data, s.rate, wavLoops(s));
    return { id: s.id, name: s.name, file, rate: s.rate, loopStart: s.loopStart, loopEnd: s.loopEnd,
      loopMode: s.loopMode };
  });
  const json: BankJson = { format: BANK_FORMAT, version: BANK_VERSION, programIndex: bank.programIndex, samples,
    programs: bank.programs };
  files['bank.json'] = strToU8(JSON.stringify(json, null, 2));
  return zipSync(files, { level: 6 });
}

/** @throws Error if it isn't a bank this version can read */
export function zipToBank(zip: Uint8Array): Bank {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch {
    throw new Error('Not a zip file');
  }
  if (!files['bank.json']) {
    throw new Error('No bank.json in the zip file');
  }
  const json = JSON.parse(strFromU8(files['bank.json'])) as BankJson;
  if (json.format !== BANK_FORMAT || !(json.version <= BANK_VERSION)) {
    throw new Error(`Not a bank this version can read (${json.format} ${json.version})`);
  }
  const samples = json.samples.map((entry): Sample => {
    const bytes = files[entry.file];
    const wav = bytes && readWav(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    if (!wav) {
      throw new Error(`Sample ${entry.name}: ${entry.file} is missing or not a wav file`);
    }
    const n = wav.data.length;
    const loopEnd = Math.min(entry.loopEnd, n);
    return { id: entry.id, name: entry.name, rate: entry.rate || wav.sampleRate, data: wav.data,
      loopStart: Math.min(entry.loopStart, loopEnd), loopEnd, loopMode: entry.loopMode };
  });
  // defaults for anything a program from an older version doesn't have
  const programs = json.programs.map((p): Program => {
    const defaults = newProgram(p.name ?? 'PROGRAM');
    return {
      ...defaults, ...p,
      filterEnv: { ...defaults.filterEnv, ...p.filterEnv },
      ampEnv: { ...defaults.ampEnv, ...p.ampEnv },
      keygroups: (p.keygroups ?? []).map((k) => newKeygroup(k.sampleId, k)),
    };
  });
  return { samples, programs, programIndex: json.programIndex ?? 0 };
}
