import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, test } from 'vitest';
import { BW16, MAX_SAMPLES, decodeHeader, encodeSamples, parseDump, samplerBandwidth } from '../src/protocol/akai';
import { encodeWav, readWav } from '../src/protocol/wav';
import { memoryToZip, zipToMemory } from '../src/model/memory';
import { dumpFromSample, sampleFromDump, sampleFromWav, samplerFit } from '../src/model/convert';
import { defaultSound, newBank, newKeygroup, newProgram, normalizeProgram, voicesFor } from '../src/model/mapping';
import { noteName, parseNote } from '../src/model/notes';
import { cutoffHz, engineParams, lfoRate, releaseTime } from '../src/model/params';
import { isPortion, movePoint, normalizeSample, usedStart } from '../src/model/points';
import { attackRoom, isTwelveBit, normalizeData, portionPeak, quantize12Data, to12BitCode } from '../src/model/edit';
import { isEdited, plainRecipe } from '../src/model/recipe';
import { Store } from '../src/model/store';
import type { Program, Sample } from '../src/model/types';
import { fixture, testSine } from './helpers';

const sample = (overrides: Partial<Sample> = {}): Sample => {
  const data = overrides.data ?? Float32Array.from(testSine());
  const rate = overrides.rate ?? BW16.rate;
  return { id: 's1', name: 'SINE', source: data, sourceRate: rate, recipe: plainRecipe(), fromSampler: false, rate,
    data, start: 0, end: data.length, loopStart: 0, loopEnd: 5900, loopMode: 'forward', reverse: false,
    sound: defaultSound(), ...overrides };
};

describe('notes', () => {
  test('C3 is MIDI 60 as on the sampler', () => {
    expect(noteName(60)).toBe('C3');
    expect(noteName(36)).toBe('C1');
    expect(noteName(0)).toBe('C-2');
    expect(parseNote('C3')).toBe(60);
    expect(parseNote('f#1')).toBe(42);
    expect(parseNote('Bb2')).toBe(58);
    expect(parseNote('61')).toBe(61);
    expect(parseNote('H2')).toBeNull();
  });
});

describe('params', () => {
  test('a sample\'s 0-99 sound to physical units, in the engine\'s layout', () => {
    expect(releaseTime(0)).toBeCloseTo(0.005);
    expect(releaseTime(99)).toBeCloseTo(10.005);
    expect(cutoffHz(99)).toBeCloseTo(20000);
    expect(cutoffHz(0)).toBeCloseTo(20);
    expect(lfoRate(0)).toBeCloseTo(0.5);
    expect(lfoRate(99)).toBeCloseTo(20);
    const p = engineParams({ ...defaultSound(), velFilter: 99, lfoDepth: 99, lfoDelay: 99, pressure: 50 });
    expect(p.length).toBe(16);
    expect(p[0]).toBeCloseTo((80 / 99) ** 2); // level
    expect(p[2]).toBeCloseTo(20000); // cutoff, open by default
    expect(p[3]).toBeCloseTo(6); // octaves the cutoff rises at full velocity
    expect(p[7]).toBeCloseTo(1); // a semitone of vibrato
    expect(p[8]).toBeCloseTo(4); // seconds before it
    expect(p[9]).toBeCloseTo((50 / 99) ** 2); // semitones of vibrato at full aftertouch
    expect(defaultSound().pressure).toBe(0);
  });
});

