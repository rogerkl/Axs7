import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { Dsp } from '../src/audio/dsp';
import { defaultSound } from '../src/model/mapping';
import { isTwelveBit } from '../src/model/edit';
import { isEdited, plainRecipe, renderKey } from '../src/model/recipe';
import { renderSample, writtenEdits } from '../src/model/render';
import type { Recipe, Sample } from '../src/model/types';
import { BW16 } from '../src/protocol/akai';

// built by npm run engine (npm test runs it first)
let dsp: Dsp;
beforeAll(async () => {
  dsp = await Dsp.load(readFileSync(new URL('../public/engine.wasm', import.meta.url)));
});

/** A quiet, rising sine at 44.1 kHz, as loaded */
const source = Float32Array.from({ length: 10000 }, (_, i) => Math.sin(i / 5) * 0.25 * (0.5 + i / 20000));

const loaded = (recipe: Partial<Recipe> = {}, overrides: Partial<Sample> = {}): Sample => ({
  id: 's', name: 'S', source, sourceRate: 44100, recipe: { ...plainRecipe(), ...recipe }, fromSampler: false,
  rate: 44100, data: source, start: 1000, end: 9000, loopStart: 4000, loopEnd: 8000, loopMode: 'forward',
  reverse: false, sound: defaultSound(), ...overrides,
});

/** Resamples by picking samples, so where each lands is known */
const calls: number[][] = [];
const pick = async (data: Float32Array, from: number, to: number) => {
  calls.push([from, to]);
  return Float32Array.from({ length: Math.round((data.length * to) / from) }, (_, i) =>
    data[Math.min(data.length - 1, Math.round((i * from) / to))]);
};
const noResample = () => Promise.reject(new Error('should not resample'));

const peak = (d: Float32Array, from: number, to: number) => Math.max(...Array.from(d.subarray(from, to), Math.abs));

