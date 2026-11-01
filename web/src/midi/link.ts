// The selected MIDI input and output. One listener on the input passes messages to whoever listens: the
// transfers (sysex) and the player (notes and controllers).

export type MidiListener = (data: Uint8Array, time: number) => void;
export type Log = (text: string, level?: 'info' | 'warn' | 'error') => void;

/** @returns why Web MIDI can't be used here, or null if it can */
export function webMidiProblem(): string | null {
  if (!globalThis.isSecureContext) {
    return 'Web MIDI needs a secure origin: open the page from http://localhost or https';
  }
  if (!navigator.requestMIDIAccess) {
    return 'This browser has no Web MIDI, use Chrome or Edge';
  }
  return null;
}

/** @returns true if sysex access was granted before, so it can be requested without a prompt */
export async function midiPermissionGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'midi', sysex: true } as unknown as PermissionDescriptor);
    return status.state === 'granted';
  } catch {
    return false;
  }
}

export class MidiLink {
  input: MIDIInput | null = null;
  output: MIDIOutput | null = null;
  private listeners = new Set<MidiListener>();

  constructor(readonly access: MIDIAccess, readonly log: Log) {}

  static async connect(log: Log): Promise<MidiLink> {
    return new MidiLink(await navigator.requestMIDIAccess({ sysex: true }), log);
  }

  inputs(): MIDIInput[] {
    return [...this.access.inputs.values()];
  }

  outputs(): MIDIOutput[] {
    return [...this.access.outputs.values()];
  }

  async setInput(id: string | null): Promise<void> {
    this.input?.removeEventListener('midimessage', this.onMessage);
    this.input = (id && this.access.inputs.get(id)) || null;
    if (this.input) {
      this.input.addEventListener('midimessage', this.onMessage);
      await this.input.open();
    }
  }

  async setOutput(id: string | null): Promise<void> {
    this.output = (id && this.access.outputs.get(id)) || null;
    if (this.output) {
      await this.output.open();
    }
  }

  private onMessage = (event: Event): void => {
    const data = (event as MIDIMessageEvent).data;
    if (!data) {
      return;
    }
    const time = event.timeStamp || performance.now();
    for (const listener of this.listeners) {
      listener(data, time);
    }
  };

  /** @returns a function that removes the listener */
  listen(listener: MidiListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