describe('keygroups', () => {
  test('notes play the keygroups covering them, at the pitch from the root key', () => {
    const program = newProgram('P');
    const samples = new Map([['a', sample({ id: 'a' })], ['b', sample({ id: 'b' })]]);
    program.keygroups.push(
      newKeygroup('a', { low: 36, high: 59, root: 48 }),
      newKeygroup('b', { low: 60, high: 96, root: 60, semitones: 12, cents: 50 }),
      newKeygroup(null, { low: 0, high: 127 }), // no sample, plays nothing
      newKeygroup('missing'),
    );
    expect(voicesFor(program, samples, 30)).toEqual([]);
    const [low] = voicesFor(program, samples, 60 - 12);
    expect(low.sample.id).toBe('a');
    expect(low.ratio).toBe(1);
    const [high] = voicesFor(program, samples, 72);
    expect(high.sample.id).toBe('b');
    expect(high.ratio).toBeCloseTo(2 ** (24.5 / 12));
    expect(high.gain).toBe(1); // the level is the sample's
  });

  test('constant pitch plays every key at the root\'s pitch, transposed and tuned', () => {
    const program = newProgram('P');
    program.keygroups.push(newKeygroup('a', { root: 50, semitones: 2, fixedPitch: true }));
    const samples = new Map([['a', sample({ id: 'a' })]]);
    for (const note of [36, 50, 90]) {
      expect(voicesFor(program, samples, note)[0].ratio).toBeCloseTo(2 ** (2 / 12));
    }
  });

  test('programs from before the sound moved to the samples lose it, and keygroups their level', () => {
    const old = { id: 'p', name: 'OLD', cutoff: 64, ampEnv: { attack: 1 },
      keygroups: [{ id: 'k', sampleId: 's1', low: 36, high: 60, root: 48, semitones: 0, cents: 5, level: 70 }] };
    expect(normalizeProgram(old as never)).toEqual({ id: 'p', name: 'OLD', keygroups: [
      { id: 'k', sampleId: 's1', low: 36, high: 60, root: 48, semitones: 0, cents: 5, fixedPitch: false }] });
    const oldSample = { ...sample(), sound: undefined } as unknown as Sample;
    expect(normalizeSample(oldSample).sound).toEqual(defaultSound());
  });
});

describe('store', () => {
  test('a program without keygroups gets one for the first sample', () => {
    const store = new Store();
    const events: string[] = [];
    for (const e of ['samples', 'keygroups', 'program', 'selection'] as const) {
      store.on(e, () => events.push(e));
    }
    store.addSample(sample());
    expect(store.program.keygroups).toHaveLength(1);
    expect(store.program.keygroups[0]).toMatchObject({ sampleId: 's1', low: 0, high: 127, root: 60 });
    expect(store.selectedSampleId).toBe('s1');
    expect(events).toContain('keygroups');
    store.addSample(sample({ id: 's2' }));
    expect(store.program.keygroups).toHaveLength(1);
  });

  test('removing a sample leaves its keygroups without one, and its slots empty, in every bank', () => {
    const store = new Store();
    store.addSample(sample());
    store.addSample(sample({ id: 's2' }));
    store.setSlot(3, 's1');
    store.addBank();
    store.addSampleToSlot(store.samples.get('s1')!, 0, null);
    store.removeSample('s1');
    expect(store.banks.map((b) => [b.programs[0].keygroups[0].sampleId, b.slots[0], b.slots[3]]))
      .toEqual([[null, null, null], [null, null, null]]);
    expect(store.selectedSampleId).toBe('s2');
  });

  test('a received sample goes in the bank\'s slot, with the key ranges the sampler sent, the slot\'s sample before out', () => {
    const store = new Store();
    const range = { low: 36, high: 59, root: 48, semitones: 0, cents: 0, fixedPitch: false };
    const ranges = (...at: number[]) => Array.from({ length: 32 }, (_, i) => (at.includes(i) ? range : null));
    store.addSampleToSlot(sample({ id: 'a' }), 2, ranges(0, 3));
    store.addSampleToSlot(sample({ id: 'b' }), 5, ranges(3));
    expect(store.bank.slots.slice(0, 6)).toEqual([null, null, 'a', null, null, 'b']);
    const inPrograms = () => store.programs.slice(0, 4).map((p) => p.keygroups.map((k) => k.sampleId));
    expect(inPrograms()).toEqual([['a'], [], [], ['a', 'b']]);
    // slot 3 again: the sampler sent other key ranges for it
    store.addSampleToSlot(sample({ id: 'c' }), 2, ranges(1));
    expect(inPrograms()).toEqual([[], ['c'], [], ['b']]);
    expect(store.samples.has('a')).toBe(true);
    // without the sampler's parameters: the slot's keygroups, now with the new sample
    store.addSampleToSlot(sample({ id: 'd' }), 2, null);
    expect(inPrograms()).toEqual([[], ['d'], [], ['b']]);
    expect(store.bank.slots[2]).toBe('d');
    // only in the current bank
    store.addBank();
    store.addSampleToSlot(sample({ id: 'e' }), 2, null);
    expect([store.bank.slots[2], store.banks[0].slots[2]]).toEqual(['e', 'd']);
    expect(store.program.keygroups.map((k) => k.sampleId)).toEqual(['e']); // in no program: the empty current one
    // into the bank a receive began in, though another is current now
    store.addSampleToSlot(sample({ id: 'f' }), 4, ranges(0), store.banks[0]);
    expect([store.banks[0].slots[4], store.banks[0].programs[0].keygroups.map((k) => k.sampleId)]).toEqual(['f', ['f']]);
    expect([store.bank.slots[4], store.programs[0].keygroups.map((k) => k.sampleId)]).toEqual([null, ['e']]);
  });

  test('key range stays in order', () => {
    const store = new Store();
    store.addKeygroup(newKeygroup(null, { id: 'k', low: 40, high: 50 }));
    store.updateKeygroup('k', { low: 55 });
    expect(store.selectedKeygroup).toMatchObject({ low: 55, high: 55 });
    store.updateKeygroup('k', { high: 30 });
    expect(store.selectedKeygroup).toMatchObject({ low: 30, high: 30 });
  });

  test('banks of 32 programs, and the same program number in another bank', () => {
    const store = new Store();
    expect(store.programs.map((p) => p.name).slice(30)).toEqual(['PROGRAM 31', 'PROGRAM 32']);
    store.selectProgram(40);
    expect(store.programIndex).toBe(31);
    store.selectProgram(4);
    store.addKeygroup(newKeygroup(null));
    store.addBank();
    expect([store.bankIndex, store.bank.name, store.programIndex, store.program.keygroups]).toEqual([1, 'BANK 2', 4, []]);
    store.selectBank(0);
    expect(store.program.keygroups).toHaveLength(1);
    store.clearProgram();
    expect(store.program.keygroups).toEqual([]);
    store.removeBank();
    store.removeBank();
    expect(store.banks).toHaveLength(1);
    expect(store.uniqueSampleName('A')).toBe('A');
    store.addSample(sample({ name: 'A' }));
    expect(store.uniqueSampleName('A')).toBe('A 2');
  });
});

