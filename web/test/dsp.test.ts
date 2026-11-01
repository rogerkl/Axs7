import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { Dsp, crossfadeRoom, maxCrossfade } from '../src/audio/dsp';

// built by npm run engine (npm test runs it first)
let dsp: Dsp;
beforeAll(async () => {
  dsp = await Dsp.load(readFileSync(new URL('../public/engine.wasm', import.meta.url)));
});

const sine = (n: number, period: number) => Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * i) / period));

describe('crossfade loop in Rust', () => {
  test('the loop end continues into the start, the original stays as it was', () => {
    const original = sine(4000, 89.9);
    const copy = original.slice();
    const r = dsp.crossfadeLoop(original, 1000, 2000, 300, 'linear');
    expect(r.length).toBe(300);
    expect(original).toEqual(copy);
    expect(r.data[1999]).toBe(original[999]);
    expect(Math.abs(r.data[1000] - r.data[1999])).toBeCloseTo(Math.abs(original[1000] - original[999]), 6);
    expect(r.data.subarray(0, 1700)).toEqual(original.subarray(0, 1700));
  });

  test('length is limited to what the loop has room for, the same in TypeScript', () => {
    const data = new Float32Array(100);
    for (const [start, end] of [[10, 90], [60, 90], [0, 90], [50, 101], [90, 50]]) {
      expect(dsp.crossfadeLoop(data, start, end, 50, 'equal').length).toBe(Math.min(50, maxCrossfade(100, start, end)));
    }
  });

  test('reversed, the room is after the loop end', () => {
    const data = new Float32Array(1000);
    expect(crossfadeRoom({ data, loopStart: 100, loopEnd: 900, reverse: false })).toBe(100);
    expect(crossfadeRoom({ data, loopStart: 100, loopEnd: 900, reverse: true })).toBe(100);
    expect(crossfadeRoom({ data, loopStart: 300, loopEnd: 950, reverse: true })).toBe(50);
    expect(crossfadeRoom({ data, loopStart: 300, loopEnd: 1000, reverse: true })).toBe(0);
  });

  test('an attack fades in what is played first, forward from START or back from END', () => {
    const data = new Float32Array(10).fill(1);
    const forward = dsp.fadeIn(data, 2, 4, 'linear', false);
    expect(Array.from(forward.data)).toEqual([1, 1, 0, 0.25, 0.5, 0.75, 1, 1, 1, 1]);
    const back = dsp.fadeIn(data, 9, 2, 'curve', true);
    expect(Array.from(back.data)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0.25, 0]);
    expect(Array.from(data)).toEqual(new Array(10).fill(1)); // the original is left as it was
  });

  test('memory is given back', () => {
    const big = new Float32Array(1_000_000);
    dsp.crossfadeLoop(big, 1000, 900_000, 500, 'linear');
    const bytes = dsp.memoryBytes;
    for (let i = 0; i < 20; i++) {
      dsp.crossfadeLoop(big, 1000, 900_000, 500, 'linear');
    }
    expect(dsp.memoryBytes).toBe(bytes);
  });
});
