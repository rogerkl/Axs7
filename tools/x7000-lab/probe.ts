// Asks the sampler for every slot's parameters (RSPRM) and lists them: read only, changes nothing on it.
//   node tools/x7000-lab/run.mjs probe [slots]

import { findDevice, openMidi } from './midi';
import { isSampleParams, parseSampleParams, sampleParamsRequest } from '../../web/src/protocol/sprm';
import { inNoProgram } from '../../web/src/model/s700';

const CHANNEL = 0;
const ID = 0x41;
const slots = Number(process.argv[2] ?? 16);
const midi = openMidi(findDevice(/M4U|MIDI/));
for (let slot = 0; slot < slots; slot++) {
  midi.send(sampleParamsRequest(CHANNEL, slot, ID));
  const reply = await midi.next((m) => isSampleParams(m) && m[5] === slot, 1500);
  if (!reply) {
    console.log(`slot ${slot + 1}: no answer`);
    continue;
  }
  const { params: p, checksumOk } = parseSampleParams(reply);
  const programs = p.programs.map((k, i) => (k.low <= k.high ? `P${i + 1} ${k.low}-${k.high}` : '')).filter(Boolean);
  console.log(`slot ${slot + 1}: START ${p.start} END ${p.end} LOOP ${p.loop} scan ${p.scanMode} code ${p.bandwidth}`
    + ` root ${p.recordPitch} | LFO ${p.lfoSpeed}/${p.lfoDepth}/${p.lfoDelay} FILTER ${p.filter} RELEASE ${p.release}`
    + ` LEVEL ${p.loudness} VEL>F ${p.velFilter} VEL>L ${p.velLoudness} VEL>R ${p.velRelease}`
    + ` | ${inNoProgram(p) ? 'in no program' : programs.slice(0, 6).join(', ') + (programs.length > 6 ? ', …' : '')}`
    + `${checksumOk ? '' : ' (bad checksum)'}`);
}
midi.close();
process.exit(0);
