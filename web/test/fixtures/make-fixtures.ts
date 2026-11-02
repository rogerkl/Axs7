// Makes the disk images in this folder from real ones in sounds/ (not in the repository, the libraries aren't ours to
// publish): a disk as an S700 wrote it and one as an S612 did, with the audio replaced by the tests' ramp through every
// 12 bit value. The tracks are the real ones, cell for cell outside the audio, so the tests check reading and writing
// against disks written by the samplers, without the libraries' sounds.
//
// - s700.qd.gz: "01 CMI voice 1" of the El Profesor de Danza library. Its parameters and programs are kept, and the
//   silence the S700 keeps after the 32752 samples. After the block, the S700 left what an older recording put there;
//   that is replaced with what writeS700Disk puts there.
// - s612.qd.gz: "01B Trombone" of the Akai Sound Library (Grey), [FF] images. Its 32 bytes of settings are kept.
//
// Run from web/ with: npx vite-node test/fixtures/make-fixtures.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'fflate';
import { crc16, findBlocks, mfmBytes, mfmCells, qdCells } from '../../src/protocol/qd';
import { S700_BLOCK_LENGTH, writeS700Disk } from '../../src/protocol/s700disk';
import { S612_BLOCK_LENGTH, S612_SAMPLES } from '../../src/protocol/s612disk';

const SOUNDS = new URL('../../../sounds/', import.meta.url);
const S700_DISK = 'Akai S700 - El Profesor de Danza Library [for FlashFloppy and HxC]/01 CMI voice 1.qd';
const S612_DISK = 'Akai S612 QD (revision A)/Akai S612 QD (revision A) [FF]/Akai Sound Library (Grey)/01B Trombone.qd';

/** The tests' ramp: through all 12 bit values, so every bit of every sample is checked */
const ramp = (i: number) => ((i * 7) % 4096) - 2048;

function check(ok: boolean, what: string): void {
  if (!ok) {
    throw new Error(what);
  }
}

/** The block, its CRC made again after its bytes from 8 on changed */
function withCrc(block: Uint8Array): Uint8Array {
  const crc = crc16(block, 7, block.length - 2);
  block.set([crc & 0xff, crc >> 8], block.length - 2);
  check(crc16(block, 7) === 0, 'CRC');
  return block;
}

/** The track's cells with the block's bytes in place of the ones from `at` on */
function replaceBlock(cells: Uint8Array, at: number, block: Uint8Array): Uint8Array {
  const out = cells.slice();
  out.set(mfmCells(block, cells[at - 1]), at);
  check(out.subarray(0, at + 8 * 16).every((c, i) => c === cells[i]), 'sync bytes and marker unchanged');
  // the clock cell after the block depends on its last bit, if MFM goes on after it
  const after = at + block.length * 16;
  const clock = (last: number) => (last === 0 && cells[after + 1] === 0 ? 1 : 0);
  if (after < cells.length && cells[after] === clock(cells[after - 1])) {
    out[after] = clock(out[after - 1]);
  }
  return out;
}

/** The image with the cells as its track: its header and what is after the track as they were */
function withTrack(image: Uint8Array, cells: Uint8Array): Uint8Array {
  const out = image.slice();
  out.fill(0, 0x400, 0x400 + cells.length / 8);
  cells.forEach((c, i) => {
    out[0x400 + (i >> 3)] |= c << (i & 7);
  });
  return out;
}

function save(name: string, image: Uint8Array): void {
  writeFileSync(new URL(name, import.meta.url), gzipSync(image, { level: 9, mtime: 0 }));
  console.log(name, image.length, 'bytes');
}

{
  const image = new Uint8Array(readFileSync(new URL(S700_DISK, SOUNDS)));
  const cells = qdCells(image);
  const [at] = findBlocks(cells);
  check(at === 144517, 'the S700 block where most disks have it');
  const block = mfmBytes(cells, at, S700_BLOCK_LENGTH);
  // the sampler's 32752 samples; it keeps the 16 after them silent
  check(block.subarray(0xc2 + 0x4000 + 32752, 0xc2 + 0x8000 + 0x4000).every((b) => b === 0x80)
    && block.subarray(0xc2 + 32752 / 2, 0xc2 + 0x4000).every((b) => b === 0), 'silence after the samples');
  for (let i = 0; i < 32752; i++) {
    const v = ramp(i) + 2048; // offset binary
    block[0xc2 + 0x4000 + i] = v >> 4;
    block[0xc2 + (i >> 1)] = i & 1 ? (block[0xc2 + (i >> 1)] & 0x0f) | ((v & 0x0f) << 4) : v & 0x0f;
  }
  const replaced = replaceBlock(cells, at, withCrc(block));
  // after the block and its trailing sync bytes: as writeS700Disk has it, in place of what an older recording left
  const upTo = 144453 + (4 + S700_BLOCK_LENGTH + 8) * 16;
  const ours = qdCells(writeS700Disk(block));
  check(ours.length === cells.length, 'track length');
  check(ours.subarray(0, upTo).every((c, i) => c === replaced[i]), 'writeS700Disk makes the real track');
  replaced.set(ours.subarray(upTo), upTo);
  save('s700.qd.gz', withTrack(image, replaced));
}

{
  const image = new Uint8Array(readFileSync(new URL(S612_DISK, SOUNDS)));
  const cells = qdCells(image);
  const blocks = findBlocks(cells);
  check(blocks.length === 1, 'one S612 block');
  const block = mfmBytes(cells, blocks[0], S612_BLOCK_LENGTH);
  check(crc16(block, 7) === 0, 'the S612 block reads');
  for (let i = 0; i < S612_SAMPLES; i++) {
    const v = (ramp(i) + 2048) << 4; // 12 bit offset binary in the top of a 16 bit word, as on the real disks
    block.set([v & 0xff, v >> 8], 0x28 + 2 * i);
  }
  save('s612.qd.gz', withTrack(image, replaceBlock(cells, blocks[0], withCrc(block))));
}
