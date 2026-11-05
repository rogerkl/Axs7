import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync, unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { BANDWIDTHS, samplerBandwidth } from '../src/protocol/akai';
import { crc16, findBlocks, isQdImage, mfmBytes, mfmCells, qdCells } from '../src/protocol/qd';
import {
  S700_BLOCK_LENGTH, S700_FORMAT, bandwidthRate, buildS700Block, readS700Disk, readS700Params, writeS700Disk,
} from '../src/protocol/s700disk';
import { S612_KEYGROUP, diskFromSample, sampleFromDisk } from '../src/model/disk';
import { S612_BLOCK_LENGTH, S612_SAMPLES, readS612Disk } from '../src/protocol/s612disk';
import { defaultSound, newKeygroup } from '../src/model/mapping';
import { plainRecipe } from '../src/model/recipe';
import { Store } from '../src/model/store';
import type { Keygroup, Sample } from '../src/model/types';

/** A sample's key range in each of the sampler's 32 programs, null where it has none */
const rangesOf = (s: Sample) => Array.from({ length: 32 }, (_, p) => {
  const k = s.keygroups.find((g) => g.program === p);
  return k ? { low: k.low, high: k.high, root: k.root, semitones: k.semitones, cents: k.cents,
    fixedPitch: k.fixedPitch } : null;
});

interface BlockParams {
  programs?: [number, number, number, number][];
  scan?: number;
  start?: number;
  end?: number;
  loop?: number;
  /** LFO speed, depth, delay, filter, release, loudness, fine tune, record pitch, bandwidth, reversed, velocity to
   * filter, to loudness, to release */
  bytes?: number[];
}

/** An S700 block as the sampler saves one, from its first sync byte, with a good CRC unless asked not to */
function s700Block(samples: ArrayLike<number>, p: BlockParams = {}, badCrc = false): Uint8Array {
  const b = new Uint8Array(S700_BLOCK_LENGTH);
  b.fill(0x16, 0, 7);
  b[7] = 0xa5;
  b.set([...S700_FORMAT].map((c) => c.charCodeAt(0)), 8);
  for (let i = 0; i < 32; i++) {
    b.set(p.programs?.[i] ?? [24, 0, 0, 0xbc], 0x28 + i * 4); // not in the program: high below low
  }
  const word = (at: number, v: number) => b.set([v & 0xff, v >> 8], at);
  const end = p.end ?? 32752;
  b[0xa8] = p.scan ?? 2;
  word(0xa9, p.start ?? 0);
  word(0xab, end - 1 - (p.start ?? 0)); // as the X7000 sends it
  word(0xad, end);
  word(0xaf, p.loop ?? 0);
  word(0xb1, end - 1 - (p.loop ?? 0));
  b.set(p.bytes ?? [50, 0, 64, 88, 87, 90, 0, 60, 60, 0, 0, 50, 0], 0xb3);
  for (let i = 0; i < samples.length; i++) {
    const v = (samples[i] + 2048) & 0xfff; // offset binary
    b[0xc2 + 0x4000 + i] = v >> 4;
    b[0xc2 + (i >> 1)] |= i & 1 ? (v & 0x0f) << 4 : v & 0x0f;
  }
  const crc = crc16(b, 7, S700_BLOCK_LENGTH - 2) ^ (badCrc ? 1 : 0);
  word(S700_BLOCK_LENGTH - 2, crc);
  return b;
}

