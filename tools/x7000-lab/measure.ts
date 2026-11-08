// Plays experiments (experiments.ts) on the sampler, recording its output:
//   node tools/x7000-lab/run.mjs measure <experiment>... [--resend]
// Each experiment goes in its own folder under LAB_DATA: the recording and events.json, the notes with their times
// from the first note (a sync note), for analyze.ts.

import fs from 'node:fs';
import { findDevice, openMidi } from './midi';
import { startRecording } from './record';
import { NEUTRAL, PROGRAM, Sampler } from './sampler';
import { DATA, EXPERIMENTS, SAMPLES, hit } from './experiments';
import type { Event, Hit } from './experiments';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function run(sampler: Sampler, name: string, hits: Hit[]): Promise<void> {
  const dir = `${DATA}/${name}`;
  fs.mkdirSync(dir, { recursive: true });
  // the sync note first: the sine, plain, at full velocity
  const sync = hit('sine', {}, { sync: 1 }, { hold: 0.5, after: 0.6 });
  const all = [sync, ...hits];
  for (const t of Object.values(SAMPLES)) {
    await sampler.setSound(t.slot, { ...NEUTRAL, recordPitch: t.root });
  }
  const seconds = all.reduce((s, h) => s + h.hold + h.after + 0.2, 0);
  console.log(`${name}: ${all.length} notes, about ${Math.round(seconds)} s`);
  const rec = await startRecording(name);
  const events: Event[] = [];
  let t0 = 0;
  try {
    await sleep(500);
    for (const [i, h] of all.entries()) {
      const slot = SAMPLES[h.sample].slot;
      await sampler.setSound(slot, { ...NEUTRAL, recordPitch: SAMPLES[h.sample].root, ...h.sound });
      await sleep(150);
      const on = performance.now();
      sampler.noteOn(h.note, h.velocity);
      if (i === 0) {
        t0 = on;
      }
      let held = 0;
      for (const d of [...(h.during ?? [])].sort((a, b) => a.at - b.at)) {
        await sleep(Math.max(0, d.at - held) * 1000);
        held = Math.max(held, d.at);
        sampler.midi.send(d.bytes);
      }
      await sleep(Math.max(0, h.hold - held) * 1000);
      const off = performance.now();
      if (h.keyOff?.asNoteOn) {
        sampler.noteOn(h.note, 0);
      } else {
        sampler.noteOff(h.note, h.keyOff?.velocity ?? 0);
      }
      events.push({ ...h, on: (on - t0) / 1000, off: (off - t0) / 1000 });
      await sleep(h.after * 1000);
    }
  } finally {
    sampler.allOff();
    const file = await rec.stop();
    fs.copyFileSync(file, `${dir}/recording.wav`);
    fs.writeFileSync(`${dir}/events.json`, JSON.stringify({ name, when: new Date().toISOString(), events }, null, 1));
    console.log(`${name}: ${dir}`);
  }
}

const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith('--'));
const unknown = names.filter((n) => !EXPERIMENTS[n]);
if (!names.length || unknown.length) {
  console.error(`experiments: ${Object.keys(EXPERIMENTS).join(', ')}${unknown.length ? ` (not ${unknown})` : ''}`);
  process.exit(2);
}
const midi = openMidi(findDevice(/M4U/));
const sampler = new Sampler(midi);
try {
  for (const t of Object.values(SAMPLES)) {
    await sampler.sendSample(t, NEUTRAL, args.includes('--resend'));
  }
  sampler.program(PROGRAM);
  await sleep(300);
  for (const name of names) {
    await run(sampler, name, EXPERIMENTS[name]());
  }
} finally {
  midi.close();
}
process.exit(0);
