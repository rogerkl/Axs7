// Sample editing in Rust (engine/src/dsp.rs): the engine's wasm module, instantiated a second time on the main
// thread for its dsp_ functions.

interface DspExports {
  memory: WebAssembly.Memory;
  alloc_f32(len: number): number;
  free_f32(ptr: number, len: number): void;
  dsp_crossfade_loop(ptr: number, len: number, loopStart: number, loopEnd: number, length: number, shape: number)
    : number;
  dsp_fade_in(ptr: number, len: number, at: number, length: number, shape: number, backwards: number): number;
  dsp_peak_spectrum(ptr: number, len: number, size: number, out: number): number;
  dsp_find_loop(ptr: number, len: number, lo: number, hi: number, minLen: number, maxLen: number, minEnd: number,
    rate: number, out: number): number;
}

/** A loop findLoop found */
export interface FoundLoop {
  start: number;
  /** after its last sample */
  end: number;
  /** how much the sound around the jump differs from what it continues, dB under the sound */
  seamDb: number;
  /** how much the level at its end differs from the level at its start, heard as a pumping: dB */
  stepDb: number;
  /** how far the level goes up and down within it, dB */
  swingDb: number;
}

export type FadeShape = 'linear' | 'equal';
export type AttackShape = 'linear' | 'curve';

/** The longest crossfade a forward loop has room for, as dsp::max_crossfade */
export function maxCrossfade(len: number, loopStart: number, loopEnd: number): number {
  return loopEnd > len || loopEnd <= loopStart ? 0 : Math.min(loopStart, loopEnd - loopStart);
}

/**
 * The crossfade room of a sample. Reversed, the seam is at the loop start, and the fade takes what comes after the
 * loop end: the sample mirrored.
 */
export function crossfadeRoom(s: { data: Float32Array; loopStart: number; loopEnd: number; reverse: boolean }): number {
  const n = s.data.length;
  return s.reverse ? maxCrossfade(n, n - s.loopEnd, n - s.loopStart) : maxCrossfade(n, s.loopStart, s.loopEnd);
}

export class Dsp {
  private constructor(private ex: DspExports) {}

  static async load(wasm: BufferSource): Promise<Dsp> {
    const { instance } = await WebAssembly.instantiate(wasm, {});
    return new Dsp(instance.exports as unknown as DspExports);
  }

  /** Runs an in place edit on a copy of the data in wasm memory */
  private edit(data: Float32Array, run: (ptr: number) => number): { data: Float32Array; result: number } {
    const ex = this.ex;
    const ptr = ex.alloc_f32(data.length);
    try {
      new Float32Array(ex.memory.buffer, ptr, data.length).set(data); // views after alloc, memory may have grown
      const result = run(ptr);
      return { data: new Float32Array(ex.memory.buffer, ptr, data.length).slice(), result };
    } finally {
      ex.free_f32(ptr, data.length);
    }
  }

  /**
   * Crossfades the end of a forward loop into what comes before its start, so the jump back is seamless.
   *
   * @returns the crossfaded copy of the data, and the length used (shortened to what the loop has room for)
   */
  crossfadeLoop(data: Float32Array, loopStart: number, loopEnd: number, length: number, shape: FadeShape)
    : { data: Float32Array; length: number } {
    const r = this.edit(data, (ptr) => this.ex.dsp_crossfade_loop(ptr, data.length, loopStart, loopEnd, length,
      shape === 'equal' ? 1 : 0));
    return { data: r.data, length: r.result };
  }

  /**
   * Renders an attack: fades in the `length` samples played first, from `at` on, or back from `at` when reversed.
   *
   * @returns the faded copy of the data, and the length used
   */
  fadeIn(data: Float32Array, at: number, length: number, shape: AttackShape, backwards: boolean)
    : { data: Float32Array; length: number } {
    const r = this.edit(data, (ptr) => this.ex.dsp_fade_in(ptr, data.length, at, length, shape === 'curve' ? 1 : 0,
      backwards ? 1 : 0));
    return { data: r.data, length: r.result };
  }

  /**
   * Renders a fade out: the `length` samples played last fade to silence, which ends at `last` (the last sample
   * played), or, reversed, at `last` as the first sample of the part played. A fade in run from the other end.
   *
   * @returns the faded copy of the data, and the length used
   */
  fadeOut(data: Float32Array, last: number, length: number, shape: AttackShape, backwards: boolean)
    : { data: Float32Array; length: number } {
    return this.fadeIn(data, last, length, shape, !backwards);
  }

  /**
   * The loudest each frequency gets in the data: of the `size / 2 + 1` frequencies (number k is k × rate / size Hz)
   * the magnitude at its loudest over the data, 1 for a sine at full level. Its start counts in full, a cut at its
   * end doesn't (see dsp::peak_spectrum).
   *
   * @param size a power of two
   */
  peakSpectrum(data: Float32Array, size: number): Float32Array {
    const ex = this.ex;
    const bins = size / 2 + 1;
    const ptr = ex.alloc_f32(data.length);
    const out = ex.alloc_f32(bins);
    try {
      new Float32Array(ex.memory.buffer, ptr, data.length).set(data); // views after alloc, memory may have grown
      ex.dsp_peak_spectrum(ptr, data.length, size, out);
      return new Float32Array(ex.memory.buffer, out, bins).slice();
    } finally {
      ex.free_f32(out, bins);
      ex.free_f32(ptr, data.length);
    }
  }

  /**
   * Finds the loop within lo..hi, minLen to maxLen long, that is heard the least: the jump back to its start smooth,
   * the level the same at both ends, and as long as it can be (see loopfind.rs). The data ends where playing ends: a few
   * ms after the loop end have to be there, and before its start.
   *
   * @param minEnd where it may end first: after START, when START is in the loop
   * @returns null if there is no room for one
   */
  findLoop(data: Float32Array, lo: number, hi: number, minLen: number, maxLen: number, minEnd: number, rate: number)
    : FoundLoop | null {
    const ex = this.ex;
    const ptr = ex.alloc_f32(data.length);
    const out = ex.alloc_f32(5);
    try {
      new Float32Array(ex.memory.buffer, ptr, data.length).set(data); // views after alloc, memory may have grown
      if (!ex.dsp_find_loop(ptr, data.length, lo, hi, minLen, maxLen, minEnd, rate, out)) {
        return null;
      }
      const [start, end] = new Uint32Array(ex.memory.buffer, out, 2);
      const [seamDb, stepDb, swingDb] = new Float32Array(ex.memory.buffer, out + 8, 3);
      return { start, end, seamDb, stepDb, swingDb };
    } finally {
      ex.free_f32(out, 5);
      ex.free_f32(ptr, data.length);
    }
  }

  /** For tests: how much memory the module has */
  get memoryBytes(): number {
    return this.ex.memory.buffer.byteLength;
  }
}

let page: Promise<Dsp> | null = null;

/** The page's instance, loaded the first time it is needed */
export function getDsp(): Promise<Dsp> {
  page ??= fetch(`${import.meta.env.BASE_URL}engine.wasm`)
    .then((r) => {
      if (!r.ok) {
        throw new Error(`engine.wasm: ${r.status}, build it with npm run engine`);
      }
      return r.arrayBuffer();
    })
    .then((wasm) => Dsp.load(wasm))
    .catch((e) => {
      page = null; // try again next time
      throw e;
    });
  return page;
}