/** A disk image with the blocks on its track, each after an MFM run of 1 bits and 0 bits like the sampler writes */
function qdImage(...blocks: Uint8Array[]): Uint8Array {
  const idle = Uint8Array.from({ length: 4000 }, (_, i) => (i % 4 === 0 ? 1 : 0));
  const parts: Uint8Array[] = [idle];
  for (const block of blocks) {
    parts.push(mfmCells(new Uint8Array(200).fill(0xff)), mfmCells(new Uint8Array(10), 1), mfmCells(block), idle);
  }
  const cells = new Uint8Array(parts.reduce((n, c) => n + c.length, 0) + 7);
  parts.reduce((at, c) => (cells.set(c, at), at + c.length), 0);
  const track = new Uint8Array(cells.length >> 3);
  track.forEach((_, i) => {
    for (let k = 0; k < 8; k++) {
      track[i] |= cells[i * 8 + k] << k;
    }
  });
  const image = new Uint8Array(0x400 + track.length);
  image.set([0, 0, 0, 0x51, 0x44]); // "...QD"
  new DataView(image.buffer).setUint32(0x200, 0x400, true);
  new DataView(image.buffer).setUint32(0x204, track.length, true);
  image.set(track, 0x400);
  return image;
}

/** A ramp through all 12 bit values, so every bit of every sample is checked */
const ramp = Int16Array.from({ length: 32768 }, (_, i) => ((i * 7) % 4096) - 2048);

describe('QuickDisk images', () => {
  test('MFM there and back, CRC-16/ARC', () => {
    const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) & 0xff);
    expect(mfmBytes(mfmCells(bytes), 0, 300)).toEqual(bytes);
    // no two 1 cells next to each other, never more than three 0 cells
    expect(Array.from(mfmCells(bytes)).join('')).not.toMatch(/11|0000/);
    expect(crc16([...'123456789'].map((c) => c.charCodeAt(0)))).toBe(0xbb3d);
  });

  test('blocks are found by their sync, wherever they are on the track', () => {
    const image = qdImage(s700Block(ramp), s700Block(ramp));
    expect(isQdImage(image)).toBe(true);
    const cells = qdCells(image);
    const found = findBlocks(cells);
    expect(found).toHaveLength(2);
    expect(Array.from(mfmBytes(cells, found[0], 8))).toEqual([0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0x16, 0xa5]);
    expect(isQdImage(new Uint8Array(2000))).toBe(false);
  });

  test('an S700 disk: parameters, programs and the 12 bit audio', () => {
    const disk = readS700Disk(qdImage(s700Block(ramp, {
      programs: [[36, 59, 0x7f & -12, 0xbc], [60, 96, 0x80 | 5, 0x3c]],
      scan: 4, start: 100, end: 20000, loop: 5000,
      bytes: [1, 2, 3, 4, 5, 6, 0xfc, 57, 70, 0, 7, 8, 9],
    })));
    expect(disk.crcOk).toBe(true);
    expect(disk.samples).toEqual(ramp);
    expect(disk.params).toMatchObject({ scanMode: 4, start: 100, end: 20000, loop: 5000, lfoSpeed: 1, lfoDepth: 2,
      lfoDelay: 3, filter: 4, release: 5, loudness: 6, fineTune: -4, recordPitch: 57, bandwidth: 70,
      reversed: false, velFilter: 7, velLoudness: 8, velRelease: 9 });
    expect(disk.params.programs[0]).toEqual({ low: 36, high: 59, transpose: -12, constantPitch: false,
      audioTrigger: null });
    expect(disk.params.programs[1]).toEqual({ low: 60, high: 96, transpose: 5, constantPitch: true, audioTrigger: 60 });
  });

  test('the first block with a good CRC is read, a damaged one only if there is no other', () => {
    const older = s700Block(new Int16Array(32768), {}, true);
    const disk = readS700Disk(qdImage(older, s700Block(ramp)));
    expect(disk).toMatchObject({ crcOk: true, skipped: 1 });
    expect(disk.samples).toEqual(ramp);
    expect(readS700Disk(qdImage(older))).toMatchObject({ crcOk: false, skipped: 0 });
    expect(() => readS700Disk(qdImage())).toThrow(/No data/);
  });

  test('the recording bandwidth codes 36-76 are the sampler\'s 41 rates', () => {
    const rates = Array.from({ length: 41 }, (_, i) => samplerBandwidth(bandwidthRate(76 - i))?.rate);
    expect(rates).toEqual(BANDWIDTHS.map((bw) => bw.rate));
  });
});

