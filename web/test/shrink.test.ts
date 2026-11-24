import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { Dsp } from '../src/audio/dsp';
import { defaultSound } from '../src/model/mapping';
import { plainRecipe } from '../src/model/recipe';
import { findEnd, highestFrequency, playedAudio, playedKey, rateForContent, spectrumSize } from '../src/model/shrink';
import type { Sample } from '../src/model/types';

// built by npm run engine (npm test runs it first)
let dsp: Dsp;
beforeAll(async () => {
  dsp = await Dsp.load(readFileSync(new URL('../public/engine.wasm', import.meta.url)));
});

/** A hit: 1 kHz at 44.1 kHz, falling 6 dB every 1000 samples, so -40 dB at about 6644 */
const hit = Float32Array.from({ length: 20000 }, (_, i) => Math.sin((2 * Math.PI * 1000 * i) / 44100) * 0.5 ** (i / 1000));

const oneShot = (overrides: Partial<Sample> = {}): Sample => ({
  id: 's', name: 'S', source: hit, sourceRate: 44100, recipe: plainRecipe(), fromSampler: false, rate: 44100,
  data: hit, start: 0, end: hit.length, loopStart: 0, loopEnd: hit.length, loopMode: 'off', reverse: false,
  sound: defaultSound(), bankId: null, slot: null, keygroups: [], ...overrides,
});

/** The last sample at a level, dB under the peak, +1 */
const lastAt = (data: Float32Array, db: number) => {
  const peak = Math.max(...Array.from(data, Math.abs));
  let i = data.length - 1;
  while (Math.abs(data[i]) < peak * 10 ** (db / 20)) {
    i--;
  }
  return i + 1;
};

describe('FIND END', () => {
  test('ends a one shot where it falls under the threshold for good', () => {
    const found = findEnd(oneShot(), -40);
    expect(found).toEqual({ point: 'end', at: lastAt(hit, -40), cut: hit.length - lastAt(hit, -40) });
    if (!('at' in found)) {
      throw new Error('not found');
    }
    expect(found.at).toBeGreaterThan(6600);
    expect(found.at).toBeLessThan(6650);
    // found again where it now ends: nothing more to cut
    expect(findEnd(oneShot({ end: found.at }), -40)).toMatchObject({ at: found.at, cut: 0 });
    // a lower threshold: later
    expect((findEnd(oneShot(), -60) as { at: number }).at).toBeGreaterThan(found.at + 3000);
  });

  test('only within what plays, and never past END', () => {
    // still loud at END: at most a zero crossing to cut
    const loud = lastAt(hit.subarray(0, 3000), -40);
    expect(loud).toBeGreaterThan(3000 - 23);
    expect(findEnd(oneShot({ end: 3000 }), -40)).toMatchObject({ at: loud, cut: 3000 - loud });
    // the peak is what plays: from START on, the level is under the hit's start
    const later = findEnd(oneShot({ start: 5000 }), -40) as { at: number };
    expect(later.at).toBe(5000 + lastAt(hit.subarray(5000), -40));
  });

  test('looks at the original: its fade out or resampling does not move it', () => {
    const faded = oneShot({ recipe: { ...plainRecipe(), fadeOutMs: 500 }, data: hit.map((v, i) => (i > 3000 ? 0 : v)) });
    expect((findEnd(faded, -40) as { at: number }).at).toBe(lastAt(hit, -40));
    // at half the rate, the points are in samples of half as many
    const half = oneShot({ rate: 22050, data: new Float32Array(10000), end: 10000 });
    expect((findEnd(half, -40) as { at: number }).at).toBe(Math.ceil(lastAt(hit, -40) / 2));
  });

  test('played backwards, START goes where it first comes up to the level', () => {
    const reversed = Float32Array.from(hit).reverse();
    const found = findEnd(oneShot({ source: reversed, data: reversed, reverse: true }), -40);
    expect(found).toEqual({ point: 'start', at: hit.length - lastAt(hit, -40), cut: hit.length - lastAt(hit, -40) });
  });

  test('a looped sample has no end to find, a silent one nothing', () => {
    expect(findEnd(oneShot({ loopMode: 'forward' }), -40)).toEqual({ why: 'LOOPED' });
    expect(findEnd(oneShot({ loopMode: 'alternating' }), -40)).toEqual({ why: 'LOOPED' });
    expect(findEnd(oneShot({ loopMode: 'drum' }), -40)).toMatchObject({ point: 'end' });
    const silence = new Float32Array(100);
    expect(findEnd(oneShot({ source: silence, data: silence, end: 100 }), -40)).toEqual({ why: 'SILENT' });
  });
});

