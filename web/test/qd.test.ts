import { existsSync, readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { BANDWIDTHS, samplerBandwidth } from '../src/protocol/akai';
import { crc16, findBlocks, isQdImage, mfmBytes, mfmCells, qdCells } from '../src/protocol/qd';
import { S700_BLOCK_LENGTH, S700_FORMAT, bandwidthRate, readS700Disk } from '../src/protocol/s700disk';
import { sampleFromDisk } from '../src/model/disk';
import { Store } from '../src/model/store';

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
  word(0xab, end - 1);
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
    const { programs } = sampleFromDisk(image, 'PAD');
    expect(programs).toHaveLength(32);
    expect(programs[0]).toEqual({ low: 24, high: 99, root: 62, semitones: 0, cents: 50, fixedPitch: false });
    expect(programs[1]).toBeNull();
    expect(programs[2]).toEqual({ low: 36, high: 48, root: 62, semitones: -24, cents: 50, fixedPitch: true });
    expect(programs.slice(3).every((p) => p === null)).toBe(true);
  });

  test('the store puts them in the programs by number, made as needed', () => {
    const store = new Store();
    const { sample, programs } = sampleFromDisk(image, 'PAD');
    store.addSampleToPrograms(sample, programs);
    expect(store.programs).toHaveLength(3);
    expect(store.programs[0].keygroups).toMatchObject([{ sampleId: sample.id, low: 24, high: 99, root: 62 }]);
    expect(store.programs[1].keygroups).toEqual([]);
    expect(store.programs[2].keygroups).toMatchObject([{ low: 36, high: 48, semitones: -24, fixedPitch: true }]);
    expect(store.selectedSampleId).toBe(sample.id);
  });

  test('damage and odd values are noted', () => {
    const odd = sampleFromDisk(qdImage(s700Block(ramp, { scan: 3, bytes: [0, 0, 0, 0, 0, 0, 0, 60, 60, 255] }, true)),
      'ODD');
    expect(odd.notes).toEqual(['The disk is damaged (CRC error), the sample may have clicks or noise',
      'Unknown scan mode 3, played as one shot', 'Reversed on the sampler: it is stored as it plays, so it plays the '
        + 'same here']);
    expect(odd.sample.loopMode).toBe('off');
  });
});

// The El Profesor de Danza library for the S700 (99 disks), if it is in sounds/ (not in the repository)
const LIBRARY = new URL('../../sounds/Akai S700 - El Profesor de Danza Library [for FlashFloppy and HxC].zip',
  import.meta.url);

describe.skipIf(!existsSync(LIBRARY))('a real S700 library', () => {
  const disks = Object.entries(unzipSync(new Uint8Array(readFileSync(LIBRARY))))
    .filter(([name]) => name.endsWith('.qd'))
    .map(([name, bytes]) => ({ name: name.replace(/^.*\/|\.qd$/g, ''), disk: readS700Disk(bytes), bytes }));

  test('every disk reads; one is damaged, one has an older copy passed over', () => {
    expect(disks).toHaveLength(99);
    expect(disks.filter((d) => !d.disk.crcOk).map((d) => d.name)).toEqual(['53 Big Anna']);
    expect(disks.filter((d) => d.disk.skipped).map((d) => d.name)).toEqual(['54 Great']);
    expect(new Set(disks.map((d) => d.disk.params.bandwidth))).toEqual(new Set([60]));
  });

  test('the first disk', () => {
    const { sample, programs, notes } = sampleFromDisk(disks.find((d) => d.name === '01 CMI voice 1')!.bytes, 'CMI');
    expect(notes).toEqual([]);
    expect(sample).toMatchObject({ rate: 15697.6, start: 0, end: 32752, loopStart: 32735, loopMode: 'forward' });
    expect(sample.sound).toMatchObject({ lfoSpeed: 50, lfoDepth: 0, lfoDelay: 64, filter: 88, release: 87, level: 90,
      velLevel: 50 });
    expect(programs[0]).toMatchObject({ low: 24, high: 99, root: 60, semitones: 0, cents: 0 });
    expect(programs.filter(Boolean)).toHaveLength(1);
  });

  test('the low nibbles: the even sample\'s in the low half of the byte follows the wave', () => {
    // with the halves swapped, each sample is further from what its neighbours predict
    const roughness = (s: Int16Array) => s.reduce((sum, v, i) => (i > 0 && i < s.length - 1
      ? sum + Math.abs(2 * v - s[i - 1] - s[i + 1]) : sum), 0);
    const swapped = (s: Int16Array) => s.map((v, i) => (v & ~0xf) | (s[i ^ 1] & 0xf));
    const smoother = disks.filter(({ disk }) => roughness(disk.samples) < roughness(swapped(disk.samples)));
    expect(smoother.length).toBeGreaterThan(90);
  });
});