describe('convert', () => {
  test('a received dump becomes a sample ending at its loop end', () => {
    const s = sampleFromDump(parseDump(fixture('x7000-received.syx')), 'RECEIVED');
    expect(s).toMatchObject({ rate: BW16.rate, loopStart: 0, loopEnd: 32652, loopMode: 'forward' });
    expect(s.data.length).toBe(32652);
  });

  test('a sample at a sampler rate is sent as the Java version sends it', async () => {
    const noResample = () => Promise.reject(new Error('should not resample'));
    const { dump, notes } = await dumpFromSample(sample({ data: Float32Array.from(testSine()) }),
      { slot: 0 }, noResample);
    expect(notes).toEqual(['The sampler ends the sample at the loop end, it drops the rest']);
    // the float32 data encodes to the same codes as the Java doubles nearly everywhere
    const sent = parseDump(dump.bytes).codes!.subarray(0, 6000);
    const java = encodeSamples(testSine(), 1);
    expect(sent.filter((c, i) => c !== java[i]).length).toBeLessThan(10);
    expect(decodeHeader(dump.bytes)).toMatchObject({ period: 25281, loopStart: 0, loopEnd: 5900, totalWords: 6200 });
  });

  test('other rates are resampled, loops scaled, long samples truncated, one shots marked', async () => {
    const calls: number[][] = [];
    const resample = async (data: Float32Array, from: number, to: number) => {
      calls.push([from, to]);
      return new Float32Array(Math.round((data.length * to) / from));
    };
    const s = sample({ rate: 44100, data: new Float32Array(44100), loopStart: 4410, loopEnd: 44100,
      loopMode: 'alternating' });
    const { dump, notes } = await dumpFromSample(s, { slot: 3 }, resample);
    expect(calls).toEqual([[44100, BW16.rate]]);
    const h = decodeHeader(dump.bytes);
    expect(h).toMatchObject({ slot: 3, period: 25281, totalWords: MAX_SAMPLES, alternating: true });
    expect(h.loopStart).toBe(Math.round(4410 * BW16.rate / 44100));
    expect(h.loopEnd).toBe(MAX_SAMPLES);
    expect(notes[0]).toMatch(/Resampled from 44100/);
    expect(notes[1]).toMatch(/Truncated/);

    const oneShot = await dumpFromSample(sample({ loopMode: 'off' }), { slot: 0 }, resample);
    expect(decodeHeader(oneShot.dump.bytes)).toMatchObject({ loopStart: 6000, loopEnd: 6000 });
  });

  test('wav files keep their rate and loop', () => {
    const wav = readWav(encodeWav(Float32Array.from(testSine()), 22050, [{ start: 10, end: 5000, alternating: true }])
      .buffer as ArrayBuffer)!;
    const s = sampleFromWav(wav, 'X');
    expect(s).toMatchObject({ rate: 22050, loopStart: 10, loopEnd: 5000, loopMode: 'alternating' });
    expect(sampleFromWav({ ...wav, loops: null }, 'X').loopMode).toBe('off');
  });
});

