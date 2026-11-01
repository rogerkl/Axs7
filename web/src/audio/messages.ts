// Messages between the main thread and the engine's AudioWorklet

export type EngineMessage =
  | { type: 'init'; wasm: ArrayBuffer }
  | { type: 'sample'; id: number; data: Float32Array; rate: number }
  | { type: 'removeSample'; id: number }
  /** sound parameters, a sample's are under its id */
  | { type: 'params'; id: number; params: Float32Array }
  | {
    type: 'noteOn'; key: number; velocity: number; params: number; sample: number; ratio: number;
    start: number; end: number; loopStart: number; loopEnd: number; loopMode: number; reverse: boolean; gain: number;
  }
  | { type: 'noteOff'; key: number }
  | { type: 'allNotesOff'; hard: boolean }
  | { type: 'bend'; semitones: number }
  | { type: 'modulation'; amount: number }
  /** channel aftertouch, 0..1 */
  | { type: 'pressure'; amount: number }
  /** polyphonic aftertouch, 0..1 */
  | { type: 'keyPressure'; key: number; amount: number }
  | { type: 'volume'; volume: number }
  | { type: 'polyphony'; voices: number };

export type WorkletMessage =
  | { type: 'ready' }
  | { type: 'voices'; voices: number }
  /** sample id and position pairs of the playing voices */
  | { type: 'positions'; positions: number[] }
  | { type: 'error'; message: string };

export const PROCESSOR_NAME = 'axs7-engine';
