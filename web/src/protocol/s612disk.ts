// The S612 disk format (MD280 drive): one sample on a QuickDisk side. The S700 and X7000 load these too, without
// program data: the X7000 puts the sample in its own program, keys 36-96.
//
// From the start of the block (its first sync byte):
//   0-6      sync, 7 marker (see qd.ts)
//   8        32 bytes of the S612's settings, not known: the scan points and mode are in there somewhere, but
//            don't decode with confidence from the factory library's disks
//   28h      FC00h bytes, 32256 samples: 16 bit little-endian words, 12 bit offset binary in the top 12 bits
//   FC28h    CRC-16 of the bytes from the marker on
//
// The S612 samples at 31250 Hz (1 MHz / 32): its factory library plays as Cs a steady 0.4 semitones sharp at
// 32 kHz, the rate usually given for it.

import { crc16, findBlocks, mfmBytes, qdCells } from './qd';

export const S612_BLOCK_LENGTH = 0xfc2a;
export const S612_RATE = 31250;
export const S612_SAMPLES = 0x7e00;
const SETTINGS_AT = 8;
const AUDIO_AT = 0x28;

export interface S612Disk {
  /** 12 bit, -2048..2047 */
  samples: Int16Array;
  /** the S612's 32 bytes of settings, as they are */
  settings: Uint8Array;
  /** false if the block is damaged: none of the blocks on the disk had a good CRC */
  crcOk: boolean;
  /** blocks on the track that were passed over: older, damaged copies */
  skipped: number;
}

const S700_TEXT = 'S700';

/** True if the block's start says it is an S700's */
export function isS700Text(block: Uint8Array): boolean {
  return String.fromCharCode(...block.subarray(8, 8 + S700_TEXT.length)) === S700_TEXT;
}

/**
 * Reads the sample on an S612 disk image: the first block with a good CRC, or the first block if none has one.
 *
 * @throws Error if it isn't a QuickDisk image, or has no S612 block
 */
export function readS612Disk(image: Uint8Array): S612Disk {
  const cells = qdCells(image);
  const blocks = findBlocks(cells).map((at) => mfmBytes(cells, at, S612_BLOCK_LENGTH))
    .filter((b) => b.length === S612_BLOCK_LENGTH && !isS700Text(b));
  if (blocks.length === 0) {
    throw new Error('No S612 sample on the disk');
  }
  const good = blocks.findIndex((b) => crc16(b, 7) === 0);
  const block = blocks[Math.max(0, good)];
  const samples = new Int16Array(S612_SAMPLES);
  for (let i = 0; i < S612_SAMPLES; i++) {
    samples[i] = ((block[AUDIO_AT + 2 * i] | (block[AUDIO_AT + 2 * i + 1] << 8)) >> 4) - 2048;
  }
  return { samples, settings: block.slice(SETTINGS_AT, AUDIO_AT), crcOk: good >= 0, skipped: Math.max(0, good) };
}