describe('samples from disks', () => {
  const image = qdImage(s700Block(ramp, {
    programs: [[24, 99, 0, 0xbc], [24, 0, 0, 0xbc], [36, 48, 0x80 | (0x7f & -24), 0xbc]],
    scan: 2, start: 0, end: 32752, loop: 30000, bytes: [50, 10, 64, 88, 87, 90, 8, 62, 60, 0, 57, 50, 3],
  }));

  test('the sample as the sampler has it, with its sound, from the sampler', () => {
    const { sample, notes } = sampleFromDisk(image, 'PAD');
    expect(notes).toEqual([]);
    expect(sample).toMatchObject({ name: 'PAD', rate: 15697.6, sourceRate: 15697.6, fromSampler: true, start: 0,
      end: 32752, loopStart: 30000, loopEnd: 32752, loopMode: 'forward', reverse: false });
    expect(sample.source).toBe(sample.data);
    expect(sample.data.length).toBe(32752);
    expect(sample.data[5]).toBe(ramp[5] / 2048);
    expect(sample.sound).toEqual({ level: 90, velLevel: 50, filter: 88, velFilter: 57, release: 87, velRelease: 3,
      lfoSpeed: 50, lfoDepth: 10, lfoDelay: 64, pressure: 0 });
  });

  test('its keygroups in the programs it is in: root at its recording pitch, tuned, transposed', () => {
    const programs = rangesOf(sampleFromDisk(image, 'PAD').sample);
    expect(programs).toHaveLength(32);
    expect(programs[0]).toEqual({ low: 24, high: 99, root: 62, semitones: 0, cents: 50, fixedPitch: false });
    expect(programs[1]).toBeNull();
    expect(programs[2]).toEqual({ low: 36, high: 48, root: 62, semitones: -24, cents: 50, fixedPitch: true });
    expect(programs.slice(3).every((p) => p === null)).toBe(true);
  });

  test('in a slot of the current bank, they are in its programs by number', () => {
    const store = new Store();
    const { sample } = sampleFromDisk(image, 'PAD');
    store.addSample(sample, store.bank, 0);
    expect(store.programs).toHaveLength(32);
    expect(store.programs[0].keygroups).toMatchObject([{ sampleId: sample.id, low: 24, high: 99, root: 62 }]);
    expect(store.programs[1].keygroups).toEqual([]);
    expect(store.programs[2].keygroups).toMatchObject([{ low: 36, high: 48, semitones: -24, fixedPitch: true }]);
    expect(store.selectedSampleId).toBe(sample.id);
  });

  test('damage and odd values are noted', () => {
    const odd = sampleFromDisk(qdImage(s700Block(ramp, { scan: 3 }, true)), 'ODD');
    expect(odd.notes).toEqual(['The disk is damaged (CRC error), the sample may have clicks or noise',
      'Unknown scan mode 3, played as one shot']);
    expect(odd.sample.loopMode).toBe('off');
  });

  test('a reversed sample is stored as it plays: it is reversed back, its points mirrored', () => {
    const { sample } = sampleFromDisk(qdImage(s700Block(ramp, { start: 100, end: 30000, loop: 20000,
      bytes: [0, 0, 0, 0, 0, 0, 0, 60, 60, 255] })), 'REV');
    expect(sample).toMatchObject({ reverse: true, start: 2752, end: 32652, loopStart: 2752, loopEnd: 12752 });
    expect(sample.data[32751]).toBe(ramp[0] / 2048);
  });
});

/** An S612 block as on its disks: settings bytes (as on a factory disk), then 16 bit words with 12 bits on top */
function s612Block(samples: ArrayLike<number>, badCrc = false): Uint8Array {
  const b = new Uint8Array(S612_BLOCK_LENGTH);
  b.fill(0x16, 0, 7);
  b[7] = 0xa5;
  b.set([0x3b, 0xf0, 0xc4, 0x0e, 0x02, 0x08, 0x18, 0, 0, 0, 0, 0x82, 0xff, 0x7c, 0, 0, 4, 0, 0x84, 3], 8);
  for (let i = 0; i < 0x7e00; i++) {
    const word = ((((i < samples.length ? samples[i] : 0) + 2048) & 0xfff) << 4);
    b.set([word & 0xff, word >> 8], 0x28 + 2 * i);
  }
  const crc = crc16(b, 7, S612_BLOCK_LENGTH - 2) ^ (badCrc ? 1 : 0);
  b.set([crc & 0xff, crc >> 8], S612_BLOCK_LENGTH - 2);
  return b;
}

