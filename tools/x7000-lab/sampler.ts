// The sampler over MIDI for the measurements: test samples sent by sample dump, their parameters set with the S700's
// SPRM (and read back to be sure the sampler has them), notes and program changes.

import type { Midi } from './midi';
import { buildDump, wireSeconds } from '../../web/src/protocol/akai';
import { S700_NOT_IN_PROGRAM, S700_SCAN } from '../../web/src/protocol/s700disk';
import type { S700KeyRange, S700SampleParams } from '../../web/src/protocol/s700disk';
import { isSampleParams, paramsDiffer, parseSampleParams, sampleParamsMessage, sampleParamsRequest }
  from '../../web/src/protocol/sprm';

export const CHANNEL = 0;
export const ID = 0x41;
/** the program the test samples are in, alone: the sampler is switched to it */
export const PROGRAM = 31;
/** the sampler's top rate (code 76, "16khz") */
export const RATE_CODE = 76;
export const RATE = 26400 * 2 ** ((RATE_CODE - 69) / 12);

/** what the experiments change: the sound, and the scan mode */
export type Sound = Pick<S700SampleParams, 'lfoSpeed' | 'lfoDepth' | 'lfoDelay' | 'filter' | 'release' | 'loudness'
  | 'velFilter' | 'velLoudness' | 'velRelease' | 'scanMode'> & { recordPitch?: number };

export const NEUTRAL: Sound = { lfoSpeed: 50, lfoDepth: 0, lfoDelay: 0, filter: 99, release: 0, loudness: 99,
  velFilter: 0, velLoudness: 0, velRelease: 0, scanMode: S700_SCAN.looping };

export interface TestSample {
  name: string;
  slot: number;
  /** 12 bit offset binary */
  codes: Uint16Array;
  /** played at its own rate on this key */
  root: number;
  low: number;
  high: number;
  scanMode: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Noise, -0.9..0.9, the same every time */
export function noise(length: number, seed = 1): Float32Array {
  let s = seed >>> 0;
  return Float32Array.from({ length }, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s / 2 ** 32 * 2 - 1) * 0.9;
  });
}

export function sine(length: number, cycles: number, amplitude = 0.9): Float32Array {
  return Float32Array.from({ length }, (_, i) => amplitude * Math.sin((2 * Math.PI * cycles * i) / length));
}

export function toCodes(data: Float32Array): Uint16Array {
  return Uint16Array.from(data, (v) => Math.max(0, Math.min(4095, Math.round(2048 + v * 2047))));
}

export class Sampler {
  /** what each slot was last set to */
  private has = new Map<number, S700SampleParams>();

  constructor(readonly midi: Midi) {}

  async params(slot: number): Promise<S700SampleParams | null> {
    this.midi.send(sampleParamsRequest(CHANNEL, slot, ID));
    const reply = await this.midi.next((m) => isSampleParams(m) && m[5] === slot, 2000);
    return reply ? parseSampleParams(reply).params : null;
  }

  /** Sets the slot's parameters and reads them back */
  async setParams(slot: number, p: S700SampleParams): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      this.midi.send(sampleParamsMessage(CHANNEL, slot, p, ID));
      await sleep(30);
      const now = await this.params(slot);
      const differ = now ? paramsDiffer(now, p) : ['no answer'];
      if (!differ.length) {
        this.has.set(slot, p);
        return;
      }
      console.warn(`slot ${slot + 1}: ${differ.join(', ')}, again`);
    }
    throw new Error(`The sampler didn't take the parameters for slot ${slot + 1}`);
  }

  /** Changes some of the sound of a slot sent before, if they differ */
  async setSound(slot: number, sound: Partial<Sound>): Promise<void> {
    const p = this.has.get(slot);
    if (!p) {
      throw new Error(`Slot ${slot + 1} wasn't set up`);
    }
    if ((Object.keys(sound) as (keyof Sound)[]).some((k) => p[k] !== sound[k])) {
      await this.setParams(slot, { ...p, ...sound });
    }
  }

  paramsFor(t: TestSample, sound: Sound): S700SampleParams {
    const programs: S700KeyRange[] = Array.from({ length: 32 }, (_, i) => (i === PROGRAM
      ? { low: t.low, high: t.high, transpose: 0, constantPitch: false, audioTrigger: null } : S700_NOT_IN_PROGRAM));
    const end = t.codes.length;
    return { programs, start: 0, end, loop: 0, fineTune: 0, bandwidth: RATE_CODE, reversed: false, ...sound,
      recordPitch: sound.recordPitch ?? t.root, scanMode: sound.scanMode };
  }

  /** Sends the sample by sample dump, then its parameters, unless the slot has them already (sent before) */
  async sendSample(t: TestSample, sound: Sound, force = false): Promise<void> {
    const p = this.paramsFor(t, sound);
    const now = await this.params(t.slot);
    // the same points, scan, rate and key ranges: taken to be the sample sent before, only the sound is set
    if (!force && now && !paramsDiffer({ ...now, ...sound }, p).length) {
      console.log(`slot ${t.slot + 1} has ${t.name} already`);
      await this.setParams(t.slot, p);
      return;
    }
    const looped = t.scanMode === S700_SCAN.looping;
    const dump = buildDump({ slot: t.slot, sampleRate: RATE, numSamples: t.codes.length,
      loopStart: looped ? 0 : t.codes.length, loopEnd: t.codes.length, alternating: false }, t.codes);
    console.log(`sending ${t.name} to slot ${t.slot + 1}: ${dump.bytes.length} bytes, `
      + `${wireSeconds(dump.bytes.length).toFixed(1)} s`);
    const t0 = Date.now();
    this.midi.send(dump.bytes);
    // the write returns with the end still in the driver's buffer
    await sleep(Math.max(0, wireSeconds(dump.bytes.length) * 1000 - (Date.now() - t0)) + 1500);
    await this.setParams(t.slot, p);
  }

  program(n: number): void {
    this.midi.send([0xc0 | CHANNEL, n]);
  }

  noteOn(note: number, velocity: number): void {
    this.midi.send([0x90 | CHANNEL, note, velocity]);
  }

  noteOff(note: number, velocity = 0): void {
    this.midi.send([0x80 | CHANNEL, note, velocity]);
  }

  allOff(): void {
    for (let n = 24; n <= 99; n++) {
      this.noteOff(n);
    }
  }
}
