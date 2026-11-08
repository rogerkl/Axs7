// Signal analysis for the recordings: FFT, power spectra, envelopes and onsets.

/** In place radix 2 FFT, re and im of a power of 2 length */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len;
    const wr = Math.cos(a);
    const wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/** Welch power spectrum (Hann windows, half overlapping) of data[from, to), size/2 + 1 bins */
export function powerSpectrum(data: Float32Array, from: number, to: number, size = 4096): Float64Array {
  const out = new Float64Array(size / 2 + 1);
  const win = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const norm = win.reduce((s, w) => s + w * w, 0);
  let count = 0;
  for (let at = from; at + size <= to; at += size / 2) {
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      re[i] = data[at + i] * win[i];
    }
    fft(re, im);
    for (let k = 0; k <= size / 2; k++) {
      out[k] += (re[k] * re[k] + im[k] * im[k]) / norm;
    }
    count++;
  }
  return out.map((v) => v / Math.max(1, count));
}

export const db = (power: number) => 10 * Math.log10(Math.max(power, 1e-20));
export const dbAmp = (amp: number) => 20 * Math.log10(Math.max(amp, 1e-10));

/** RMS in windows of `win` samples, `hop` apart, from `from` */
export function envelope(data: Float32Array, from: number, to: number, win: number, hop = win): Float64Array {
  const out: number[] = [];
  for (let at = Math.max(0, from); at + win <= Math.min(to, data.length); at += hop) {
    let s = 0;
    for (let i = at; i < at + win; i++) {
      s += data[i] * data[i];
    }
    out.push(Math.sqrt(s / win));
  }
  return Float64Array.from(out);
}

export function rms(data: Float32Array, from: number, to: number): number {
  let s = 0;
  const a = Math.max(0, Math.floor(from));
  const b = Math.min(data.length, Math.floor(to));
  for (let i = a; i < b; i++) {
    s += data[i] * data[i];
  }
  return Math.sqrt(s / Math.max(1, b - a));
}

export function peak(data: Float32Array, from: number, to: number): number {
  let p = 0;
  for (let i = Math.max(0, from); i < Math.min(to, data.length); i++) {
    p = Math.max(p, Math.abs(data[i]));
  }
  return p;
}

/**
 * Where a note starts, in samples: the first point from `from` where the 1 ms RMS rises over `threshold`, -1 if it
 * doesn't before `to`
 */
export function onset(data: Float32Array, from: number, to: number, threshold: number, rate: number): number {
  const win = Math.round(rate / 1000);
  for (let at = Math.max(0, from); at + win <= Math.min(to, data.length); at += Math.round(win / 4)) {
    if (rms(data, at, at + win) > threshold) {
      // the first sample in it over half the threshold
      for (let j = at; j < at + win; j++) {
        if (Math.abs(data[j]) > threshold / 2) {
          return j;
        }
      }
      return at;
    }
  }
  return -1;
}

/** Least squares line through points: slope and intercept */
export function fitLine(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy ? (sxy * sxy) / (sxx * syy) : 1 };
}
