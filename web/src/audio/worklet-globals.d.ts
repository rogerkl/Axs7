// The AudioWorkletGlobalScope, which TypeScript's DOM types leave out

declare const sampleRate: number;

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;
