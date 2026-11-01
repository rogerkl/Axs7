// A bank is the whole memory in a zip file: bank.json with the programs and sample settings, and each sample as a
// wav file with its loop, so they can be used in other programs too. That is the rendered audio, what plays; a
// sample with edits has its original in originals/ as well, so editing goes on from it.

import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { encodeWav, readWav } from '../protocol/wav';
import { wavLoops } from './convert';
import { defaultSound, normalizeProgram } from './mapping';
import { plainRecipe } from './recipe';
import type { LoopMode, Program, Recipe, Sample, Sound } from './types';

export const BANK_FORMAT = 'axs7-bank';
/** 2: samples have their sound, programs only key ranges. 3: samples have their original and recipe. */
export const BANK_VERSION = 3;

export interface Bank {
  samples: Sample[];
  programs: Program[];
  programIndex: number;
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
}

interface BankJson {
  format: string;
  version: number;
  programIndex: number;
  samples: SampleEntry[];
  programs: Program[];
}

function fileName(dir: string, index: number, name: string): string {
  const safe = name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'sample';
  return `${dir}/${String(index + 1).padStart(3, '0')}-${safe}.wav`;
}

export function bankToZip(bank: Bank): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const samples = bank.samples.map((s, i): SampleEntry => {
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
      loopMode: s.loopMode, reverse: s.reverse, sound: s.sound };
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
    };
  });
  // version 1 programs had the sound settings, they are left out
  const programs = json.programs.map(normalizeProgram);
  return { samples, programs, programIndex: json.programIndex ?? 0 };
}
