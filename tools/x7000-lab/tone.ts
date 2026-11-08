// Plays one note on the sampler while recording, and reports the level: for setting the input gain.
//   node tools/x7000-lab/run.mjs tone [note] [velocity]

import { findDevice, openMidi } from './midi';
import { readWav, startRecording } from './record';

const note = Number(process.argv[2] ?? 60);
const velocity = Number(process.argv[3] ?? 127);
const midi = openMidi(findDevice(/M4U/));
const rec = await startRecording('tone');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
await sleep(700);
midi.send([0x90, note, velocity]);
await sleep(1500);
midi.send([0x80, note, 0]);
await sleep(1500);
const { rate, data } = readWav(await rec.stop());
midi.close();

const db = (v: number) => (20 * Math.log10(Math.max(v, 1e-9))).toFixed(1);
const win = Math.round(rate * 0.05);
let line = '';
let peak = 0;
for (let i = 0; i + win <= data.length; i += win) {
  let s = 0;
  for (let j = i; j < i + win; j++) {
    s += data[j] * data[j];
    peak = Math.max(peak, Math.abs(data[j]));
  }
  const rms = Math.sqrt(s / win);
  line += rms > 0.1 ? '#' : rms > 0.01 ? '+' : rms > 0.001 ? '.' : ' ';
}
console.log(`${(data.length / rate).toFixed(2)} s, peak ${db(peak)} dBFS`);
console.log(`|${line}| (50 ms each: # > -20 dB, + > -40, . > -60)`);
process.exit(0);
