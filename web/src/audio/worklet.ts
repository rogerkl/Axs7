// Runs the Rust engine (engine.wasm, a plain C ABI without imports) in the audio thread.

import { PROCESSOR_NAME } from './messages';
import type { EngineMessage, WorkletMessage } from './messages';

interface EngineExports {
  memory: WebAssembly.Memory;
  alloc_f32(len: number): number;
  engine_new(sampleRate: number): number;
  engine_params(engine: number): number;
  engine_set_params(engine: number, id: number): void;
  engine_set_sample(engine: number, id: number, data: number, len: number, rate: number): void;
  engine_remove_sample(engine: number, id: number): void;
  engine_note_on(engine: number, key: number, velocity: number, params: number, sample: number, ratio: number,
    start: number, end: number, loopStart: number, loopEnd: number, loopMode: number, reverse: number, gain: number)
    : void;
  engine_note_off(engine: number, key: number): void;
  engine_all_notes_off(engine: number, hard: number): void;
  engine_set_bend(engine: number, semitones: number): void;
  engine_set_modulation(engine: number, amount: number): void;
  engine_set_pressure(engine: number, amount: number): void;
  engine_set_key_pressure(engine: number, key: number, amount: number): void;
  engine_set_volume(engine: number, volume: number): void;
  engine_set_polyphony(engine: number, voices: number): void;
  engine_active_voices(engine: number): number;
  /** missing in an engine.wasm built before playback heads */
  engine_positions?(engine: number): number;
  engine_process(engine: number, frames: number): number;
}

class EngineProcessor extends AudioWorkletProcessor {
  private ex: EngineExports | null = null;
  private engine = 0;
  private pending: EngineMessage[] = [];
  private voices = 0;
  private blocks = 0;
  /** voices in the last positions sent, so the heads are cleared when the last one stops */
  private positioned = 0;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<EngineMessage>) => this.receive(e.data);
  }

  private post(message: WorkletMessage): void {
    this.port.postMessage(message);
  }

  private async receive(message: EngineMessage): Promise<void> {
    if (message.type === 'init') {
      try {
        const { instance } = await WebAssembly.instantiate(message.wasm, {});
        this.ex = instance.exports as unknown as EngineExports;
        this.engine = this.ex.engine_new(sampleRate);
        this.post({ type: 'ready' });
        for (const m of this.pending.splice(0)) {
          this.handle(m);
        }
      } catch (e) {
        this.post({ type: 'error', message: String(e) });
      }
    } else if (this.ex) {
      this.handle(message);
    } else {
      this.pending.push(message);
    }
  }

  private handle(m: EngineMessage): void {
    const ex = this.ex!;
    const e = this.engine;
    switch (m.type) {
      case 'sample': {
        const ptr = ex.alloc_f32(m.data.length);
        // a fresh view, the memory may have grown
        new Float32Array(ex.memory.buffer, ptr, m.data.length).set(m.data);
        ex.engine_set_sample(e, m.id, ptr, m.data.length, m.rate);
        break;
      }
      case 'removeSample':
        ex.engine_remove_sample(e, m.id);
        break;
      case 'params':
        new Float32Array(ex.memory.buffer, ex.engine_params(e), m.params.length).set(m.params);
        ex.engine_set_params(e, m.id);
        break;
      case 'noteOn':
        ex.engine_note_on(e, m.key, m.velocity, m.params, m.sample, m.ratio, m.start, m.end, m.loopStart, m.loopEnd,
          m.loopMode, m.reverse ? 1 : 0, m.gain);
        break;
      case 'noteOff':
        ex.engine_note_off(e, m.key);
        break;
      case 'allNotesOff':
        ex.engine_all_notes_off(e, m.hard ? 1 : 0);
        break;
      case 'bend':
        ex.engine_set_bend(e, m.semitones);
        break;
      case 'modulation':
        ex.engine_set_modulation(e, m.amount);
        break;
      case 'pressure':
        ex.engine_set_pressure(e, m.amount);
        break;
      case 'keyPressure':
        ex.engine_set_key_pressure(e, m.key, m.amount);
        break;
      case 'volume':
        ex.engine_set_volume(e, m.volume);
        break;
      case 'polyphony':
        ex.engine_set_polyphony(e, m.voices);
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const ex = this.ex;
    const out = outputs[0];
    if (!ex || !out?.length) {
      return true;
    }
    const frames = out[0].length;
    const block = new Float32Array(ex.memory.buffer, ex.engine_process(this.engine, frames), frames);
    for (const channel of out) {
      channel.set(block);
    }
    const voices = ex.engine_active_voices(this.engine);
    if (voices !== this.voices) {
      this.voices = voices;
      this.post({ type: 'voices', voices });
    }
    // playback heads, about 60 times a second while something plays
    if (ex.engine_positions && ++this.blocks % 6 === 0 && (voices > 0 || this.positioned > 0)) {
      const ptr = ex.engine_positions(this.engine);
      const count = new Uint32Array(ex.memory.buffer, ptr, 1)[0];
      this.post({ type: 'positions', positions: Array.from(new Uint32Array(ex.memory.buffer, ptr + 4, 2 * count)) });
      this.positioned = count;
    }
    return true;
  }
}

registerProcessor(PROCESSOR_NAME, EngineProcessor);