describe('sampler rates and resampling', () => {
  test('which rates are the sampler\'s', () => {
    expect(samplerBandwidth(39555)?.rate).toBe(39555.4);
    expect(samplerBandwidth(22200)?.name).toBe('8.9khz');
    expect(samplerBandwidth(44100)).toBeNull();
    expect(samplerBandwidth(22050)).toBeNull();
  });

  test('a wav at a sampler rate gets the exact rate, whole Hz in the file', () => {
    const wav = (rate: number) => readWav(encodeWav(new Float32Array(10), rate, []).buffer as ArrayBuffer)!;
    expect(sampleFromWav(wav(39555), 'A').rate).toBe(39555.4);
    expect(sampleFromWav(wav(22200), 'A').rate).toBe(22199.53);
    expect(sampleFromWav(wav(44100), 'A').rate).toBe(44100);
  });

  test('a sample fits the sampler if what it keeps does: to the loop end, or all of a one shot', () => {
    const long = sample({ rate: BW16.rate, data: new Float32Array(40000), loopStart: 1000, loopEnd: 30000 });
    expect(samplerFit(long)).toMatchObject({ sendRate: BW16.rate, limit: MAX_SAMPLES, used: 30000, fits: true });
    expect(samplerFit({ ...long, loopEnd: 35000 })).toMatchObject({ used: 35000, fits: false });
    expect(samplerFit({ ...long, loopMode: 'off' })).toMatchObject({ used: 40000, fits: false });
    // 44.1 kHz goes at 39555.4 Hz: the limit in the sample's own samples is further on
    const cd = sample({ rate: 44100, data: new Float32Array(40000), loopMode: 'off' });
    expect(samplerFit(cd)).toMatchObject({ limit: Math.floor((MAX_SAMPLES * 44100) / BW16.rate), fits: false });
    expect(samplerFit(cd).maxSeconds).toBeCloseTo(0.828, 3);
    // at a lower rate it fits
    expect(samplerFit(cd, 22199.53)).toMatchObject({ fits: true });
  });

  test('edits go to the recipe and new audio comes as its own event, keygroups keep the sample', () => {
    const store = new Store();
    store.addSample(sample());
    const events: string[] = [];
    store.on('sample', (id) => events.push(`sample ${id}`));
    store.on('audio', (id) => events.push(`audio ${id}`));
    store.on('samples', () => events.push('samples'));
    store.updateRecipe('s1', { normalize: true, attackMs: 20 });
    expect(isEdited(store.samples.get('s1')!.recipe)).toBe(true);
    store.setRendered('s1', { data: new Float32Array(10), rate: 22199.53, start: 0, end: 10, loopStart: 1, loopEnd: 9 });
    expect(events).toEqual(['sample s1', 'audio s1']);
    expect(store.samples.get('s1')).toMatchObject({ rate: 22199.53, loopStart: 1, loopEnd: 9, name: 'SINE',
      sourceRate: BW16.rate });
    expect(store.samples.get('s1')!.source.length).toBe(6000); // the original stays
    expect(store.program.keygroups[0].sampleId).toBe('s1');
  });

  test('a sample from the sampler takes no edits', () => {
    const store = new Store();
    store.addSample(sample({ fromSampler: true }));
    store.updateRecipe('s1', { normalize: true });
    expect(store.samples.get('s1')!.recipe).toEqual(plainRecipe());
  });
});

