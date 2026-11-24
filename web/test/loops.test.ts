import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, test } from 'vitest';
import { Dsp } from '../src/audio/dsp';
import { LOOP_SHRINK, loopSearch } from '../src/model/loops';

// built by npm run engine (npm test runs it first)
let dsp: Dsp;
beforeAll(async () => {
  dsp = await Dsp.load(readFileSync(new URL('../public/engine.wasm', import.meta.url)));
});

const rate = 39555.4;
const looped = { loopMode: 'forward' as const, loopStart: 4000, loopEnd: 24000, start: 0, rate };

describe('FIND LOOP', () => {
  test('looks inside the loop for one at most 90% as long', () => {
    expect(loopSearch(looped)).toEqual({ lo: 4000, hi: 24000, minLen: 396, maxLen: 20000 * LOOP_SHRINK, minEnd: 0 });
    // START in the loop: the loop ends after it
    expect(loopSearch({ ...looped, start: 10000 })).toMatchObject({ minEnd: 10002 });
    expect(loopSearch({ ...looped, loopMode: 'off' })).toEqual({ why: 'NOT LOOPED' });
    expect(loopSearch({ ...looped, loopMode: 'drum' })).toEqual({ why: 'NOT LOOPED' });
    expect(loopSearch({ ...looped, loopMode: 'alternating' })).toEqual({ why: 'ALTERNATING' });
    expect(loopSearch({ ...looped, loopEnd: 4400 })).toEqual({ why: 'TOO SHORT' });
  });

  test('finds a smooth loop of whole cycles, smaller each time', () => {
    // 50 samples a cycle, steady
    const data = Float32Array.from({ length: 30000 }, (_, i) => 0.7 * Math.sin((2 * Math.PI * i) / 50)
      + 0.2 * Math.sin((6 * Math.PI * i) / 50 + 0.5));
    let loop = { ...looped };
    for (let n = 0; n < 3; n++) {
      const search = loopSearch(loop);
      if ('why' in search) {
        throw new Error(search.why);
      }
      const found = dsp.findLoop(data, search.lo, search.hi, search.minLen, search.maxLen, search.minEnd, rate);
      expect(found).not.toBeNull();
      const { start, end, seamDb, stepDb, swingDb } = found!;
      expect(start).toBeGreaterThanOrEqual(loop.loopStart);
      expect(end).toBeLessThanOrEqual(loop.loopEnd);
      expect(end - start).toBeLessThanOrEqual(search.maxLen);
      expect(end - start).toBeGreaterThan(search.maxLen * 0.97); // about as long as allowed
      expect((end - start) % 50).toBe(0);
      expect(seamDb).toBeLessThan(-60);
      expect(stepDb).toBeLessThan(0.3);
      expect(swingDb).toBeLessThan(0.5);
      loop = { ...loop, loopStart: start, loopEnd: end };
    }
    expect(dsp.findLoop(data, 0, 100, 16, 90, 0, rate)).toBeNull();
  });
});
