// The S700's Akai exclusive messages for a sample's parameters (Akai's "MIDI system exclusive data format for S700",
// 1986): the request (RSPRM) and the parameters (SPRM). They carry what a sample dump doesn't: START and END as the
// display shows them, the scan mode, the sound, and the sample's key range in each of the 32 programs. The X7000 is
// said to have the S700's MIDI spec; not yet tried on one.
//
// Request:     F0 47 channel 04 id slot 00 F7
// Parameters:  F0 47 channel 0A id slot 00, 155 bytes of data as DB pairs (bytes 7-316), checksum, F7 (319 bytes)
//
// The data are the bytes the S700 keeps: the programs' 4 bytes each, an undefined byte, then the scan mode on, as on
// a disk without the undefined byte (see s700disk.ts). Each byte goes as two MIDI bytes (DB): its low 7 bits, then
// its top bit. A word (DW) is its low byte then its high byte, each as a DB. The checksum is the XOR of the data
// bytes. The document has a DB with 2 or more in its second byte leave the sampler's value as it is, and a DW with
// its second and third bytes so (the third is data); that isn't used here: to change one value, the slot's
// parameters are sent back with that value changed.

import { S700_PARAM_BYTES, readS700ParamBytes, s700ParamBytes } from './s700disk';
import type { S700SampleParams } from './s700disk';

export const AKAI = 0x47;
/**
 * The S700's identifier, "65" in the document: decimal, as are its other numbers without an H (function codes 4 and
 * 10). 65h is tried too, as it isn't certain.
 */
export const S700_IDS = [0x41, 0x65] as const;
export const RSPRM = 4;
export const SPRM = 10;
const DATA_AT = 7;
/** the undefined byte after the programs, which a disk doesn't have */
const UNDEFINED_AT = 32 * 4;
const DATA_BYTES = S700_PARAM_BYTES + 1;
/** START in the data, the word the sampler keeps with it (END - START - 1), END + 1, LOOP, and the word kept with
 * them (END - LOOP - 1) */
const START_AT = UNDEFINED_AT + 2;
const END_AT = START_AT + 4;
const LOOP_AT = END_AT + 2;
export const SPRM_LENGTH = DATA_AT + DATA_BYTES * 2 + 2;

/** The request for a slot's parameters, channel 0-15, slot from 0 */
export function sampleParamsRequest(channel: number, slot: number, id: number = S700_IDS[0]): Uint8Array {
  return Uint8Array.of(0xf0, AKAI, channel & 0x0f, RSPRM, id, slot & 0x7f, 0, 0xf7);
}

/** True for an Akai exclusive message of any kind */
export function isAkai(data: ArrayLike<number>): boolean {
  return data.length > 4 && data[0] === 0xf0 && data[1] === AKAI;
}

/** True for a sample parameters message */
export function isSampleParams(data: ArrayLike<number>): boolean {
  return isAkai(data) && data[3] === SPRM;
}

export interface SampleParams {
  channel: number;
  id: number;
  slot: number;
  params: S700SampleParams;
  /** the bytes the S700 keeps, the undefined one included (DATA_BYTES) */
  bytes: Uint8Array;
  checksumOk: boolean;
}

/**
 * Reads a sample parameters message
 *
 * @throws Error if it is too short
 */
export function parseSampleParams(data: Uint8Array): SampleParams {
  if (!isSampleParams(data) || data.length < SPRM_LENGTH - 1) {
    throw new Error(`Not a sample parameters message: ${data.length} bytes`);
  }
  const bytes = new Uint8Array(DATA_BYTES);
  let checksum = 0;
  for (let i = 0; i < DATA_BYTES; i++) {
    const [low, high] = [data[DATA_AT + 2 * i], data[DATA_AT + 2 * i + 1]];
    bytes[i] = low | ((high & 1) << 7);
    checksum ^= low ^ high;
  }
  const params = new Uint8Array(S700_PARAM_BYTES);
  params.set(bytes.subarray(0, UNDEFINED_AT));
  params.set(bytes.subarray(UNDEFINED_AT + 1), UNDEFINED_AT);
  return { channel: data[2], id: data[4], slot: data[5], params: readS700ParamBytes(params), bytes,
    checksumOk: checksum === data[DATA_AT + DATA_BYTES * 2] };
}