describe('rendering a sample from its original', () => {
  test('without edits it is the original itself', async () => {
    const r = await renderSample(loaded(), noResample, dsp);
    expect(r.data).toBe(source);
    expect(r).toMatchObject({ rate: 44100, start: 1000, end: 9000, loopStart: 4000, loopEnd: 8000 });
    expect(isEdited(plainRecipe())).toBe(false);
  });

  test('normalize scales from the original, as often as it is done', async () => {
    const r = await renderSample(loaded({ normalize: true }), noResample, dsp);
    expect(peak(r.data, 1000, 9000)).toBeCloseTo(1, 6);
    expect(source[100]).toBe(Math.fround(Math.sin(20) * 0.25 * (0.5 + 100 / 20000))); // the original stays
    // a shorter part normalizes to its own peak, from the original, not from what was normalized before
    const short = await renderSample(loaded({ normalize: true }, { start: 1000, end: 2000, loopStart: 1000,
      loopEnd: 2000, data: r.data }), noResample, dsp);
    expect(peak(short.data, 1000, 2000)).toBeCloseTo(1, 6);
    const gain = 1 / peak(source, 1000, 2000);
    expect(short.data[1500]).toBeCloseTo(source[1500] * gain, 6);
  });

  test('normalize takes in a loop that goes back before START', async () => {
    const data = new Float32Array(10000).fill(0.1);
    data[2000] = 0.5;
    const r = await renderSample(loaded({ normalize: true }, { source: data, data, start: 8000, end: 9000,
      loopStart: 1000, loopEnd: 9000, loopMode: 'alternating' }), noResample, dsp);
    expect(r.data[2000]).toBeCloseTo(1, 6); // not clipped
    expect(r.data[8500]).toBeCloseTo(0.2, 6);
  });

  test('12 bit comes last, it is what the sampler gets', async () => {
    const r = await renderSample(loaded({ normalize: true, twelveBit: true, attackMs: 10 }), noResample, dsp);
    expect(isTwelveBit(r.data)).toBe(true);
    expect(isTwelveBit(source)).toBe(false);
  });

  test('the attack fades in what is played first, from START, or back from END reversed', async () => {
    const ms10 = 441;
    const r = await renderSample(loaded({ attackMs: 10 }), noResample, dsp);
    expect(Math.abs(r.data[1000])).toBe(0);
    expect(r.data[1000 + 220]).toBeCloseTo(source[1000 + 220] * (220 / ms10), 6);
    expect(r.data.subarray(1000 + ms10)).toEqual(source.subarray(1000 + ms10));
    expect(r.data.subarray(0, 1000)).toEqual(source.subarray(0, 1000));
    const back = await renderSample(loaded({ attackMs: 10 }, { reverse: true }), noResample, dsp);
    expect(Math.abs(back.data[8999])).toBe(0);
    expect(back.data.subarray(0, 8999 - ms10)).toEqual(source.subarray(0, 8999 - ms10));
    // it ends before the loop: 3000 samples there, not 10000
    const long = await renderSample(loaded({ attackMs: 1000 }), noResample, dsp);
    expect(long.data[3999]).not.toBe(source[3999]);
    expect(long.data.subarray(4000)).toEqual(source.subarray(4000));
  });

  test('the crossfade comes before the attack, and fades into the audio as it was', async () => {
    // the loop starts right after START, the crossfade takes what comes before the loop start
    const points = { start: 3900, loopStart: 4000 };
    const both = await renderSample(loaded({ crossfadeMs: 2, attackMs: 2 }, points), noResample, dsp);
    const crossfaded = dsp.crossfadeLoop(source, 4000, 8000, 88, 'linear').data;
    // the end of the loop has what was before the loop start, not the faded in start
    expect(both.data.subarray(7912, 8000)).toEqual(crossfaded.subarray(7912, 8000));
    expect(Math.abs(both.data[3900])).toBe(0);
    // only a forward loop is crossfaded
    const alt = await renderSample(loaded({ crossfadeMs: 2 }, { loopMode: 'alternating' }), noResample, dsp);
    expect(alt.data).toBe(source);
  });

  test('reversed, the crossfade is at the loop start and takes what comes after the loop end', async () => {
    const r = await renderSample(loaded({ crossfadeMs: 2 }, { reverse: true }), noResample, dsp);
    const mirrored = dsp.crossfadeLoop(source.slice().reverse(), 2000, 6000, 88, 'linear').data.reverse();
    expect(r.data).toEqual(mirrored);
    expect(r.data.subarray(4088)).toEqual(source.subarray(4088));
  });

  test('resampling moves the points to the same times, and is done from the original', async () => {
    calls.length = 0;
    const r = await renderSample(loaded({ resampleTo: 22050 }), pick, dsp);
    expect(calls).toEqual([[44100, 22050]]);
    expect(r).toMatchObject({ rate: 22050, start: 500, end: 4500, loopStart: 2000, loopEnd: 4000 });
    expect(r.data.length).toBe(5000);
    // the points are in the rendered audio's samples: from 22050 to another rate, the original is resampled again
    const again = await renderSample(loaded({ resampleTo: BW16.rate }, { ...r, data: r.data }), pick, dsp);
    expect(calls[1]).toEqual([44100, BW16.rate]);
    expect(again.rate).toBe(BW16.rate);
    expect(again.loopEnd).toBe(Math.round((4000 * BW16.rate) / 22050));
    // back to the original's own rate
    const own = await renderSample(loaded({}, { ...r }), noResample, dsp);
    expect(own).toMatchObject({ rate: 44100, start: 1000, end: 9000, loopStart: 4000, loopEnd: 8000 });
    expect(own.data).toBe(source);
    // a point at the very end stays there through rates that don't divide evenly
    const whole = { end: 10000, loopEnd: 10000 };
    const odd = await renderSample(loaded({ resampleTo: 19777.7 }, whole), pick, dsp);
    expect(odd).toMatchObject({ end: odd.data.length, loopEnd: odd.data.length });
    const backAgain = await renderSample(loaded({}, { ...odd }), noResample, dsp);
    expect(backAgain).toMatchObject({ end: 10000, loopEnd: 10000 });
  });

  test('a sample from the sampler is rendered as it came, whatever its recipe says', async () => {
    const r = await renderSample(loaded({ normalize: true, attackMs: 50, crossfadeMs: 5, resampleTo: 22050 },
      { fromSampler: true }), noResample, dsp);
    expect(r.data).toBe(source);
    expect(r.rate).toBe(44100);
  });

  test('the render key changes with what the audio depends on, not with the name or sound', () => {
    const s = loaded();
    const key = renderKey(s);
    expect(renderKey({ ...s, name: 'X', sound: { ...defaultSound(), filter: 3 } })).toBe(key);
    expect(renderKey({ ...s, loopEnd: 7000 })).not.toBe(key);
    expect(renderKey({ ...s, recipe: { ...s.recipe, attackMs: 3 } })).not.toBe(key);
    // from the sampler, the recipe doesn't count
    const received = { ...s, fromSampler: true };
    expect(renderKey({ ...received, recipe: { ...s.recipe, attackMs: 3 } })).toBe(renderKey(received));
  });
});

describe('writing the edits', () => {
  test('the rendered audio becomes the original, only START (or a loop start before it) to END of it', () => {
    const data = Float32Array.from({ length: 1000 }, (_, i) => i / 1000);
    const rendered = { data, rate: 22199.53, start: 300, end: 900, loopStart: 100, loopEnd: 800 };
    const looped = writtenEdits(rendered, { loopMode: 'forward' });
    expect(looped).toMatchObject({ sourceRate: 22199.53, rate: 22199.53, start: 200, end: 800, loopStart: 0,
      loopEnd: 700, recipe: plainRecipe() });
    expect(looped.data).toEqual(data.slice(100, 900));
    expect(looped.source).toBe(looped.data);
    // a one shot from START, its loop points kept inside
    const oneShot = writtenEdits(rendered, { loopMode: 'off' });
    expect(oneShot).toMatchObject({ start: 0, end: 600, loopStart: 0, loopEnd: 500 });
    expect(oneShot.data[0]).toBe(data[300]);
  });
});