describe('FIND RATE', () => {
  /** 1 kHz at full level and 5 kHz at -40 dB, rising from silence */
  const rate = 44100;
  const tones = Float32Array.from({ length: 30000 }, (_, i) => Math.min(1, i / 2000)
    * (Math.sin((2 * Math.PI * 1000 * i) / rate) + 0.01 * Math.sin((2 * Math.PI * 5000 * i) / rate)));

  test('the highest frequency over the threshold, and the lowest sampler rate that holds it', () => {
    const size = spectrumSize(rate);
    expect(size).toBe(2048);
    const spectrum = dsp.peakSpectrum(tones, size);
    expect(spectrum.length).toBe(1025);
    const bin = rate / size;
    expect(highestFrequency(spectrum, rate, -50)).toBeGreaterThan(5000 - 2 * bin);
    expect(highestFrequency(spectrum, rate, -50)).toBeLessThan(5000 + 2 * bin);
    expect(highestFrequency(spectrum, rate, -30)).toBeLessThan(1000 + 2 * bin);
    expect(highestFrequency(new Float32Array(10), rate, -50)).toBeNull();
    // 5 kHz needs 10 kHz: the sampler's 10477 Hz
    expect(rateForContent(5000, rate)).toBeCloseTo(10476.8, 1);
    expect(rateForContent(1000, rate)).toBeCloseTo(3924.38, 1);
  });

  test('no rate above the original\'s own, when it is one of the sampler\'s', () => {
    expect(rateForContent(7800, 15697.6)).toBeNull();
    expect(rateForContent(19000, 39555.4)).toBeNull();
    expect(rateForContent(4000, 15697.6)).toBeCloseTo(8315.46, 1);
    // content past the sampler's highest rate: that rate, the most it can have
    expect(rateForContent(21000, 44100)).toBeCloseTo(39555.4, 1);
    // not a sampler rate: the one over it that holds it, though it is a little higher
    expect(rateForContent(5512, 11025)).toBeCloseTo(11099.89, 1);
  });

  test('looks at what plays, as it plays, the loop repeated after it', () => {
    const source = Float32Array.from({ length: 100 }, (_, i) => i);
    const s = oneShot({ source, data: source, start: 10, end: 50, loopStart: 40, loopEnd: 50 });
    expect(Array.from(playedAudio(s, 16))).toEqual(Array.from({ length: 40 }, (_, i) => 10 + i));
    const looped = playedAudio({ ...s, loopMode: 'forward' }, 16);
    expect(looped.length).toBe(40 + 3 * 10);
    expect(Array.from(looped.subarray(40, 50))).toEqual(Array.from(source.subarray(40, 50)));
    expect(Array.from(looped.subarray(50, 60))).toEqual(Array.from(source.subarray(40, 50)));
    const alternating = playedAudio({ ...s, loopMode: 'alternating' }, 16);
    expect(Array.from(alternating.subarray(40, 50))).toEqual(Array.from(source.subarray(40, 50)).reverse());
    expect(Array.from(alternating.subarray(50, 60))).toEqual(Array.from(source.subarray(40, 50)));
    const backwards = playedAudio({ ...s, reverse: true }, 16);
    expect(backwards[0]).toBe(49);
    expect(backwards[39]).toBe(10);
    // a loop before START plays
    expect(playedAudio({ ...s, loopMode: 'forward', loopStart: 0 }, 16)[0]).toBe(0);
    // resampled to half: the points are in half as many samples, the original is looked at
    expect(Array.from(playedAudio({ ...s, rate: 22050, start: 5, end: 25 }, 16))).toEqual(Array.from(source.subarray(10, 50)));
    // the key follows what it gives
    expect(playedKey(s, 16)).toBe(playedKey({ ...s, recipe: { ...plainRecipe(), normalize: true } }, 16));
    expect(playedKey(s, 16)).not.toBe(playedKey({ ...s, end: 49 }, 16));
  });
});
