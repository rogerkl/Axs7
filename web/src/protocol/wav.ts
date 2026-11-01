// WAV files with the loop in a "smpl" chunk, the same layout as the Java version's WavLoop.
//
// The reader decodes the audio itself instead of using decodeAudioData, which resamples to the AudioContext's
// rate: samples are kept at their own rate.

export interface WavLoop {
  /** first sample in the loop */
  start: number;
  /** after the last sample in the loop (in the smpl chunk it is the last sample) */
  end: number;
  alternating: boolean;
}

export interface Wav {
  /** whole Hz, as in the file */
  sampleRate: number;
  channels: number;
  /** mixed to mono, -1..1 */
  data: Float32Array;
  /** null without a smpl chunk, empty for a smpl chunk without loops (one shot) */
  loops: WavLoop[] | null;
}

/**
 * @param data mono samples, -1..1
 * @param sampleRate stored rounded to whole Hz, the exact rate is kept as the period in the smpl chunk
 * @param loops empty for a one shot sample
 * @returns 16 bit PCM wav
 */
export function encodeWav(data: ArrayLike<number>, sampleRate: number, loops: WavLoop[]): Uint8Array {
  const dataSize = data.length * 2;
  const smplSize = 36 + 24 * loops.length;
  const dataPad = dataSize & 1;
  const size = 12 + (8 + 16) + (8 + dataSize + dataPad) + (8 + smplSize);
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  let pos = 0;
  const str = (s: string) => {
    for (const c of s) view.setUint8(pos++, c.charCodeAt(0));
  };
  const u32 = (v: number) => {
    view.setUint32(pos, v, true);
    pos += 4;
  };
  const u16 = (v: number) => {
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

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

/**
 * Reads a PCM (8, 16, 24, 32 bit) or float (32, 64 bit) wav file, mixed to mono.
 *
 * @returns null if it isn't a wav file this can read
 */
export function readWav(buffer: ArrayBuffer): Wav | null {
  const view = new DataView(buffer);
  const tag = (offset: number) => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
  if (buffer.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    return null;
  }
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataOffset = -1;
  let dataSize = 0;
  let loops: WavLoop[] | null = null;
  let pos = 12;
  while (pos + 8 <= buffer.byteLength) {
    const id = tag(pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ' && size >= 16) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === EXTENSIBLE && size >= 26) {
        format = view.getUint16(body + 24, true); // first two bytes of the sub format GUID
      }
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = Math.min(size, buffer.byteLength - body); // some writers leave the size wrong
    } else if (id === 'smpl' && size >= 36 && body + size <= buffer.byteLength) {
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
  const bytesPerSample = bits / 8;
  const readable = (format === PCM && [8, 16, 24, 32].includes(bits)) || (format === FLOAT && [32, 64].includes(bits));
  if (dataOffset < 0 || channels < 1 || sampleRate < 1 || !readable) {
    return null;
  }
  const frames = Math.floor(dataSize / (bytesPerSample * channels));
  const read = sampleReader(view, format, bits);
  const data = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      sum += read(dataOffset + (f * channels + c) * bytesPerSample);
    }
    data[f] = sum / channels;
  }
  return { sampleRate, channels, data, loops };
}

function sampleReader(view: DataView, format: number, bits: number): (offset: number) => number {
  if (format === FLOAT) {
    return bits === 32 ? (o) => view.getFloat32(o, true) : (o) => view.getFloat64(o, true);
  }
  switch (bits) {
    case 8:
      return (o) => (view.getUint8(o) - 128) / 128;
    case 16:
      return (o) => view.getInt16(o, true) / 32768;
    case 24:
      return (o) => ((view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getInt8(o + 2) << 16))) / 8388608;
    default:
      return (o) => view.getInt32(o, true) / 2147483648;
  }
}
