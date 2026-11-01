// WAV files with the loop in a "smpl" chunk, the same layout as the Java version's WavLoop.

/**
 * @typedef {object} Loop
 * @property {number} start first sample in the loop
 * @property {number} end sample after the last sample in the loop (in the smpl chunk it is the last sample)
 * @property {boolean} alternating
 */

/**
 * @param {ArrayLike<number>} data mono samples, -1..1
 * @param {number} sampleRate stored rounded to whole Hz, the exact rate is kept as the period in the smpl chunk
 * @param {Loop[]} loops empty for a one shot sample
 * @returns {Uint8Array} 16 bit PCM wav
 */
export function encodeWav(data, sampleRate, loops) {
  const dataSize = data.length * 2;
  const smplSize = 36 + 24 * loops.length;
  const dataPad = dataSize & 1;
  const size = 12 + (8 + 16) + (8 + dataSize + dataPad) + (8 + smplSize);
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let pos = 0;
  const str = (s) => {
    for (const c of s) view.setUint8(pos++, c.charCodeAt(0));
  };
  const u32 = (v) => {
    view.setUint32(pos, v, true);
    pos += 4;
  };
  const u16 = (v) => {
    view.setUint16(pos, v, true);
    pos += 2;
  };
  const rate = Math.round(sampleRate);
  str('RIFF');
  u32(size - 8);
  str('WAVE');
  str('fmt ');
  u32(16);
  u16(1); // PCM
  u16(1); // mono
  u32(rate);
  u32(rate * 2);
  u16(2);
  u16(16);
  str('data');
  u32(dataSize);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(pos, Math.round(v * 32767), true);
    pos += 2;
  }
  pos += dataPad;
  str('smpl');
  u32(smplSize);
  u32(0); // manufacturer
  u32(0); // product
  u32(Math.round(1e9 / sampleRate)); // sample period in ns
  u32(60); // unity note, C3 as the sampler assumes
  u32(0); // pitch fraction
  u32(0); // SMPTE format
  u32(0); // SMPTE offset
  u32(loops.length);
  u32(0); // sampler data
  loops.forEach((loop, i) => {
    u32(i); // cue point id
    u32(loop.alternating ? 1 : 0); // 0 forward, 1 alternating, 2 backward
    u32(loop.start);
    u32(loop.end - 1);
    u32(0); // fraction
    u32(0); // play count, 0 = forever
  });
  return new Uint8Array(buffer);
}

/**
 * Reads what decodeAudioData doesn't give: the file's own sample rate and its loops.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{sampleRate: number|null, loops: Loop[]|null}} sampleRate null if it isn't a wav file, loops null if
 *          it has no smpl chunk, empty for a smpl chunk without loops (one shot). Backward loops become forward.
 */
export function readWavInfo(buffer) {
  const view = new DataView(buffer);
  const tag = (offset) => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    return { sampleRate: null, loops: null };
  }
  let sampleRate = null;
  let loops = null;
  let pos = 12;
  while (pos + 8 <= buffer.byteLength) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (body + size > buffer.byteLength) {
      break;
    }
    if (id === 'fmt ' && size >= 16) {
      sampleRate = view.getUint32(body + 4, true);
    } else if (id === 'smpl' && size >= 36) {
      const count = Math.min(view.getUint32(body + 28, true), Math.floor((size - 36) / 24));
      loops = [];
      for (let i = 0; i < count; i++) {
        const offset = body + 36 + i * 24;
        const type = view.getUint32(offset + 4, true);
        const start = view.getUint32(offset + 8, true);
        const end = view.getUint32(offset + 12, true) + 1;
        if (end > start) {
          loops.push({ start, end, alternating: type === 1 });
        }
      }
    }
    pos = body + size + (size & 1);
  }
  return { sampleRate, loops };
}