/** The message with a slot's parameters, to set them on the sampler */
export function sampleParamsMessage(channel: number, slot: number, params: S700SampleParams,
  id: number = S700_IDS[0]): Uint8Array {
  return sampleParamsBytesMessage(channel, slot, sampleParamsBytes(params), id);
}

/** The bytes the sampler keeps for the parameters, as a message has them (SampleParams.bytes) */
export function sampleParamsBytes(params: S700SampleParams): Uint8Array {
  const kept = s700ParamBytes(params);
  const bytes = new Uint8Array(DATA_BYTES);
  bytes.set(kept.subarray(0, UNDEFINED_AT));
  bytes.set(kept.subarray(UNDEFINED_AT), UNDEFINED_AT + 1);
  return bytes;
}

/** The message with the bytes the sampler keeps for a slot, as a reply has them (SampleParams.bytes) */
export function sampleParamsBytesMessage(channel: number, slot: number, bytes: Uint8Array,
  id: number = S700_IDS[0]): Uint8Array {
  if (bytes.length !== DATA_BYTES) {
    throw new Error(`${bytes.length} bytes of sample parameters, not ${DATA_BYTES}`);
  }
  const out = new Uint8Array(SPRM_LENGTH);
  out.set([0xf0, AKAI, channel & 0x0f, SPRM, id, slot & 0x7f, 0]);
  let checksum = 0;
  bytes.forEach((b, i) => {
    out.set([b & 0x7f, b >> 7], DATA_AT + 2 * i);
    checksum ^= (b & 0x7f) ^ (b >> 7);
  });
  out[SPRM_LENGTH - 2] = checksum;
  out[SPRM_LENGTH - 1] = 0xf7;
  return out;
}

/**
 * The bytes (SampleParams.bytes) with another START and END (after the last sample, SEND), and the words the sampler
 * keeps with them: the rest as they are
 */
export function bytesWithPoints(bytes: Uint8Array, start: number, end: number): Uint8Array {
  const out = bytes.slice();
  const word = (at: number, v: number) => out.set([v & 0xff, (v >> 8) & 0xff], at);
  const loop = bytes[LOOP_AT] | (bytes[LOOP_AT + 1] << 8);
  word(START_AT, start);
  word(START_AT + 2, end - start - 1);
  word(END_AT, end);
  word(LOOP_AT + 2, end - loop - 1);
  return out;
}

const PARAM_NAMES: [keyof S700SampleParams, string][] = [['start', 'START'], ['end', 'END'], ['loop', 'LOOP'],
  ['scanMode', 'SCAN'], ['reversed', 'REVERSED'], ['bandwidth', 'RATE CODE'], ['recordPitch', 'ROOT'],
  ['fineTune', 'FINE TUNE'], ['lfoSpeed', 'LFO SPEED'], ['lfoDepth', 'LFO DEPTH'], ['lfoDelay', 'LFO DELAY'],
  ['filter', 'FILTER'], ['release', 'RELEASE'], ['loudness', 'LEVEL'], ['velFilter', 'VEL>FILTER'],
  ['velLoudness', 'VEL>LEVEL'], ['velRelease', 'VEL>RELEASE']];

/** How the parameters the sampler has differ from the ones it should have, for the log; empty if they don't */
export function paramsDiffer(has: S700SampleParams, should: S700SampleParams): string[] {
  const out = PARAM_NAMES.filter(([k]) => has[k] !== should[k]).map(([k, name]) => `${name} ${String(has[k])} `
    + `(not ${String(should[k])})`);
  const programs = should.programs.flatMap((r, i) => {
    const h = has.programs[i];
    const inIt = (k: typeof r) => k.low <= k.high;
    const same = inIt(r) === inIt(h) && (!inIt(r) || (r.low === h.low && r.high === h.high
      && r.transpose === h.transpose && r.constantPitch === h.constantPitch && r.audioTrigger === h.audioTrigger));
    return same ? [] : [`P${i + 1}`];
  });
  if (programs.length) {
    out.push(`key ranges in ${programs.join(' ')}`);
  }
  return out;
}
