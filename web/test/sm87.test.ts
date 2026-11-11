// SM-87's banks (model/sm87.ts): DRUMS and SAMPLES made, kept, and made into SM-87's samples and drum kit by the
// rules of its documentation/sample-bank.md; and src/sm87/sm87bank.js the same as SM-87's own, when that repository
// is beside this one.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { BW16, encodeSamples } from '../src/protocol/akai';
import { sampleParamsBytes } from '../src/protocol/sprm';
import { defaultSound, newBank, newKeygroup, normalizeBank } from '../src/model/mapping';
import { memoryToZip, zipToMemory } from '../src/model/memory';
import { plainRecipe } from '../src/model/recipe';
import { samplerImage } from '../src/model/s700';
import {
  SM87_DRUMS, SM87_ROOM_TODAY, drumName, drumTune, isDrum, newSm87Banks, samplerPoints, sm87Bank, sm87Contents,
  sm87Size, sm87Taken,
} from '../src/model/sm87';
import { Store } from '../src/model/store';
import type { Keygroup, Sample } from '../src/model/types';
import { HR16_DRUMS, NO_SOUND, hr16Pads, makeBank, readBank } from '../src/sm87/sm87bank.js';
import { testSine } from './helpers';

const noResampling = async (): Promise<Float32Array> => {
  throw new Error('no resampling: the samples are at a sampler rate');
};

const sample = (id: string, overrides: Partial<Sample> = {}): Sample => {
  const data = overrides.data ?? Float32Array.from(testSine());
  return { id, name: id.toUpperCase(), source: data, sourceRate: BW16.rate, recipe: plainRecipe(), fromSampler: false,
    rate: BW16.rate, data, start: 0, end: data.length, loopStart: 0, loopEnd: data.length, loopMode: 'off',
    reverse: false, sound: defaultSound(), bankId: null, slot: null, keygroups: [], ...overrides };
};

const kg = (sampleId: string, program: number, init: Partial<Keygroup> = {}) => newKeygroup(sampleId, program, init);

