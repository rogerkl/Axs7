// Audio file decoding and resampling with the browser's decoder, which has a good resampler.

/** A 32 bit float mono wav, for the browser's decoder */
function floatWav(data: Float32Array, rate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + data.length * 4);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + data.length * 4, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); // IEEE float
  view.setUint16(22, 1, true);
  view.setUint32(24, Math.round(rate), true);
  view.setUint32(28, Math.round(rate) * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  text(36, 'data');
  view.setUint32(40, data.length * 4, true);
  new Float32Array(buffer, 44).set(data);
  return buffer;
}

/**
 * Resamples by letting the browser decode a wav at the old rate into a context at the new rate. Its decoder has a
 * good (sinc) resampler. The wav has whole Hz, which puts a sampler rate like 39555.4 off by 0.02 cents.
 */
export async function resampleInBrowser(data: Float32Array, fromRate: number, toRate: number): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, toRate);
  const audio = await ctx.decodeAudioData(floatWav(data, fromRate));
  return audio.getChannelData(0).slice();
}

/** For files that aren't wav (mp3, flac, aiff ...): decoded at the rate, 44.1 kHz by default, mixed to mono */
export async function decodeAudioFile(buffer: ArrayBuffer, rate = 44100): Promise<{ rate: number; data: Float32Array }> {
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
