// Audio file decoding and resampling with the browser's decoder, which has a good resampler.

import { encodeWav } from '../protocol/wav';

/** Resamples by letting the browser decode a wav at the old rate into a context at the new rate */
export async function resampleInBrowser(data: Float32Array, fromRate: number, toRate: number): Promise<Float32Array> {
  const wav = encodeWav(data, fromRate, []);
  const ctx = new OfflineAudioContext(1, 1, toRate);
  const audio = await ctx.decodeAudioData(wav.buffer as ArrayBuffer);
  return audio.getChannelData(0).slice();
}

/** For files that aren't wav (mp3, flac, aiff ...): decoded at 44.1 kHz, mixed to mono */
export async function decodeAudioFile(buffer: ArrayBuffer): Promise<{ rate: number; data: Float32Array }> {
  const rate = 44100;
  const audio = await new OfflineAudioContext(1, 1, rate).decodeAudioData(buffer);
  const data = new Float32Array(audio.length);
  for (let c = 0; c < audio.numberOfChannels; c++) {
    const channel = audio.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      data[i] += channel[i] / audio.numberOfChannels;
    }
  }
  return { rate, data };
}
