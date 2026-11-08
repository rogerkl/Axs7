// A slot's parameter bytes as the sampler sends them (RSPRM), saved or compared with a saved copy: for finding where
// a setting changed on the sampler's panel is kept. Read only.
//   node tools/x7000-lab/run.mjs params <slot from 1> [--save <name>] [--diff <name>]

import fs from 'node:fs';
import { findDevice, openMidi } from './midi';
import { CHANNEL, ID } from './sampler';
import { DATA } from './experiments';
import { isSampleParams, parseSampleParams, sampleParamsRequest } from '../../web/src/protocol/sprm';

const args = process.argv.slice(2);
const slot = Number(args[0]) - 1;
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const midi = openMidi(findDevice(/M4U/));
midi.send(sampleParamsRequest(CHANNEL, slot, ID));
const reply = await midi.next((m) => isSampleParams(m) && m[5] === slot, 2000);
midi.close();
if (!reply) {
  console.error('no answer');
  process.exit(1);
}
const { bytes, params } = parseSampleParams(reply);
const { programs, ...rest } = params;
console.log(JSON.stringify(rest));
// after the 32 programs (128 bytes): the undefined byte, then the sample's own bytes
const hex = (b: Uint8Array, from: number) => Array.from(b.subarray(from), (v) => v.toString(16).padStart(2, '0')).join(' ');
console.log(`bytes from 128: ${hex(bytes, 128)}`);
const dir = `${DATA}/params`;
const save = opt('--save');
if (save) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(`${dir}/${save}.bin`, bytes);
  console.log(`saved ${dir}/${save}.bin`);
}
const diff = opt('--diff');
if (diff) {
  const was = new Uint8Array(fs.readFileSync(`${dir}/${diff}.bin`));
  const changed = Array.from(bytes, (b, i) => [i, was[i], b]).filter(([, a, b]) => a !== b);
  console.log(changed.length ? changed.map(([i, a, b]) => `byte ${i}${i >= 128 ? ` (${i - 128} after the programs)`
    : ` (P${Math.floor(i / 4) + 1})`}: ${a} → ${b}`).join('\n') : 'no bytes changed');
  void programs;
}
process.exit(0);
