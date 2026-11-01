// The main thread side of the engine: starts the AudioWorklet and keeps it in step with the memory.

import workletUrl from './worklet.ts?worker&url';
import { PROCESSOR_NAME } from './messages';
import type { EngineMessage, WorkletMessage } from './messages';
import { LOOP_MODE_CODE } from '../model/mapping';
import type { VoiceStart } from '../model/mapping';
import { engineParams } from '../model/params';
import type { Store } from '../model/store';
import type { Sample } from '../model/types';

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private starting: Promise<void> | null = null;
  private queue: EngineMessage[] = [];
  private ids = new Map<string, number>();
  private keys = new Map<number, string>();
  private positionListeners = new Set<(bySample: Map<string, number[]>) => void>();
  /** the data each sample was loaded with, to see when it changes */
  private loaded = new Map<string, Float32Array>();
  private nextId = 1;
  onVoices: (voices: number) => void = () => {};
  onError: (message: string) => void = () => {};

  constructor(private store: Store) {
    store.on('samples', () => this.syncSamples());
    // a sample's sound (OUT and LFO) can change, cheap to send on any change of the sample
    store.on('sample', (id) => {
      const sample = id && store.samples.get(id);
      if (sample) {
        this.setParams(sample);
      }
    });
  }

  get state(): AudioContextState | 'off' {
    return this.ctx?.state ?? 'off';
  }

  /**
   * Starts the audio, or resumes it. Browsers only let audio start from a user gesture, so call this from one.
   */
  start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      return this.starting!;
    }
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.starting = this.init(this.ctx).catch((e) => {
      this.onError(`Audio engine: ${e instanceof Error ? e.message : e}`);
      throw e;
    });
    return this.starting;
  }

  private async init(ctx: AudioContext): Promise<void> {
    const [wasm] = await Promise.all([
      fetch(`${import.meta.env.BASE_URL}engine.wasm`).then((r) => {
        if (!r.ok) {
          throw new Error(`engine.wasm: ${r.status}, build it with npm run engine`);
        }
        return r.arrayBuffer();
      }),
      ctx.audioWorklet.addModule(workletUrl),
    ]);
    const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
    });
    node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      if (e.data.type === 'voices') {
        this.onVoices(e.data.voices);
      } else if (e.data.type === 'positions') {
        this.positions(e.data.positions);
      } else if (e.data.type === 'error') {
        this.onError(e.data.message);
      }
    };
    // an exception in the audio thread stops the processor, without this it would go silent without a word
    node.onprocessorerror = () => this.onError('The audio engine stopped with an error, reload the page');
    node.connect(ctx.destination);
    node.port.postMessage({ type: 'init', wasm } satisfies EngineMessage, [wasm]);
    this.node = node;
    this.syncSamples();
    for (const message of this.queue.splice(0)) {
      node.port.postMessage(message);
    }
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }
  }

  private positions(pairs: number[]): void {
    const bySample = new Map<string, number[]>();
    for (let i = 0; i < pairs.length; i += 2) {
      const key = this.keys.get(pairs[i]);
      if (key) {
        bySample.set(key, [...(bySample.get(key) ?? []), pairs[i + 1]]);
      }
    }
    for (const listener of this.positionListeners) {
      listener(bySample);
    }
  }

  /**
   * Where the playing voices are in their samples, for playback heads: called about 60 times a second while
   * something plays, and once with nothing when it stops.
   *
   * @returns a function that stops listening
   */
  onPositions(listener: (bySample: Map<string, number[]>) => void): () => void {
    this.positionListeners.add(listener);
    return () => this.positionListeners.delete(listener);
  }

  /** Messages before the engine runs wait, except the samples, which are synced when it starts */
  private post(message: EngineMessage, transfer: Transferable[] = []): void {
    if (this.node) {
      this.node.port.postMessage(message, transfer);
    } else if (this.queue.length < 100) {
      this.queue.push(message);
    }
  }

  private id(key: string): number {
    let id = this.ids.get(key);
    if (id === undefined) {
      id = this.nextId++;
      this.ids.set(key, id);
      this.keys.set(id, key);
    }
    return id;
  }

  private syncSamples(): void {
    if (!this.node) {
      return;
    }
    for (const [id, data] of this.loaded) {
      if (this.store.samples.get(id)?.data !== data) {
        this.post({ type: 'removeSample', id: this.id(id) });
        this.loaded.delete(id);
      }
    }
    for (const sample of this.store.samples.values()) {
      if (!this.loaded.has(sample.id)) {
        const copy = sample.data.slice();
        this.post({ type: 'sample', id: this.id(sample.id), data: copy, rate: sample.rate }, [copy.buffer]);
        this.loaded.set(sample.id, sample.data);
        this.setParams(sample);
      }
    }
  }

  /** A sample's sound goes to the engine under the sample's id */
  private setParams(sample: Sample): void {
    if (this.node) {
      this.post({ type: 'params', id: this.id(sample.id), params: engineParams(sample.sound) });
    }
  }

  /** @param velocity 0..1 */
  noteOn(key: number, velocity: number, voices: Pick<VoiceStart, 'sample' | 'ratio' | 'gain'>[]): void {
    for (const v of voices) {
      const sample = this.id(v.sample.id);
      this.post({
        type: 'noteOn', key, velocity, params: sample, sample, ratio: v.ratio,
        start: v.sample.start, end: v.sample.end, loopStart: v.sample.loopStart, loopEnd: v.sample.loopEnd,
        loopMode: LOOP_MODE_CODE[v.sample.loopMode],
        reverse: v.sample.reverse,
        gain: v.gain,
      });
    }
  }

  noteOff(key: number): void {
    this.post({ type: 'noteOff', key });
  }

  allNotesOff(hard = false): void {
    this.post({ type: 'allNotesOff', hard });
  }

  bend(semitones: number): void {
    this.post({ type: 'bend', semitones });
  }

  modulation(amount: number): void {
    this.post({ type: 'modulation', amount });
  }

  /** Channel aftertouch, 0..1 */
  pressure(amount: number): void {
    this.post({ type: 'pressure', amount });
  }

  /** Polyphonic aftertouch on a key, 0..1 */
  keyPressure(key: number, amount: number): void {
    this.post({ type: 'keyPressure', key, amount });
  }

  volume(volume: number): void {
    this.post({ type: 'volume', volume });
  }

  polyphony(voices: number): void {
    this.post({ type: 'polyphony', voices });
  }

  /** For tests in the browser: taps the engine's output */
  tap(): AnalyserNode | null {
    if (!this.ctx || !this.node) {
      return null;
    }
    const analyser = this.ctx.createAnalyser();
    this.node.connect(analyser);
    return analyser;
  }
}
