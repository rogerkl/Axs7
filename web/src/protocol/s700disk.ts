// The S700 disk format: one sample on a QuickDisk side, with its parameters. The X7000 uses it too. The parameters are
// laid out as in the S700's sample parameter message (Akai's "MIDI system exclusive data format for S700", 1986), a
// byte for each DB and a little-endian word for each DW, without the message's undefined first byte.
//
// From the start of the block (its first sync byte):
//   0-6      sync, 7 marker (see qd.ts)
//   8        "S700 FORMAT 0.00"
//   28h      32 programs x 4 bytes: lowest key, highest key, transpose (7 bits signed, top bit constant pitch), audio
//            trigger (top bit off, 7 bits note)
//   A8h      scan mode (RPMODE), start (SSTRT), a word the S700 keeps (END - 1), END + 1 (SEND), loop point (SLOOP),
//            a word the S700 keeps (loop length), LFO speed, depth and delay, filter, release, loudness, fine tune
//            (1/16 semitone, signed), nominal recording pitch (RECNP), recording bandwidth (RECBW), reversed,
//            velocity to filter, to loudness, to release, 2 undefined
//   C2h      4000h bytes of low nibbles, two samples to a byte (the even one in the low nibble), then 8000h bytes of
//            the high 8 bits: 32768 samples, 12 bit offset binary (800h is 0) as in a sample dump
//   C0C2h    CRC-16 of the bytes from the marker on

import { crc16, findBlocks, mfmBytes, qdCells } from './qd';

export const S700_FORMAT = 'S700 FORMAT 0.00';
export const S700_BLOCK_LENGTH = 0xc0c4;
export const S700_PROGRAMS = 32;
export const S700_DISK_SAMPLES = 0x8000;
const PROGRAMS_AT = 0x28;
const PARAMS_AT = 0xa8;
const AUDIO_AT = 0xc2;

/** The S700's scan modes (RPMODE) */
export const S700_SCAN = { oneShot: 1, looping: 2, alternating: 4, drum: 9 } as const;

/** A sample's place in one of the S700's 32 programs */
export interface S700KeyRange {
  /** MIDI notes, C3 = 60. Lower than `low` when the sample isn't in the program. */
  low: number;
  high: number;
  /** semitones, ±60 */
  transpose: number;
  constantPitch: boolean;
  /** the MIDI note an audio trigger plays, null when it is off */
  audioTrigger: number | null;
}

/** The S700's parameters of a sample, as its disk and its sample parameter message have them */
export interface S700SampleParams {
  /** for each of the 32 programs */
  programs: S700KeyRange[];
  /** RPMODE, see S700_SCAN */
  scanMode: number;
  start: number;
  /** after the last sample played (SEND, "END + 1") */
  end: number;
  /** the loop runs from here to the end */
  loop: number;
  lfoSpeed: number;
  lfoDepth: number;
  lfoDelay: number;
  filter: number;
  release: number;
  loudness: number;
  /** 1/16 semitone, ±16 */
  fineTune: number;
  /** the key the sample plays at its own pitch (RECNP) */
  recordPitch: number;
  /** the rate code (RECBW): 26400 Hz * 2^((bandwidth - 69) / 12) */
  bandwidth: number;
  /** only shown by the S700, the audio is stored as it plays */
  reversed: boolean;
  velFilter: number;
  velLoudness: number;
  velRelease: number;
}

export interface S700Disk {
  params: S700SampleParams;
  /** 12 bit, -2048..2047 */
  samples: Int16Array;
  /** false if the block is damaged: none of the blocks on the disk had a good CRC */
  crcOk: boolean;
  /** blocks on the track that were passed over: older, damaged copies left from saving again */
  skipped: number;
}

/** The sample rate of a recording bandwidth code */
export function bandwidthRate(bandwidth: number): number {
  return 26400 * 2 ** ((bandwidth - 69) / 12);
}

const signed = (v: number, bits: number) => (v & (1 << (bits - 1)) ? v - (1 << bits) : v);

/** Reads the parameters in a block: bytes and little-endian words */
export function readS700Params(b: Uint8Array): S700SampleParams {
  const word = (i: number) => b[i] | (b[i + 1] << 8);
  const programs: S700KeyRange[] = [];
  for (let p = 0; p < S700_PROGRAMS; p++) {
    const [low, high, transpose, trigger] = b.subarray(PROGRAMS_AT + p * 4, PROGRAMS_AT + p * 4 + 4);
    programs.push({ low, high, transpose: signed(transpose & 0x7f, 7), constantPitch: (transpose & 0x80) !== 0,
      audioTrigger: trigger & 0x80 ? null : trigger & 0x7f });
  }
  const at = PARAMS_AT;
  return {
    programs,
    scanMode: b[at],
    start: word(at + 1),
    end: word(at + 5),
    loop: word(at + 7),
    lfoSpeed: b[at + 11],
    lfoDepth: b[at + 12],
    lfoDelay: b[at + 13],
    filter: b[at + 14],
    release: b[at + 15],
    loudness: b[at + 16],
    fineTune: signed(b[at + 17], 8),
    recordPitch: b[at + 18],
    bandwidth: b[at + 19],
    reversed: b[at + 20] !== 0,
    velFilter: b[at + 21],
    velLoudness: b[at + 22],
    velRelease: b[at + 23],
  };
}

function readSamples(b: Uint8Array): Int16Array {
  const out = new Int16Array(S700_DISK_SAMPLES);
  for (let i = 0; i < S700_DISK_SAMPLES; i++) {
    const nibbles = b[AUDIO_AT + (i >> 1)];
    const low = i & 1 ? nibbles >> 4 : nibbles & 0x0f;
    out[i] = ((b[AUDIO_AT + 0x4000 + i] << 4) | low) - 2048;
  }
  return out;
}

const isS700Block = (b: Uint8Array) => String.fromCharCode(...b.subarray(8, 8 + S700_FORMAT.length)) === S700_FORMAT;

/**
 * Reads the sample on an S700 or X7000 disk image: the first block with a good CRC, or the first block if none has
 * one.
 *
 * @throws Error if it isn't a QuickDisk image, or has no S700 block
 */
export function readS700Disk(image: Uint8Array): S700Disk {
  const cells = qdCells(image);
  const blocks = findBlocks(cells).map((at) => mfmBytes(cells, at, S700_BLOCK_LENGTH))
    .filter((b) => b.length === S700_BLOCK_LENGTH && isS700Block(b));
  if (blocks.length === 0) {
    const any = findBlocks(cells).length > 0;
    throw new Error(any ? 'Not an S700/X7000 disk (an S612 disk?)' : 'No data on the disk');
  }
  const good = blocks.findIndex((b) => crc16(b, 7) === 0);
  const block = blocks[Math.max(0, good)];
  return { params: readS700Params(block), samples: readSamples(block), crcOk: good >= 0,
    skipped: Math.max(0, good) };
}