describe('S612 disks', () => {
  test('the audio at the S612\'s rate, a one shot of all its memory, as a file is loaded', () => {
    const disk = readS612Disk(qdImage(s612Block(ramp)));
    expect(disk.crcOk).toBe(true);
    expect(disk.samples).toEqual(ramp.subarray(0, 0x7e00));
    expect(disk.settings[4]).toBe(2);
    const { format, sample, notes } = sampleFromDisk(qdImage(s612Block(ramp)), 'VIBES');
    expect(format).toBe('S612');
    expect(sample).toMatchObject({ rate: 31250, sourceRate: 31250, fromSampler: false, start: 0, end: 32256,
      loopMode: 'off', reverse: false });
    expect(sample.data[7]).toBe(ramp[7] / 2048);
    expect(sample.keygroups).toEqual([]);
    expect(notes[0]).toMatch(/^S612 disk: its start, end and loop aren't read/);
  });

  test('damaged blocks as on S700 disks; an S700 disk is still an S700 disk', () => {
    const older = s612Block(new Int16Array(10), true);
    expect(readS612Disk(qdImage(older, s612Block(ramp)))).toMatchObject({ crcOk: true, skipped: 1 });
    expect(sampleFromDisk(qdImage(older), 'X').notes).toContain(
      'The disk is damaged (CRC error), the sample may have clicks or noise');
    expect(sampleFromDisk(qdImage(s700Block(ramp)), 'X').format).toBe('S700');
    expect(() => sampleFromDisk(qdImage(), 'X')).toThrow(/No data/);
  });

  test('each in a program of its own, keys 36-96 as on the X7000, or the current program if it is empty', () => {
    const store = new Store();
    const first = sampleFromDisk(qdImage(s612Block(ramp)), 'Vibes').sample;
    store.addSampleToOwnProgram(first, S612_KEYGROUP, 0);
    expect(store.programIndex).toBe(0);
    const second = { ...first, id: 'two', name: 'Marimba' };
    store.addSampleToOwnProgram(second, S612_KEYGROUP, 1);
    expect(store.programs.slice(0, 3).map((p) => p.name)).toEqual(['PROGRAM 1', 'MARIMBA', 'PROGRAM 3']);
    expect(store.programIndex).toBe(1);
    expect(store.program.keygroups).toMatchObject([{ sampleId: 'two', low: 36, high: 96, root: 60 }]);
    expect(store.selectedSampleId).toBe('two');
  });
});

/** Resamples by picking samples, so where each lands is known */
const pick = async (data: Float32Array, from: number, to: number) =>
  Float32Array.from({ length: Math.round((data.length * to) / from) },
    (_, i) => data[Math.min(data.length - 1, Math.round((i * from) / to))]);
const noResample = () => Promise.reject(new Error('should not resample'));

/** A sample as loaded from a file */
const fileSample = (overrides: Partial<Sample> = {}): Sample => {
  const data = overrides.data ?? Float32Array.from({ length: 44100 }, (_, i) => Math.sin(i / 20) * 0.5);
  const rate = overrides.rate ?? 44100;
  return { id: 'f', name: 'F', source: data, sourceRate: rate, recipe: plainRecipe(), fromSampler: false, rate, data,
    start: 0, end: data.length, loopStart: 0, loopEnd: data.length, loopMode: 'off', reverse: false,
    sound: defaultSound(), bankId: null, slot: null, keygroups: [], ...overrides };
};
/** Keygroups of the sample 'f' in P1, P2 … (none where null) */
const keygroupsIn = (...ranges: (Partial<Keygroup> | null)[]) => ranges.flatMap((k, i) => (k ? [newKeygroup('f', i,
  k)] : []));

describe('saving disks', () => {
  test('the block is built as the S700 builds it, and goes on a track as the S700 writes one', () => {
    const block = s700Block(ramp, { programs: [[36, 59, 0x7f & -12, 0xbc], [60, 96, 0x80 | 5, 0x3c]], scan: 4,
      start: 100, end: 20000, loop: 5000, bytes: [1, 2, 3, 4, 5, 6, 0xfc, 57, 70, 255, 7, 8, 9] });
    expect(buildS700Block(readS700Params(block), ramp)).toEqual(block);
    const image = writeS700Disk(block);
    expect(image.length).toBe(204800);
    const cells = qdCells(image);
    expect(findBlocks(cells)).toEqual([144517]); // where the S700 puts it
    expect(mfmBytes(cells, 144517, S700_BLOCK_LENGTH)).toEqual(block);
  });

  test('a sample from a file: at the sampler\'s rate, 12 bit, its points moved, its keygroups', async () => {
    const data = Float32Array.from({ length: 30000 }, (_, i) => Math.sin(i / 20) * 0.5);
    const sample = fileSample({ data, loopMode: 'forward', start: 441, loopStart: 22050, loopEnd: 30000,
      sound: { ...defaultSound(), filter: 70, lfoDepth: 12 }, keygroups: keygroupsIn(
        { low: 36, high: 59, root: 48, semitones: 0, cents: 25 }, null, { low: 60, high: 127, root: 62, semitones: -12,
          cents: 25 }, { low: 0, high: 127, fixedPitch: true, semitones: 7, cents: 25 }) });
    const { bytes, notes } = await diskFromSample(sample, pick);
    expect(notes).toEqual(['Resampled from 44100 to 39555.4 Hz (16khz)']);
    const disk = readS700Disk(bytes);
    expect(disk.crcOk).toBe(true);
    expect(disk.params).toMatchObject({ scanMode: 2, bandwidth: 76, start: 396, end: 26908, loop: 19778,
      recordPitch: 48, fineTune: 4, filter: 70, lfoDepth: 12, loudness: 80 });
    // the sampler's root is the first keygroup's, 48: the other's root 62 goes in its transpose (48 - 62 - 12),
    // constant pitch keeps its own
    expect(disk.params.programs.slice(0, 4)).toEqual([
      { low: 36, high: 59, transpose: 0, constantPitch: false, audioTrigger: null },
      { low: 24, high: 0, transpose: 0, constantPitch: false, audioTrigger: null },
      { low: 60, high: 99, transpose: -26, constantPitch: false, audioTrigger: null },
      { low: 0, high: 99, transpose: 7, constantPitch: true, audioTrigger: null }]);
    // loaded again it plays the same, each key at the same pitch
    const back = sampleFromDisk(bytes, 'F');
    expect(rangesOf(back.sample)[2]).toMatchObject({ root: 48, semitones: -26, cents: 25 });
    expect(back.sample.data[1000]).toBeCloseTo(Math.sin(Math.round((1000 * 44100) / 39555.4) / 20) * 0.5, 2);
  });

  test('saved and loaded again, a sample from the sampler is the same, reversed too', async () => {
    for (const reversed of [0, 255]) {
      const image = qdImage(s700Block(ramp, { programs: [[24, 99, 0, 0xbc]], start: 100, end: 30000, loop: 20000,
        bytes: [50, 10, 64, 88, 87, 90, 3, 62, 60, reversed, 57, 50, 3] }));
      const store = new Store();
      const { sample } = sampleFromDisk(image, 'X');
      store.addSample(sample, store.bank, 0);
      const saved = await diskFromSample(store.samples.get(sample.id)!, noResample);
      expect(saved.notes).toEqual([]);
      const again = readS700Disk(saved.bytes);
      expect(again.params).toEqual(readS700Disk(image).params);
      expect(again.samples.subarray(0, 32752)).toEqual(ramp.subarray(0, 32752));
    }
  });

  test('too long: from START, truncated; what the sampler can\'t have is noted', async () => {
    const data = Float32Array.from({ length: 50000 }, (_, i) => ((i % 100) - 50) / 64);
    const sample = fileSample({ data, rate: 39555.4, start: 10000, end: 50000, loopStart: 12000, loopEnd: 45000,
      loopMode: 'forward', keygroups: keygroupsIn({ low: 100, high: 120 }) });
    const { bytes, notes } = await diskFromSample(sample, noResample);
    expect(notes).toEqual(['Too long for the sampler: saved from START to END',
      'Truncated from 40000 to 32752 samples, 0.83 s',
      'Program 1: the key range is above the sampler\'s keys, left out']);
    const disk = readS700Disk(bytes);
    expect(disk.params).toMatchObject({ start: 0, end: 32752, loop: 2000 });
    expect(disk.samples[0]).toBe(Math.trunc(data[10000] * 2047 + 2048) - 2048);
    const nowhere = await diskFromSample(fileSample({ rate: 39555.4, data: new Float32Array(10000) }), noResample);
    expect(nowhere.notes).toEqual(['In no program: the sampler plays it from no key until it gets a key range']);
  });
});

/** Typed arrays compared without toEqual, which goes value by value and is slow for a whole disk */
function same(a: ArrayLike<number>, b: ArrayLike<number>, length = Math.max(a.length, b.length)): boolean {
  for (let i = 0; i < length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** Where the trailing sync bytes after an S700 block end: after them, the S700 leaves what was on the disk before */
const S700_WRITTEN = 144453 + (4 + S700_BLOCK_LENGTH + 8) * 16;

/** The disk loaded into memory, then saved from there */
async function savedAgain(bytes: Uint8Array, name: string) {
  const store = new Store();
  const { sample } = sampleFromDisk(bytes, name);
  store.addSample(sample, store.bank, 0);
  return diskFromSample(store.samples.get(sample.id)!, noResample);
}

// Disks the samplers wrote, with the audio replaced by the ramp (test/fixtures/make-fixtures.ts makes them from the
// libraries in sounds/, which aren't in the repository)
const fixture = (name: string) => gunzipSync(new Uint8Array(readFileSync(new URL(`fixtures/${name}`,
  import.meta.url))));

describe('disks as the samplers write them', () => {
  const s700 = fixture('s700.qd.gz');
  const s612 = fixture('s612.qd.gz');

  test('an S700 disk', () => {
    const disk = readS700Disk(s700);
    expect(disk).toMatchObject({ crcOk: true, skipped: 0 });
    expect(same(disk.samples, ramp, 32752)).toBe(true);
    expect(disk.samples.subarray(32752).every((v) => v === 0)).toBe(true); // silent after the sampler's samples
    const { format, sample, notes } = sampleFromDisk(s700, 'CMI');
    const programs = rangesOf(sample);
    expect(format).toBe('S700');
    expect(notes).toEqual([]);
    expect(sample).toMatchObject({ rate: 15697.6, start: 0, end: 32752, loopStart: 32735, loopMode: 'forward' });
    expect(sample.data[7]).toBe(ramp[7] / 2048);
    expect(sample.sound).toMatchObject({ lfoSpeed: 50, lfoDepth: 0, lfoDelay: 64, filter: 88, release: 87, level: 90,
      velLevel: 50 });
    expect(programs[0]).toMatchObject({ low: 24, high: 99, root: 60, semitones: 0, cents: 0 });
    expect(programs.filter(Boolean)).toHaveLength(1);
  });

  test('saved again, the S700 disk is the same: its parameters, its audio, and its track as the S700 wrote it',
    async () => {
      const saved = await savedAgain(s700, 'CMI');
      expect(saved.notes).toEqual([]);
      const again = readS700Disk(saved.bytes);
      expect(again.params).toEqual(readS700Disk(s700).params);
      expect(same(again.samples, ramp, 32752)).toBe(true);
      expect(same(qdCells(saved.bytes), qdCells(s700), S700_WRITTEN)).toBe(true);
    });

  test('an S612 disk', () => {
    const disk = readS612Disk(s612);
    expect(disk).toMatchObject({ crcOk: true, skipped: 0 });
    expect(same(disk.samples, ramp, S612_SAMPLES)).toBe(true);
    // the settings start where they do on every factory disk: their first two words add up to FEFFh
    const word = (at: number) => disk.settings[at] | (disk.settings[at + 1] << 8);
    expect(word(0) + word(2)).toBe(0xfeff);
    const { format, sample } = sampleFromDisk(s612, 'TROMBONE');
    expect(format).toBe('S612');
    expect(sample).toMatchObject({ rate: 31250, start: 0, end: S612_SAMPLES, loopMode: 'off' });
    expect(sample.data[7]).toBe(ramp[7] / 2048);
    expect(sample.keygroups).toEqual([]);
  });
});

// The El Profesor de Danza library for the S700 (99 disks), if it is in sounds/qd_examples/ (not in the repository)
const LIBRARY = new URL(
  '../../sounds/qd_examples/Akai S700 - El Profesor de Danza Library [for FlashFloppy and HxC].zip',
  import.meta.url);
const HAVE_LIBRARY = existsSync(LIBRARY);

describe.skipIf(!HAVE_LIBRARY)('a real S700 library', () => {
  // a skipped describe still runs, to collect its tests: the library is only read if it is there
  const disks = !HAVE_LIBRARY ? [] : Object.entries(unzipSync(new Uint8Array(readFileSync(LIBRARY))))
    .filter(([name]) => name.endsWith('.qd'))
    .map(([name, bytes]) => ({ name: name.replace(/^.*\/|\.qd$/g, ''), disk: readS700Disk(bytes), bytes }));

  test('every disk reads; one is damaged, one has an older copy passed over', () => {
    expect(disks).toHaveLength(99);
    expect(disks.filter((d) => !d.disk.crcOk).map((d) => d.name)).toEqual(['53 Big Anna']);
    expect(disks.filter((d) => d.disk.skipped).map((d) => d.name)).toEqual(['54 Great']);
    expect(new Set(disks.map((d) => d.disk.params.bandwidth))).toEqual(new Set([60]));
  });

  test('saved again, every disk is the same: its parameters, its audio, and its track as the S700 wrote it', async () => {
    const sameTrack: string[] = [];
    for (const d of disks) {
      const saved = await savedAgain(d.bytes, d.name);
      expect(saved.notes).toEqual([]);
      const again = readS700Disk(saved.bytes);
      expect(again.params).toEqual(d.disk.params);
      expect(same(again.samples, d.disk.samples, 32752), d.name).toBe(true);
      // the original block on our track: cell for cell as on the real disk, for the disks written as most are
      // (one is from another drive, one damaged, one with an older copy where the block goes)
      const cells = qdCells(d.bytes);
      const [at] = findBlocks(cells);
      if (at === 144517 && d.disk.crcOk && !d.disk.skipped) {
        const ours = qdCells(writeS700Disk(mfmBytes(cells, at, S700_BLOCK_LENGTH)));
        expect(same(cells, ours, S700_WRITTEN), d.name).toBe(true);
        sameTrack.push(d.name);
      }
    }
    expect(sameTrack).toHaveLength(96);
  }, 60000);

  test('the low nibbles: the even sample\'s in the low half of the byte follows the wave', () => {
    // with the halves swapped, each sample is further from what its neighbours predict
    const roughness = (s: Int16Array) => s.reduce((sum, v, i) => (i > 0 && i < s.length - 1
      ? sum + Math.abs(2 * v - s[i - 1] - s[i + 1]) : sum), 0);
    const swapped = (s: Int16Array) => s.map((v, i) => (v & ~0xf) | (s[i ^ 1] & 0xf));
    const smoother = disks.filter(({ disk }) => roughness(disk.samples) < roughness(swapped(disk.samples)));
    expect(smoother.length).toBeGreaterThan(90);
  });
});
