import { describe, expect, test } from 'vitest';
import { BW16, MAX_SAMPLES, decodeHeader, encodeSamples, parseDump, samplerBandwidth } from '../src/protocol/akai';
import { encodeWav, readWav } from '../src/protocol/wav';
import { bankToZip, zipToBank } from '../src/model/bank';
import { dumpFromSample, resampleSample, sampleFromDump, sampleFromWav, samplerFit } from '../src/model/convert';
import { newKeygroup, newProgram, voicesFor } from '../src/model/mapping';
import { noteName, parseNote } from '../src/model/notes';
import { cutoffHz, engineParams, envTime } from '../src/model/params';
import { Store } from '../src/model/store';
import type { Sample } from '../src/model/types';
import { fixture, testSine } from './helpers';

const sample = (overrides: Partial<Sample> = {}): Sample => ({
  id: 's1', name: 'SINE', rate: BW16.rate, data: Float32Array.from(testSine()), loopStart: 0, loopEnd: 5900,
  loopMode: 'forward', ...overrides,
});

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
  test('0-99 to physical units', () => {
    expect(envTime(0)).toBeCloseTo(0.001);
    expect(envTime(99)).toBeCloseTo(10.001);
    expect(cutoffHz(99)).toBeCloseTo(20000);
    expect(cutoffHz(0)).toBeCloseTo(20);
    const p = engineParams(newProgram('P'));
    expect(p.length).toBe(16);
    expect(p[2]).toBeCloseTo(20000); // cutoff fully open
    expect(p[7]).toBe(1); // filter sustain
  });
});

describe('keygroups', () => {
  test('notes play the keygroups covering them, at the pitch from the root key', () => {
    const program = newProgram('P');
    const samples = new Map([['a', sample({ id: 'a' })], ['b', sample({ id: 'b' })]]);
    program.keygroups.push(
      newKeygroup('a', { low: 36, high: 59, root: 48 }),
      newKeygroup('b', { low: 60, high: 96, root: 60, semitones: 12, cents: 50, level: 50 }),
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
    expect(high.gain).toBeCloseTo((50 / 99) ** 2);
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

  test('removing a sample leaves its keygroups without one', () => {
    const store = new Store();
    store.addSample(sample());
    store.addSample(sample({ id: 's2' }));
    store.removeSample('s1');
    expect(store.program.keygroups[0].sampleId).toBeNull();
    expect(store.selectedSampleId).toBe('s2');
  });

  test('key range stays in order', () => {
    const store = new Store();
    store.addKeygroup(newKeygroup(null, { id: 'k', low: 40, high: 50 }));
    store.updateKeygroup('k', { low: 55 });
    expect(store.selectedKeygroup).toMatchObject({ low: 55, high: 55 });
    store.updateKeygroup('k', { high: 30 });
    expect(store.selectedKeygroup).toMatchObject({ low: 30, high: 30 });
  });

  test('programs', () => {
    const store = new Store();
    store.addProgram();
    expect(store.programIndex).toBe(1);
    expect(store.program.name).toBe('PROGRAM 2');
    store.removeProgram();
    store.removeProgram();
    expect(store.programs).toHaveLength(1);
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
      { slot: 0, normalize: false }, noResample);
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
    const { dump, notes } = await dumpFromSample(s, { slot: 3, normalize: true }, resample);
    expect(calls).toEqual([[44100, BW16.rate]]);
    const h = decodeHeader(dump.bytes);
    expect(h).toMatchObject({ slot: 3, period: 25281, totalWords: MAX_SAMPLES, alternating: true });
    expect(h.loopStart).toBe(Math.round(4410 * BW16.rate / 44100));
    expect(h.loopEnd).toBe(MAX_SAMPLES);
    expect(notes[0]).toMatch(/Resampled from 44100/);
    expect(notes[1]).toMatch(/Truncated/);

    const oneShot = await dumpFromSample(sample({ loopMode: 'off' }), { slot: 0, normalize: true }, resample);
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

  test('resampling moves the loop to the same time', async () => {
    const s = sample({ rate: 44100, data: new Float32Array(44100), loopStart: 4410, loopEnd: 44100 });
    const halve = async (data: Float32Array) => new Float32Array(data.length / 2);
    expect(await resampleSample(s, 22050, halve)).toMatchObject({ rate: 22050, loopStart: 2205, loopEnd: 22050 });
  });

  test('replacing a sample\'s audio keeps its keygroups, and tells the engine and the views', () => {
    const store = new Store();
    store.addSample(sample());
    const events: string[] = [];
    store.on('sample', (id) => events.push(`sample ${id}`));
    store.on('samples', () => events.push('samples'));
    store.replaceData('s1', { data: new Float32Array(10), rate: 22199.53, loopStart: 1, loopEnd: 9 });
    expect(events).toEqual(['sample s1', 'samples']);
    expect(store.samples.get('s1')).toMatchObject({ rate: 22199.53, loopStart: 1, loopEnd: 9, name: 'SINE' });
    expect(store.program.keygroups[0].sampleId).toBe('s1');
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

describe('bank', () => {
  test('zip round trip keeps samples, loops, exact rates and programs', () => {
    const program = newProgram('BASS ROOT');
    program.cutoff = 64;
    program.keygroups.push(newKeygroup('s1', { low: 36, high: 59, root: 48, cents: 5 }));
    const samples = [sample(), sample({ id: 's2', name: 'ONE/SHOT?', loopMode: 'off', rate: 22199.53 })];
    const bank = zipToBank(bankToZip({ samples, programs: [program, newProgram('P2')], programIndex: 1 }));
    expect(bank.programIndex).toBe(1);
    expect(bank.programs[0]).toEqual(program);
    expect(bank.samples.map((s) => [s.id, s.name, s.rate, s.loopMode, s.loopStart, s.loopEnd])).toEqual([
      ['s1', 'SINE', BW16.rate, 'forward', 0, 5900], ['s2', 'ONE/SHOT?', 22199.53, 'off', 0, 5900]]);
    expect(bank.samples[0].data.length).toBe(6000);
  });

  test('rejects what is not a bank', () => {
    expect(() => zipToBank(new Uint8Array([1, 2, 3]))).toThrow(/zip/);
  });
});