describe('start and end points', () => {
  const s = () => sample({ data: new Float32Array(1000), start: 100, end: 900, loopStart: 300, loopEnd: 700 });

  test('the loop stops at END, its end at START, its start may be before START', () => {
    expect(movePoint(s(), 'loopStart', 50)).toMatchObject({ start: 100, loopStart: 50 });
    expect(movePoint(s(), 'loopStart', -5)).toMatchObject({ loopStart: 0 });
    expect(movePoint(s(), 'loopEnd', 950)).toMatchObject({ loopEnd: 900 });
    expect(movePoint(s(), 'loopStart', 800)).toMatchObject({ loopStart: 698, loopEnd: 700 });
    expect(movePoint({ ...s(), start: 500 }, 'loopEnd', 300)).toMatchObject({ loopStart: 300, loopEnd: 502 });
  });

  test('START goes into the loop as on the X7000, past its end it pushes it; END pushes the loop back', () => {
    expect(movePoint(s(), 'start', 400)).toEqual({ start: 400, end: 900, loopStart: 300, loopEnd: 700 });
    expect(movePoint(s(), 'start', 800)).toEqual({ start: 800, end: 900, loopStart: 300, loopEnd: 802 });
    expect(movePoint(s(), 'end', 200)).toEqual({ start: 100, end: 200, loopStart: 198, loopEnd: 200 });
    expect(movePoint(s(), 'end', 5000)).toMatchObject({ end: 1000 });
    expect(movePoint(s(), 'start', -5)).toMatchObject({ start: 0 });
  });

  test('samples from before the points get them', () => {
    const old = { ...s(), start: undefined, end: undefined } as unknown as Sample;
    expect(normalizeSample(old)).toMatchObject({ start: 0, end: 1000, loopStart: 300, loopEnd: 700 });
    expect(isPortion(s())).toBe(true);
    expect(isPortion(old)).toBe(false);
  });

  test('only the part from START to END is sent, the loop counted from START', async () => {
    const data = Float32Array.from(testSine(BW16.rate, 6000));
    const { dump, notes } = await dumpFromSample(sample({ data, start: 1000, end: 5000, loopStart: 2000,
      loopEnd: 4500 }), { slot: 0 }, () => Promise.reject(new Error('no resampling')));
    expect(decodeHeader(dump.bytes)).toMatchObject({ totalWords: 4000 + 200, loopStart: 1000, loopEnd: 3500 });
    expect(parseDump(dump.bytes).codes!.subarray(0, 4000)).toEqual(encodeSamples(data.subarray(1000, 5000)));
    expect(notes[0]).toMatch(/START to END/);
  });

  test('a reversed sample is sent reversed, with its loop mirrored, to play forward on the sampler', async () => {
    const data = Float32Array.from({ length: 6000 }, (_, i) => Math.sin(i / 7) * (i / 6000));
    const s = sample({ data, start: 1000, end: 5000, loopStart: 2000, loopEnd: 3500, reverse: true });
    const { dump, notes } = await dumpFromSample(s, { slot: 0 }, () => Promise.reject(new Error()));
    // 4000 samples sent, the loop 2000-3500 counted back from END: 1500-3000
    expect(decodeHeader(dump.bytes)).toMatchObject({ totalWords: 4200, loopStart: 1500, loopEnd: 3000 });
    const sent = parseDump(dump.bytes).codes!.subarray(0, 4000);
    expect(sent).toEqual(encodeSamples(data.slice(1000, 5000).reverse()));
    expect(notes).toContain('Sent reversed, leave SCAN DIRECTION at F on the sampler');
    // the sampler keeps it from END back to the loop start
    expect(samplerFit(s)).toMatchObject({ used: 3000, limitAt: 5000 - MAX_SAMPLES });
  });

  test('START after the loop start, as on the X7000: what is sent starts at the loop start', async () => {
    // a sample received from the sampler, then START set as it was there
    const data = quantize12Data(Float32Array.from({ length: 32752 }, (_, i) => Math.sin(i / 9) * 0.8));
    let x = sample({ data, loopMode: 'alternating', end: 32752, loopStart: 9523, loopEnd: 32752 });
    x = { ...x, ...movePoint(x, 'start', 32552) };
    expect(x).toMatchObject({ start: 32552, end: 32752, loopStart: 9523, loopEnd: 32752 });
    expect(usedStart(x)).toBe(9523);
    expect(usedStart({ ...x, loopMode: 'off' })).toBe(32552); // a one shot plays from START only
    expect(samplerFit(x)).toMatchObject({ used: 32752 - 9523, fits: true, limitAt: 9523 + MAX_SAMPLES });
    const noResample = () => Promise.reject(new Error('no resampling'));
    const { dump, notes } = await dumpFromSample(x, { slot: 0 }, noResample);
    expect(decodeHeader(dump.bytes)).toMatchObject({ loopStart: 0, loopEnd: 32752 - 9523, alternating: true });
    expect(parseDump(dump.bytes).codes!.subarray(0, 32752 - 9523))
      .toEqual(Uint16Array.from(data.subarray(9523), (v) => Math.round(v * 2048) + 2048));
    expect(notes).toContain('A dump has no START: set START to 23029 on the sampler to play from where it starts here');
    // reversed, playing starts at END, and so does the sampler
    const back = await dumpFromSample({ ...x, reverse: true }, { slot: 0 }, noResample);
    expect(decodeHeader(back.dump.bytes)).toMatchObject({ loopStart: 0, loopEnd: 32752 - 9523 });
    expect(back.notes.some((n) => n.includes('no START'))).toBe(false);
  });

  test('a drum trigger goes to the sampler as a one shot', async () => {
    const drum = sample({ loopMode: 'drum', loopStart: 1000, loopEnd: 5000 });
    expect(samplerFit(drum).used).toBe(6000);
    const { dump } = await dumpFromSample(drum, { slot: 0 }, () => Promise.reject(new Error()));
    expect(decodeHeader(dump.bytes)).toMatchObject({ loopStart: 6000, loopEnd: 6000 });
  });

  test('the fit counts from START', () => {
    const long = sample({ data: new Float32Array(60000), start: 20000, end: 60000, loopStart: 30000,
      loopEnd: 50000 });
    expect(samplerFit(long)).toMatchObject({ used: 30000, fits: true });
    expect(samplerFit({ ...long, start: 0 })).toMatchObject({ used: 50000, fits: false });
  });
});