describe('SM-87', () => {
  test('its sm87bank.js is SM-87\'s', () => {
    for (const f of ['sm87bank.js', 'sm87bank.d.ts']) {
      const theirs = new URL(`../../../sm-87/web/${f}`, import.meta.url);
      if (existsSync(theirs)) {
        expect(readFileSync(new URL(`../src/sm87/${f}`, import.meta.url), 'utf8'), f)
          .toBe(readFileSync(theirs, 'utf8'));
      }
    }
  });

  test('its banks: DRUMS with the HR-16\'s drums as P1-P16, SAMPLES', () => {
    const [drums, samples] = newSm87Banks();
    expect(drums.sm87).toBe('drums');
    expect(samples.sm87).toBe('samples');
    expect(drums.programs.slice(0, 16).map((p) => p.name)).toEqual(HR16_DRUMS.map((d) => d.drum));
    expect(drums.programs[0].name).toBe('KICK');
    expect(drums.programs[3].name).toBe('MID HAT');
    expect(drums.programs[16].name).toBe('NOT A DRUM');
    expect(drums.programs.slice(0, 16).every((p) => p.pan === 0)).toBe(true);
    expect([isDrum(drums, 0), isDrum(drums, 15), isDrum(drums, 16), isDrum(samples, 0)]).toEqual([true, true, false,
      false]);
    expect([drumName(drums, 4), drumName(drums, 20)]).toEqual(['OPN HAT', null]);

    const store = new Store();
    expect(store.addSm87Banks().map((b) => b.name)).toEqual(['DRUMS', 'SAMPLES']);
    expect(store.bank.sm87).toBe('drums');
    expect(store.banks.length).toBe(3);
    store.selectBank(0);
    expect(store.addSm87Banks()).toEqual([]);
    expect(store.banks.length).toBe(3);
    expect(store.bank.name).toBe('DRUMS');
    store.updateProgram({ pan: -2 });
    expect(store.bank.programs[0].pan).toBe(-2);
  });

  test('a bank keeps its role and pans: in storage and memory files; one that has none has none', () => {
    const [drums, samples] = newSm87Banks();
    drums.programs[5].pan = 3;
    const back = JSON.parse(JSON.stringify([drums, samples, newBank('X')])).map(normalizeBank);
    expect(back.map((b: { sm87?: string }) => b.sm87)).toEqual(['drums', 'samples', undefined]);
    expect(back[0].programs[5].pan).toBe(3);
    expect('pan' in back[2].programs[0]).toBe(false);
    expect(normalizeBank({ ...drums, sm87: 'other' as never }).sm87).toBeUndefined();
    const odd = normalizeBank({ ...drums, programs: [{ id: 'p', name: 'P', pan: 9 }] });
    expect('pan' in odd.programs[0]).toBe(false);
    const memory = zipToMemory(memoryToZip({ samples: [], banks: [drums, samples], bankIndex: 0, programIndex: 0 }));
    expect(memory.banks.map((b) => b.sm87)).toEqual(['drums', 'samples']);
    expect(memory.banks[0].programs[5].pan).toBe(3);
  });

  test('the drum\'s tuning: as C3 plays it, from ROOT and SEMI; PITCH FIXED: SEMI only', () => {
    expect(drumTune(kg('a', 0))).toBe(0);
    expect(drumTune(kg('a', 0, { root: 62 }))).toBe(-2);
    expect(drumTune(kg('a', 0, { root: 55, semitones: 3 }))).toBe(8);
    expect(drumTune(kg('a', 0, { root: 40, semitones: 3, fixedPitch: true }))).toBe(3);
  });

  /** a memory with SM-87's banks: samples A (slot 1) and B (slot 4) in SAMPLES, C and D drums */
  function memory() {
    const [drums, samplesBank] = newSm87Banks();
    const other = newBank('OTHER');
    const a = sample('a', { bankId: samplesBank.id, slot: 0, keygroups: [kg('a', 0, { low: 36, high: 60 })] });
    const b = sample('b', { bankId: samplesBank.id, slot: 3, loopMode: 'forward', loopStart: 1000, loopEnd: 5000,
      sound: { ...defaultSound(), pressure: 40 }, keygroups: [kg('b', 1)] });
    const elsewhere = sample('e', { bankId: other.id, slot: 1, keygroups: [kg('e', 0)] });
    // C: KICK at its pitch, SNARE two down (ROOT D3) and up one, TOM1 with two keygroups, P20 not a drum
    const c = sample('c', { bankId: drums.id, slot: 0, start: 100, end: 3100,
      sound: { ...defaultSound(), level: 77, velLevel: 33 },
      keygroups: [kg('c', 0), kg('c', 1, { root: 62, semitones: 1 }), kg('c', 8), kg('c', 8, { root: 50 }),
        kg('c', 19)] });
    // D, reversed: the CLS HAT, PITCH FIXED up 3; the MID HAT tuned past 24 and with a FINE
    const d = sample('d', { bankId: drums.id, slot: 1, start: 500, end: 2500, reverse: true,
      keygroups: [kg('d', 2, { fixedPitch: true, semitones: 3 }), kg('d', 3, { root: 20, cents: 10 })] });
    drums.programs[3].pan = -2;
    return { banks: [other, drums, samplesBank], samples: [a, b, elsewhere, c, d], drums, samplesBank };
  }

  test('the SAMPLES bank\'s samples: in their slots, as the sampler keeps them up to END', async () => {
    const m = memory();
    const { samples } = await sm87Contents(m.banks, m.samples, noResampling);
    expect(samples.map((s) => [s.slot, s.name])).toEqual([[0, 'A'], [3, 'B']]);
    const [a, b] = m.samples;
    const codes = encodeSamples(a.data);
    expect(samples[0].words).toEqual(Uint16Array.from(codes));
    // B loops: the sampler's END is its loop end
    expect(samples[1].words).toEqual(Uint16Array.from(codes.subarray(0, 5000)));
    expect(samples[1].pressure).toBe(40);
    expect(samples[0].params).toEqual(sampleParamsBytes((await samplerImage(a, noResampling, 'x')).params));
    expect(samples[1].params).toEqual(sampleParamsBytes((await samplerImage(b, noResampling, 'x')).params));
    expect(samples[0].params[0]).toBe(36);   // P1: keys 36-60
    expect(samples[0].params[1]).toBe(60);
  });

  test('the DRUMS bank: a kit, its sounds START to END, the pads in SM-87\'s order', async () => {
    const m = memory();
    const { kit, notes } = await sm87Contents(m.banks, m.samples, noResampling);
    expect(kit).not.toBeNull();
    const c = m.samples[3];
    const d = m.samples[4];
    // C's sound, named after its first drum; D's reversed as it plays
    expect(kit!.sounds.map((s) => [s.name, s.rate, s.vel, s.words.length])).toEqual([['KICK', 76, 33, 3000],
      ['CLHAT', 76, 50, 2000]]);
    expect(kit!.sounds[0].words).toEqual(Uint16Array.from(encodeSamples(c.data).subarray(100, 3100)));
    expect(kit!.sounds[1].words).toEqual(Uint16Array.from(encodeSamples(d.data.slice().reverse())
      .subarray(d.data.length - 2500, d.data.length - 500)));
    const pads = kit!.pads;
    expect(pads.length).toBe(SM87_DRUMS);
    const by = (name: string) => pads.find((p) => p.name === name)!;
    expect(pads[0]).toMatchObject({ name: 'KICK', sound: 0, tune: 0, level: 77, pan: 0, note: 36 });
    expect(pads[1]).toMatchObject({ name: 'SNARE', sound: 0, tune: -1, note: 38 });
    expect(pads[2]).toMatchObject({ name: 'CLHAT', sound: 1, tune: 3, group: 1 });
    expect(pads[6]).toMatchObject({ name: 'MDHAT', sound: 1, tune: 24, pan: -2, group: 1 });
    expect(by('TOM1')).toMatchObject({ sound: 0, tune: 0 });
    expect(by('CRASH')).toMatchObject({ sound: NO_SOUND, poly: 2 });
    expect(notes).toEqual(expect.arrayContaining([
      'TOM1: 2 keygroups, a drum plays its first one',
      'MID HAT: tuned +40, a drum goes to ±24',
      'MID HAT: FINE 10 left out, a drum is tuned in semitones',
      'DRUMS P20: not a drum (P1-P16 are), left out',
    ]));
    // the bank's bytes of them, read back
    const { samples } = await sm87Contents(m.banks, m.samples, noResampling);
    const back = readBank(makeBank(samples, kit))!;
    expect(back.samples.map((s) => s.slot)).toEqual([0, 3]);
    expect(back.kit!.pads[6]).toMatchObject({ name: 'MDHAT', tune: 24, pan: -2 });
    expect(back.kit!.sounds[0].words).toEqual(kit!.sounds[0].words);
  });

  test('the memory they take, without making them: the bytes BUILD IN makes', async () => {
    const m = memory();
    const contents = await sm87Contents(m.banks, m.samples, noResampling);
    const size = sm87Size(m.banks, m.samples);
    expect(size.total).toBe(makeBank(contents.samples, contents.kit).length);
    expect(size.samples).toBe(makeBank(contents.samples).length - 32);
    expect(size.drums).toBe(makeBank([], contents.kit).length - 32);
    expect(size.total).toBeLessThan(SM87_ROOM_TODAY);
    // nothing: the package as built
    expect(sm87Size([newBank('X')], m.samples)).toEqual({ samples: 0, drums: 0, total: 0 });
    // a sample at 44.1 kHz, resampled to the nearest of the sampler's rates (39555.4 Hz) as the browser does it,
    // to a word: here as long as the points say
    const resample = async (data: Float32Array, from: number, to: number) => {
      const n = Math.round((data.length * to) / from);
      return Float32Array.from({ length: n }, (_, i) => data[Math.min(data.length - 1, Math.floor((i * from) / to))]);
    };
    for (const over of [{}, { reverse: true }, { loopMode: 'forward' as const, loopStart: 300, loopEnd: 4000 },
      { start: 1200, end: 5200, reverse: true }]) {
      const x = sample('x', { rate: 44100, sourceRate: 44100, ...over });
      const image = await samplerImage(x, resample, 'x');
      expect(samplerPoints(x), JSON.stringify(over)).toEqual({ start: image.params.start, end: image.params.end });
    }
    // too long for the sampler: from START to END only
    const long = sample('l', { data: new Float32Array(40000), start: 5000, end: 38000 });
    expect(samplerPoints(long)).toEqual({ start: 0, end: 32752 });
  });

  test('a package\'s samples taken back: put into a package again, the same bytes', async () => {
    const m = memory();
    const first = await sm87Contents(m.banks, m.samples, noResampling);
    const bank = makeBank(first.samples, first.kit);
    const [drums, samplesBank] = newSm87Banks();
    const taken = sm87Taken(readBank(bank)!, drums.id, samplesBank.id);
    taken.pans.forEach((pan, i) => {
      drums.programs[i].pan = pan;
    });
    expect(taken.notes).toEqual([]);
    // SAMPLES: A and B in their slots, B looping and with its pressure; DRUMS: C and D (reversed: as it plays), each a
    // sample of its own, the drums' keygroups tuned with SEMI
    const inSamples = taken.samples.filter((s) => s.bankId === samplesBank.id);
    expect(inSamples.map((s) => [s.name, s.slot, s.loopMode, s.sound.pressure])).toEqual([['A', 0, 'off', 0],
      ['B', 3, 'forward', 40]]);
    const inDrums = taken.samples.filter((s) => s.bankId === drums.id);
    expect(inDrums.map((s) => [s.name, s.slot, s.loopMode, s.sound.level, s.sound.velLevel, s.fromSampler]))
      .toEqual([['KICK', 0, 'drum', 77, 33, true], ['CLHAT', 1, 'drum', 80, 50, true]]);
    expect(inDrums[0].keygroups.map((k) => [k.program, k.root, k.semitones])).toEqual([[0, 60, 0], [1, 60, -1],
      [8, 60, 0]]);
    expect(inDrums[1].keygroups.map((k) => [k.program, k.semitones])).toEqual([[2, 3], [3, 24]]);
    expect(drums.programs[3].pan).toBe(-2);
    const again = await sm87Contents([drums, samplesBank], taken.samples, noResampling);
    expect(makeBank(again.samples, again.kit)).toEqual(bank);
    expect(sm87Size([drums, samplesBank], taken.samples).total).toBe(bank.length);
  });

  test('what a drum here can\'t be is left out, and said: a slot on a pad, two levels of a sound, a pad of its own',
    () => {
      const words = Uint16Array.from({ length: 300 }, (_, i) => 2048 + ((i * 37) % 400) - 200);
      const byDrum = new Array(16).fill(null);
      byDrum[0] = { sound: 0, level: 90 };
      byDrum[1] = { sound: 0, level: 60 };                  // the kick's sound at another level
      byDrum[2] = { sound: 3 + 4 };                         // sampler slot 5
      const pads = hr16Pads(byDrum);
      pads[0] = { ...pads[0], name: 'BD', note: 35 };       // a pad of its own
      const kit = { sounds: [{ name: 'BOOM', words, rate: 60, vel: 20 }, { name: 'SPARE', words, rate: 60 },
        { name: 'X', words, rate: 50 }], pads };
      const held = readBank(makeBank([], kit))!;
      const [drums, samplesBank] = newSm87Banks();
      const taken = sm87Taken(held, drums.id, samplesBank.id);
      expect(taken.samples.map((s) => [s.name, s.sound.level, s.keygroups.map((k) => k.program)]))
        .toEqual([['BOOM', 90, [0, 1]]]);
      expect(taken.samples[0].data[0]).toBeCloseTo((words[0] - 2048) / 2048, 6);
      expect(taken.samples[0].rate).toBeCloseTo(26400 * 2 ** (-9 / 12), 0);
      expect(taken.notes).toEqual([
        'KICK: SM-87\'s pad 1 (BD, note 35) is the HR-16\'s KICK here, its name, note, group and voices the HR-16 '
          + 'drum\'s',
        'SNARE: level 60 on SM-87; it plays BOOM as KICK does, at its LEVEL 90 (a drum has its sample\'s)',
        'CLS HAT: SM-87 plays sampler slot 5 on it, a drum here plays a sample of DRUMS: left out',
        'The kit\'s sound SPARE: no drum plays it, left out',
        'The kit\'s sound X: no drum plays it, left out',
      ]);
    });

  test('taken into the store: what DRUMS and SAMPLES held goes to no bank, names kept apart, pans set', async () => {
    const store = new Store();
    store.addSm87Banks();
    const drums = sm87Bank(store.banks, 'drums')!;
    const samplesBank = sm87Bank(store.banks, 'samples')!;
    const before = sample('old', { name: 'A' });
    store.addSample(before, samplesBank, 0);
    const m = memory();
    const first = await sm87Contents(m.banks, m.samples, noResampling);
    const taken = sm87Taken(readBank(makeBank(first.samples, first.kit))!, drums.id, samplesBank.id);
    store.takeSm87(taken.samples, taken.pans);
    expect(store.samples.get('old')!.bankId).toBeNull();
    expect(store.samplesIn(samplesBank).map((s) => s.name)).toEqual(['A 2', 'B']);
    expect(store.samplesIn(drums).map((s) => s.name)).toEqual(['KICK', 'CLHAT']);
    expect(drums.programs[3].pan).toBe(-2);
    expect(store.programsOf(drums)[1].keygroups[0].semitones).toBe(-1);
  });

  test('no drum: no kit (the firmware\'s own plays); no SM-87 banks: nothing', async () => {
    const m = memory();
    const kitless = m.samples.filter((s) => s.bankId !== m.drums.id);
    const got = await sm87Contents(m.banks, kitless, noResampling);
    expect(got.kit).toBeNull();
    expect(got.samples.length).toBe(2);
    const none = await sm87Contents([newBank('X')], m.samples, noResampling);
    expect(none).toEqual({ samples: [], kit: null, notes: [] });
    expect(sm87Bank(m.banks, 'drums')).toBe(m.drums);
  });
});
