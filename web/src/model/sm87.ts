// SM-87 (a 1987 studio for the M-VAVE FM-1: an MMT-8 sequencer, an S700/X7000 sampler and an HR-16 drum machine)
// takes samples and a drum kit built into its firmware package. Two banks make them here:
//   - SAMPLES: its samples go in SM-87's slots, the slot each has in the bank, with their parameters and key ranges,
//     as they would go to an X7000;
//   - DRUMS: its first 16 programs are the HR-16's drums (KICK .. PERC2). Each plays its first keygroup's sample, as
//     the HR-16 plays a sound: once, start to end, tuned in whole semitones, at a level and a pan. They make a kit
//     that replaces the firmware's own.
// The rules are SM-87's documentation/sample-bank.md ("A kit from a sampler's programs"); ../sm87/sm87bank.js makes
// the bytes and puts them into a package.

import { MAX_SAMPLES, nearestBandwidth, samplerBandwidth } from '../protocol/akai';
import { sampleParamsBytes } from '../protocol/sprm';
import { HR16_DRUMS, PADS, hr16Pads, packedSize } from '../sm87/sm87bank.js';
import type { BankSample, Hr16DrumSound, Kit, KitSound } from '../sm87/sm87bank.js';
import type { Resampler } from './convert';
import { newBank } from './mapping';
import { usedStart } from './points';
import { samplerImage } from './s700';
import { isLooped } from './types';
import type { Bank, Keygroup, Sample, Sm87Role } from './types';

/** The HR-16's drums: P1-P16 of a DRUMS bank */
export const SM87_DRUMS = PADS;
/** The key a drum is tuned from: SM-87 plays a drum's sample as this key plays its keygroup here (C3) */
export const SM87_TUNE_KEY = 60;
/** A drum's tuning, semitones either way */
export const SM87_TUNE_MAX = 24;
/** A drum's pan, -3 (left) .. 3 */
export const SM87_PAN_MAX = 3;
/**
 * The room SM-87's firmware leaves for samples and a kit, bytes, until a package is opened: its own says (its
 * firmware's image less the slot). This is the firmware's of 2026-11-11, 379,716 bytes; a later one has a little less
 */
export const SM87_ROOM_TODAY = 379716;
/** the bank's parts (SM-87's app/s700/s7bank.h): a sample's entry, a kit sound's, a pad's, the footer */
const ENTRY = 188;
const SOUND = 16;
const PAD = 16;
const FOOT = 32;

/** The two banks, DRUMS with its 16 programs named after the HR-16's drums, and SAMPLES */
export function newSm87Banks(): [Bank, Bank] {
  const drums = newBank('DRUMS');
  drums.sm87 = 'drums';
  HR16_DRUMS.forEach((d, i) => {
    drums.programs[i].name = d.drum;
    drums.programs[i].pan = 0;
  });
  drums.programs.slice(SM87_DRUMS).forEach((p) => {
    p.name = 'NOT A DRUM';
  });
  const samples = newBank('SAMPLES');
  samples.sm87 = 'samples';
  return [drums, samples];
}

/** The first bank with SM-87's role, null if none has it */
export function sm87Bank(banks: Bank[], role: Sm87Role): Bank | null {
  return banks.find((b) => b.sm87 === role) ?? null;
}

/** A drum program (P1-P16 of a DRUMS bank) */
export function isDrum(bank: Bank, program: number): boolean {
  return bank.sm87 === 'drums' && program >= 0 && program < SM87_DRUMS;
}

/** The HR-16's name for the drum a DRUMS program is, null if it isn't one */
export function drumName(bank: Bank, program: number): string | null {
  return isDrum(bank, program) ? HR16_DRUMS[program].drum : null;
}

/** A drum's tuning from its keygroup, semitones, before it is kept within SM87_TUNE_MAX: as SM87_TUNE_KEY plays it */
export function drumTune(k: Keygroup): number {
  return (k.fixedPitch ? 0 : SM87_TUNE_KEY - k.root) + k.semitones;
}