describe('as sent: normalize, 12 bit, attack', () => {
  test('normalize scales by the peak between START and END', () => {
    const data = Float32Array.of(0.9, 0.1, -0.25, 0.2, 0.05, 0.8);
    expect(portionPeak(data, 1, 5)).toBe(0.25);
    const n = normalizeData(data, 1, 5);
    expect(Array.from(n)).toEqual([1, 0.4000000059604645, -1, 0.800000011920929, 0.20000000298023224, 1]);
    expect(data[0]).toBe(Math.fround(0.9)); // a new array, the original stays
  });

  test('12 bit is the values the sampler has, and is recognized', () => {
    const data = Float32Array.from(testSine(BW16.rate, 1000));
    const q = quantize12Data(data);
    q.forEach((v, i) => expect(v).toBe((encodeSamples([data[i]])[0] - 2048) / 2048));
    expect(isTwelveBit(q)).toBe(true);
    expect(isTwelveBit(data)).toBe(false);
    expect(to12BitCode(1)).toBe(4095);
    expect(to12BitCode(-1)).toBe(1);
  });

  test('a sample received from the sampler goes back bit for bit', async () => {
    const received = parseDump(fixture('x7000-received.syx'));
    const s = sampleFromDump(received, 'BACK');
    expect(s.fromSampler).toBe(true);
    const { dump, notes } = await dumpFromSample(s, { slot: 0 }, () => Promise.reject(new Error()));
    expect(notes).toContain('Already 12 bit, sent as it is');
    expect(parseDump(dump.bytes).codes!.subarray(0, received.codes!.length)).toEqual(received.codes);
  });

  test('the attack has to end before the loop', () => {
    const s = sample({ data: new Float32Array(1000), start: 100, end: 900, loopStart: 300, loopEnd: 700 });
    expect(attackRoom(s)).toBe(200);
    expect(attackRoom({ ...s, reverse: true })).toBe(200);
    expect(attackRoom({ ...s, loopMode: 'off' })).toBe(800);
    expect(attackRoom({ ...s, loopStart: 100 })).toBe(0);
  });
});

