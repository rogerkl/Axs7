// Sample editing in Rust (engine/src/dsp.rs): the engine's wasm module, instantiated a second time on the main
// thread for its dsp_ functions.

interface DspExports {
  memory: WebAssembly.Memory;
  alloc_f32(len: number): number;
  free_f32(ptr: number, len: number): void;
  dsp_crossfade_loop(ptr: number, len: number, loopStart: number, loopEnd: number, length: number, shape: number)
    : number;
  dsp_fade_in(ptr: number, len: number, at: number, length: number, shape: number, backwards: number): number;
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
