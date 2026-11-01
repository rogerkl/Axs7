// MIDI connection: the ports, remembered by name, and notes from the input to the player.

import { MidiLink, midiPermissionGranted, webMidiProblem } from '../midi/link';
import type { Log } from '../midi/link';
import type { Player } from '../audio/player';
import { saveSettings } from './settings';
import type { Settings } from './settings';

export class MidiController {
  link: MidiLink | null = null;
  readonly problem = webMidiProblem();
  error: string | null = null;
  /** log of transfers and port changes, newest last */
  readonly log: string[] = [];
  onChange: () => void = () => {};

  constructor(private settings: Settings, private player: Player) {}

  readonly logLine: Log = (text, level = 'info') => {
    const time = new Date().toLocaleTimeString();
    this.log.push(`${time} ${level === 'info' ? '' : `${level.toUpperCase()}: `}${text}`);
    if (this.log.length > 200) {
      this.log.shift();
    }
    this.onChange();
  };

  /** Connects without asking if sysex access was granted before */
  async autoConnect(): Promise<void> {
    if (!this.problem && await midiPermissionGranted()) {
      await this.connect();
    }
  }

  async connect(): Promise<void> {
    if (this.problem || this.link) {
      return;
    }
    try {
      this.link = await MidiLink.connect(this.logLine);
      this.link.listen((data) => this.player.midi(data));
      this.link.access.addEventListener('statechange', (e) => {
        const port = (e as MIDIConnectionEvent).port;
        if (port && port.connection !== 'open') {
          this.logLine(`${port.type} ${port.name}: ${port.state}`);
        }
        void this.choosePorts();
      });
      this.error = null;
      this.logLine('MIDI connected, sysex allowed');
      await this.choosePorts();
    } catch (e) {
      this.error = `No MIDI access: ${e instanceof Error ? e.message : e}`;
      this.logLine(this.error, 'error');
    }
  }

  /** Opens the remembered ports, or the only one there is */
  private async choosePorts(): Promise<void> {
    const link = this.link!;
    const pick = <T extends MIDIPort>(ports: T[], name: string | null) =>
      ports.find((p) => p.name === name) ?? (ports.length === 1 ? ports[0] : null);
    const input = link.input?.state === 'connected' ? link.input : pick(link.inputs(), this.settings.midiIn);
    const output = link.output?.state === 'connected' ? link.output : pick(link.outputs(), this.settings.midiOut);
    await this.select(input?.id ?? null, output?.id ?? null);
  }

  async select(inputId: string | null, outputId: string | null): Promise<void> {
    const link = this.link;
    if (!link) {
      return;
    }
    try {
      if ((link.input?.id ?? null) !== inputId) {
        await link.setInput(inputId);
        if (link.input) {
          this.settings.midiIn = link.input.name;
          this.logLine(`Input: ${link.input.name}`);
        }
      }
      if ((link.output?.id ?? null) !== outputId) {
        await link.setOutput(outputId);
        if (link.output) {
          this.settings.midiOut = link.output.name;
          this.logLine(`Output: ${link.output.name}`);
        }
      }
      saveSettings(this.settings);
    } catch (e) {
      this.logLine(`Could not open the port: ${e instanceof Error ? e.message : e}. Is another program using it?`,
        'error');
    }
    this.onChange();
  }

  get ready(): boolean {
    return !!(this.link?.input && this.link.output);
  }
}