describe('wav', () => {
  test('16 bit round trip with smpl loop', () => {
    const data = Float32Array.from(testSine(BW16.rate, 1000));
    const wav = readWav(encodeWav(data, BW16.rate, [{ start: 100, end: 900, alternating: false }]).buffer as ArrayBuffer)!;
    expect(wav.sampleRate).toBe(39555);
    expect(wav.loops).toEqual([{ start: 100, end: 900, alternating: false }]);
    expect(wav.data.length).toBe(1000);
    wav.data.forEach((v, i) => expect(Math.abs(v - data[i])).toBeLessThan(1 / 16000));
  });

  test('12 bit values come back exact, and the axs7 chunk says the sample is from the sampler', () => {
    const data = quantize12Data(Float32Array.from(testSine(BW16.rate, 1000)));
    const bytes = encodeWav(data, BW16.rate, [{ start: 100, end: 900, alternating: false }], { fromSampler: true });
    const wav = readWav(bytes.buffer as ArrayBuffer)!;
    expect(wav.data).toEqual(data);
    expect(wav.meta).toEqual({ fromSampler: true });
    expect(wav.loops).toEqual([{ start: 100, end: 900, alternating: false }]);
    expect(sampleFromWav(wav, 'BACK').fromSampler).toBe(true);
    // odd lengths are padded, the chunks after still read
    const odd = readWav(encodeWav(Float32Array.of(0.5), 8000, [], { fromSampler: true }).buffer as ArrayBuffer)!;
    expect(odd.meta.fromSampler).toBe(true);
    expect(readWav(encodeWav(data, BW16.rate, []).buffer as ArrayBuffer)!.meta).toEqual({});
    expect(isTwelveBit(readWav(encodeWav(Float32Array.of(2047 / 2048, -1), 8000, []).buffer as ArrayBuffer)!.data)).toBe(true);
  });

  test('reads 24 bit stereo and 32 bit float', () => {
    const header = (format: number, channels: number, bits: number, dataBytes: number) => {
      const b = new DataView(new ArrayBuffer(44 + dataBytes));
      const str = (o: number, s: string) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
      str(0, 'RIFF'); b.setUint32(4, 36 + dataBytes, true); str(8, 'WAVE'); str(12, 'fmt ');
      b.setUint32(16, 16, true); b.setUint16(20, format, true); b.setUint16(22, channels, true);
      b.setUint32(24, 48000, true); b.setUint16(34, bits, true); str(36, 'data'); b.setUint32(40, dataBytes, true);
      return b;
    };
    const s24 = header(1, 2, 24, 6);
    // left 0x400000 (0.5), right -0x400000 (-0.5) → mono 0
    [0x00, 0x00, 0x40, 0x00, 0x00, 0xc0].forEach((v, i) => s24.setUint8(44 + i, v));
    expect(Array.from(readWav(s24.buffer)!.data)).toEqual([0]);
    const f32 = header(3, 1, 32, 8);
    f32.setFloat32(44, 0.25, true);
    f32.setFloat32(48, -1, true);
    expect(Array.from(readWav(f32.buffer)!.data)).toEqual([0.25, -1]);
    expect(readWav(new ArrayBuffer(10))).toBeNull();
  });
});

