// Plays an experiment's notes (its events.json) through the app's engine (engine.wasm, with the app's mapping from
// 0-99 values) instead of the sampler, into a recording beside the X7000's: the same analysis then shows how close
// the simulation is (compare.ts).
//   node tools/x7000-lab/run.mjs simulate <experiment>...

import fs from 'node:fs';
import { DATA, SAMPLES } from './experiments';
import type { Event } from './experiments';
import { NEUTRAL, RATE as SAMPLER_RATE } from './sampler';
import { RATE } from './record';
import { engineParams } from '../../web/src/model/params';
import type { Sound } from '../../web/src/model/types';
import { S700_SCAN } from '../../web/src/protocol/s700disk';

export const SIM = `${DATA}/simulated`;
// (from the built script in build/)
const WASM = process.env.AXS7_WASM ?? new URL('../../../web/public/engine.wasm', import.meta.url).pathname;
/** the PRESSURE set on the sampler's panel for each experiment (it isn't in the sample's parameters) */
const PRESSURE: Record<string, number> = { pressure: 99, lfofine: 99, sens: 50 };
const LOOP_MODE: Record<number, number> = { [S700_SCAN.oneShot]: 0, [S700_SCAN.looping]: 1,
  [S700_SCAN.alternating]: 2, [S700_SCAN.drum]: 3 };

interface Exports {
  memory: WebAssembly.Memory;
  alloc_f32(len: number): number;
  engine_new(rate: number): number;
  engine_params(e: number): number;
  engine_set_params(e: number, id: number): void;
  engine_set_sample(e: number, id: number, ptr: number, len: number, rate: number): void;
  engine_note_on(e: number, key: number, velocity: number, params: number, sample: number, ratio: number,
    start: number, end: number, loopStart: number, loopEnd: number, loopMode: number, reverse: number, gain: number): void;
  engine_note_off(e: number, key: number, velocity: number): void;
  engine_set_modulation(e: number, amount: number): void;
  engine_set_pressure(e: number, amount: number): void;
  engine_process(e: number, frames: number): number;
}

async function simulate(name: string): Promise<void> {
  const { events } = JSON.parse(fs.readFileSync(`${DATA}/${name}/events.json`, 'utf8')) as { events: Event[] };
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(WASM), {});
  const ex = instance.exports as unknown as Exports;
  const e = ex.engine_new(RATE);
  const sampleIds = new Map<string, number>();
  Object.values(SAMPLES).forEach((t, i) => {
    const data = Float32Array.from(t.codes, (c) => (c - 2048) / 2048);
    const ptr = ex.alloc_f32(data.length);
    new Float32Array(ex.memory.buffer, ptr, data.length).set(data);
    ex.engine_set_sample(e, i + 1, ptr, data.length, SAMPLER_RATE);
    sampleIds.set(t.name, i + 1);
  });
  // what happens when, in samples from the start: half a second of quiet, then the events as sent
  const lead = 0.5;
  const at = (s: number) => Math.round((lead + s) * RATE);
  const actions: { at: number; run: () => void }[] = [];
  events.forEach((ev, i) => {
    const t = SAMPLES[ev.sample];
    const s = { ...NEUTRAL, ...ev.sound };
    const sound: Sound = { level: s.loudness, velLevel: s.velLoudness, filter: s.filter, velFilter: s.velFilter,
      release: s.release, velRelease: s.velRelease, lfoSpeed: s.lfoSpeed, lfoDepth: s.lfoDepth, lfoDelay: s.lfoDelay,
      pressure: PRESSURE[name] ?? 0 };
    const root = ev.sound.recordPitch ?? t.root;
    actions.push({ at: at(ev.on), run: () => {
      new Float32Array(ex.memory.buffer, ex.engine_params(e), 16).set(engineParams(sound));
      ex.engine_set_params(e, i + 1);
      const len = t.codes.length;
      ex.engine_note_on(e, ev.note, ev.velocity / 127, i + 1, sampleIds.get(t.name)!, 2 ** ((ev.note - root) / 12), 0,
        len, 0, len, LOOP_MODE[s.scanMode], 0, 1);
    } });
    for (const d of ev.during ?? []) {
      const [status, a, b] = d.bytes;
      actions.push({ at: at(ev.on + d.at), run: () => {
        if (status === 0xd0) {
          ex.engine_set_pressure(e, a / 127);
        } else if (status === 0xb0 && a === 1) {
          ex.engine_set_modulation(e, b / 127);
        } // polyphonic aftertouch: nothing, as on the sampler and in the app's player
      } });
    }
    const offVelocity = ev.keyOff?.asNoteOn ? 64 : ev.keyOff?.velocity ?? 0;
    actions.push({ at: at(ev.off), run: () => ex.engine_note_off(e, ev.note, offVelocity / 127) });
  });
  actions.sort((a, b) => a.at - b.at);
  const last = events[events.length - 1];
  const total = at(last.off + last.after + 0.3);
  const out = new Float32Array(total);
  let pos = 0;
  let next = 0;
  while (pos < total) {
    while (next < actions.length && actions[next].at <= pos) {
      actions[next++].run();
    }
    const n = Math.min(128, total - pos, (actions[next]?.at ?? total) - pos);
    out.set(new Float32Array(ex.memory.buffer, ex.engine_process(e, n), n), pos);
    pos += n;
  }
  const dir = `${SIM}/${name}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(`${DATA}/${name}/events.json`, `${dir}/events.json`);
  writeWav(`${dir}/recording.wav`, out);
  console.log(`${name}: ${dir}, ${(total / RATE).toFixed(1)} s`);
}

/** 16 bit stereo (the same on both), with a whisper of noise so the quiet has a floor like a recording's */
function writeWav(path: string, data: Float32Array): void {
  const b = Buffer.alloc(44 + data.length * 4);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + data.length * 4, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(data.length * 4, 40);
  let seed = 1;
  for (let i = 0; i < data.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const v = Math.max(-32768, Math.min(32767, Math.round(data[i] * 32767 + (seed / 2 ** 32 - 0.5) * 1.5)));
    b.writeInt16LE(v, 44 + i * 4);
    b.writeInt16LE(v, 46 + i * 4);
  }
  fs.writeFileSync(path, b);
}

for (const name of process.argv.slice(2)) {
  await simulate(name);
}