export interface Sm87Contents {
  /** the SAMPLES bank's, for SM-87's slots */
  samples: BankSample[];
  /** the DRUMS bank's, null if no drum has a sample (the firmware's own kit plays) */
  kit: Kit | null;
  /** what was changed or left out */
  notes: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * What goes into SM-87's firmware: the SAMPLES bank's samples, each as the sampler keeps it (see samplerImage) up to
 * its END, and the DRUMS bank's drums as a kit. A drum's sound is its sample from START to END as it plays (reversed
 * if it is), at the sampler's rate it has, with its VEL>LEVEL; drums of one sample share it. The drum's pad has its
 * keygroup's tuning (drumTune), the sample's LEVEL and the program's pan.
 */
export async function sm87Contents(banks: Bank[], samples: Iterable<Sample>, resample: Resampler)
  : Promise<Sm87Contents> {
  const all = [...samples];
  const notes: string[] = [];
  const out: BankSample[] = [];
  const samplesBank = sm87Bank(banks, 'samples');
  if (samplesBank) {
    const mine = all.filter((s) => s.bankId === samplesBank.id && s.slot !== null)
      .sort((a, b) => a.slot! - b.slot!);
    for (const s of mine) {
      if (s.slot! >= PADS) {
        notes.push(`${s.name}: slot ${s.slot! + 1}, SM-87 has 16: left out`);
        continue;
      }
      const image = await samplerImage(s, resample, 'built in');
      image.notes.forEach((n) => notes.push(`${s.name}: ${n}`));
      if (!image.inProgram) {
        notes.push(`${s.name}: in no program of ${samplesBank.name}, no key plays it`);
      }
      const words = Uint16Array.from(image.samples.subarray(0, image.params.end), (v) => v + 2048);
      out.push({ slot: s.slot!, name: s.name, words, params: sampleParamsBytes(image.params),
        pressure: clamp(Math.round(s.sound.pressure), 0, 99) });
    }
  }
  return { samples: out, kit: await drumKit(banks, all, resample, notes), notes };
}

async function drumKit(banks: Bank[], samples: Sample[], resample: Resampler, notes: string[]): Promise<Kit | null> {
  const bank = sm87Bank(banks, 'drums');
  if (!bank) {
    return null;
  }
  const byId = new Map(samples.map((s) => [s.id, s]));
  const keygroups = (program: number) => samples.filter((s) => s.bankId === bank.id)
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
    .flatMap((s) => s.keygroups.filter((k) => k.program === program));
  const sounds: KitSound[] = [];
  const soundOf = new Map<string, number>();
  const byDrum: (Hr16DrumSound | null)[] = [];
  for (let i = 0; i < SM87_DRUMS; i++) {
    const drum = HR16_DRUMS[i];
    const [k, ...more] = keygroups(i);
    const sample = k ? byId.get(k.sampleId) : undefined;
    if (!k || !sample) {
      byDrum.push(null);
      continue;
    }
    if (more.length) {
      notes.push(`${drum.drum}: ${more.length + 1} keygroups, a drum plays its first one`);
    }
    if (!soundOf.has(sample.id)) {
      const image = await samplerImage(sample, resample, 'built in');
      image.notes.filter((n) => !/END is the loop end/.test(n)).forEach((n) => notes.push(`${sample.name}: ${n}`));
      if (isLooped(sample.loopMode)) {
        notes.push(`${drum.drum}: ${sample.name} loops, a drum plays once: START to the loop end`);
      }
      const { start, end, bandwidth } = image.params;
      if (end <= start) {
        notes.push(`${drum.drum}: ${sample.name} has nothing between START and END`);
        byDrum.push(null);
        continue;
      }
      soundOf.set(sample.id, sounds.length);
      sounds.push({ name: drum.name, rate: bandwidth, vel: clamp(Math.round(sample.sound.velLevel), 0, 99),
        words: Uint16Array.from(image.samples.subarray(start, end), (v) => v + 2048) });
    }
    const tune = drumTune(k);
    if (Math.abs(tune) > SM87_TUNE_MAX) {
      notes.push(`${drum.drum}: tuned ${tune > 0 ? '+' : ''}${tune}, a drum goes to ±${SM87_TUNE_MAX}`);
    }
    if (k.cents) {
      notes.push(`${drum.drum}: FINE ${k.cents} left out, a drum is tuned in semitones`);
    }
    byDrum.push({ sound: soundOf.get(sample.id)!, tune: clamp(tune, -SM87_TUNE_MAX, SM87_TUNE_MAX),
      level: clamp(Math.round(sample.sound.level), 0, 99),
      pan: clamp(Math.round(bank.programs[i].pan ?? 0), -SM87_PAN_MAX, SM87_PAN_MAX) });
  }
  for (let p = SM87_DRUMS; p < bank.programs.length; p++) {
    if (keygroups(p).length) {
      notes.push(`${bank.name} P${p + 1}: not a drum (P1-P${SM87_DRUMS} are), left out`);
    }
  }
  if (!sounds.length) {
    return null;
  }
  return { sounds, pads: hr16Pads(byDrum) };
}

/**
 * Where a sample's START and END are as the sampler keeps it (samplerImage's points, without making its words): at
 * the sampler's rate, reversed as it plays, its END a loop's end. A sample to be resampled is about so long: the
 * browser's resampler decides to a word or so.
 */
export function samplerPoints(sample: Sample): { start: number; end: number } {
  const own = samplerBandwidth(sample.rate);
  const ratio = own ? 1 : nearestBandwidth(sample.rate).rate / sample.rate;
  let from = 0;
  let to = sample.data.length;
  if (to * ratio > MAX_SAMPLES + 0.5) {
    from = usedStart(sample);
    to = sample.end;
  }
  let n = to - from;
  const at = (x: number) => clamp(x - from, 0, n);
  let p = [sample.start, sample.end, sample.loopStart, sample.loopEnd].map(at);
  if (sample.reverse) {
    p = [n - p[1], n - p[0], n - p[3], n - p[2]];
  }
  if (ratio !== 1) {
    n = Math.round(n * ratio);
    p = p.map((x) => clamp(Math.round(x * ratio), 0, n));
  }
  if (n > MAX_SAMPLES) {
    n = MAX_SAMPLES;
    p = p.map((x) => Math.min(x, MAX_SAMPLES));
  }
  const [start, end, , loopEnd] = p;
  return { start, end: Math.min(n, Math.max(start + 2, isLooped(sample.loopMode) ? loopEnd : end)) };
}

export interface Sm87Size {
  /** the SAMPLES bank's, bytes, their entries with them */
  samples: number;
  /** the DRUMS bank's kit, bytes: its sounds, their entries and the 16 pads */
  drums: number;
  /** what goes into the firmware, bytes (0: nothing, the package as built) */
  total: number;
}

const words = (n: number) => (packedSize(n) + 3) & ~3;

/** What SM-87's banks take of the firmware's room, as a package of them has them (sm87Contents), without making them */
export function sm87Size(banks: Bank[], samples: Iterable<Sample>): Sm87Size {
  const all = [...samples];
  let inSamples = 0;
  const samplesBank = sm87Bank(banks, 'samples');
  if (samplesBank) {
    for (const s of all) {
      if (s.bankId === samplesBank.id && s.slot !== null && s.slot < PADS) {
        inSamples += ENTRY + words(samplerPoints(s).end);
      }
    }
  }
  let drums = 0;
  const bank = sm87Bank(banks, 'drums');
  if (bank) {
    const mine = all.filter((s) => s.bankId === bank.id).sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
    const counted = new Set<string>();
    for (let i = 0; i < SM87_DRUMS; i++) {
      const k = mine.flatMap((s) => s.keygroups.filter((x) => x.program === i))[0];
      const s = k ? mine.find((x) => x.id === k.sampleId) : undefined;
      if (s && !counted.has(s.id)) {
        const { start, end } = samplerPoints(s);
        if (end > start) {
          counted.add(s.id);
          drums += SOUND + words(end - start);
        }
      }
    }
    if (drums) {
      drums += PADS * PAD;
    }
  }
  return { samples: inSamples, drums, total: inSamples || drums ? inSamples + drums + FOOT : 0 };
}