describe('memory file', () => {
  test('zip round trip keeps samples, loops, exact rates, sounds, banks with their programs and slots', () => {
    const banks = [newBank('ONE'), newBank('TWO')];
    const program = banks[1].programs[5];
    program.name = 'BASS ROOT';
    program.keygroups.push(newKeygroup('s1', { low: 36, high: 59, root: 48, cents: 5 }));
    banks[1].slots[2] = 's2';
    const samples = [sample(), sample({ id: 's2', name: 'ONE/SHOT?', loopMode: 'drum', reverse: true, rate: 22199.53,
      start: 40,
      end: 5950, sound: { ...defaultSound(), filter: 64, velFilter: 30, release: 0, lfoDepth: 12 } })];
    const bank = zipToMemory(memoryToZip({ samples, banks, bankIndex: 1, programIndex: 5 }));
    expect([bank.bankIndex, bank.programIndex]).toEqual([1, 5]);
    expect(bank.banks).toEqual(banks);
    expect(bank.samples.map((s) => [s.id, s.name, s.rate, s.loopMode, s.start, s.end, s.loopStart, s.loopEnd]))
      .toEqual([['s1', 'SINE', BW16.rate, 'forward', 0, 6000, 0, 5900],
        ['s2', 'ONE/SHOT?', 22199.53, 'drum', 40, 5950, 0, 5900]]);
    expect(bank.samples[1].sound).toEqual(samples[1].sound);
    expect(bank.samples.map((s) => s.reverse)).toEqual([false, true]);
    expect(bank.samples[0].data.length).toBe(6000);
  });

  test('an edited sample keeps its original and recipe, one from the sampler is marked', () => {
    const source = Float32Array.from(testSine(44100, 8000));
    const edited = sample({ id: 'e', source, sourceRate: 44100, rate: BW16.rate, data: quantize12Data(source.slice(0, 7000)),
      end: 7000, loopEnd: 6000, recipe: { ...plainRecipe(), resampleTo: BW16.rate, twelveBit: true, attackMs: 12 } });
    const received = sample({ id: 'r', fromSampler: true, data: quantize12Data(source) });
    const bank = zipToMemory(memoryToZip({ samples: [edited, received], banks: [newBank('B')], bankIndex: 0,
      programIndex: 0 }));
    const [e, r] = bank.samples;
    expect(e.recipe).toEqual(edited.recipe);
    expect(e).toMatchObject({ sourceRate: 44100, rate: BW16.rate, fromSampler: false, end: 7000 });
    expect(e.source.length).toBe(8000);
    expect(e.data).toEqual(edited.data); // 12 bit, exact
    expect(r.fromSampler).toBe(true);
    expect(r.source).toBe(r.data); // no original of its own, the audio is it
  });

  /** A bank file as versions before banks saved it: bank.json with a list of programs */
  function oldBankFile(version: number, programs: Program[], programIndex: number) {
    const files = unzipSync(memoryToZip({ samples: [sample()], banks: [], bankIndex: 0, programIndex: 0 }));
    const json = JSON.parse(strFromU8(files['memory.json']));
    Object.assign(json, { format: 'axs7-bank', version, programs, programIndex });
    delete json.banks;
    delete json.bankIndex;
    delete files['memory.json'];
    files['bank.json'] = strToU8(JSON.stringify(json));
    return { files, json };
  }

  test('bank files from before banks: their programs 32 to a bank', () => {
    const programs = Array.from({ length: 40 }, (_, i) => newProgram(`OLD ${i + 1}`));
    programs[33].keygroups.push(newKeygroup('s1', { low: 40 }));
    const { files } = oldBankFile(3, programs, 33);
    const memory = zipToMemory(zipSync(files));
    expect(memory.banks.map((b) => [b.name, b.programs.length, b.programs[0].name, b.programs[31].name]))
      .toEqual([['BANK 1', 32, 'OLD 1', 'OLD 32'], ['BANK 2', 32, 'OLD 33', 'PROGRAM 32']]);
    expect([memory.bankIndex, memory.programIndex]).toEqual([1, 1]);
    expect(memory.banks[1].programs[1].keygroups).toMatchObject([{ sampleId: 's1', low: 40 }]);
    expect(memory.banks[1].slots).toEqual(new Array(16).fill(null));
  });

  test('version 2 banks: the audio is the original', () => {
    const { files, json } = oldBankFile(2, [], 0);
    for (const entry of json.samples) {
      delete entry.original;
      delete entry.sourceRate;
      delete entry.recipe;
      delete entry.fromSampler;
    }
    files['bank.json'] = strToU8(JSON.stringify(json));
    const [s] = zipToMemory(zipSync(files)).samples;
    expect(s.source).toBe(s.data);
    expect(s).toMatchObject({ sourceRate: BW16.rate, fromSampler: false, recipe: plainRecipe() });
  });

  test('rejects what is not a memory file', () => {
    expect(() => zipToMemory(new Uint8Array([1, 2, 3]))).toThrow(/zip/);
    const { files } = oldBankFile(9, [], 0);
    expect(() => zipToMemory(zipSync(files))).toThrow(/can read/);
  });
});
