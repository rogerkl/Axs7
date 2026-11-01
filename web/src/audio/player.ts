// Turns notes from the on-screen keyboard, the computer keyboard and MIDI into engine voices for the current
// program, with the sustain pedal.

import { voicesFor } from '../model/mapping';
import type { Store } from '../model/store';
import type { AudioEngine } from './engine';

/** semitones at full pitch wheel */
export const BEND_RANGE = 2;

export class Player {
  private down = new Set<number>();
  private sustained = new Set<number>();
  private pedal = false;
  /** 0 for omni, 1-16 */
  channel = 0;
  onNotes: (down: ReadonlySet<number>) => void = () => {};
  /** every note played, before it sounds: it can set a key range parameter, and then sounds with the new range */
  onNoteOn: (note: number) => void = () => {};
  onBend: (value: number) => void = () => {};
  onModulation: (value: number) => void = () => {};
  /** aftertouch from MIDI, 0..1, the highest of channel and key pressure */
  onPressure: (value: number) => void = () => {};

  constructor(private store: Store, private engine: AudioEngine) {}

  /** @param velocity 1-127 */
  noteOn(note: number, velocity = 100): void {
    this.onNoteOn(note);
    void this.engine.start();
    if (this.down.has(note) || this.sustained.has(note)) {
      this.engine.noteOff(note); // retrigger
      this.sustained.delete(note);
    }
    this.engine.noteOn(note, velocity / 127, voicesFor(this.store.program, this.store.samples, note));
    this.down.add(note);
    this.onNotes(this.down);
  }

  noteOff(note: number): void {
    if (!this.down.delete(note)) {
      return;
    }
    if (this.pedal) {
      this.sustained.add(note);
    } else {
      this.engine.noteOff(note);
    }
    this.onNotes(this.down);
  }

  sustain(on: boolean): void {
    this.pedal = on;
    if (!on) {
      for (const note of this.sustained) {
        this.engine.noteOff(note);
      }
      this.sustained.clear();
    }
  }

  /** @param value -1..1 */
  bend(value: number): void {
    this.engine.bend(value * BEND_RANGE);
    this.onBend(value);
  }

  /** @param value 0..1 */
  modulation(value: number): void {
    this.engine.modulation(value);
    this.onModulation(value);
  }

  /** @param hard cut the sound instead of releasing the notes */
  allNotesOff(hard = false): void {
    this.down.clear();
    this.sustained.clear();
    this.pedal = false;
    this.engine.allNotesOff(hard);
    this.engine.pressure(0);
    this.onNotes(this.down);
  }

  /** Handles channel messages from a MIDI keyboard */
  midi(data: Uint8Array): void {
    const status = data[0] & 0xf0;
    if (status < 0x80 || status === 0xf0 || (this.channel && (data[0] & 0x0f) !== this.channel - 1)) {
      return;
    }
    switch (status) {
      case 0x90:
        if (data[2] > 0) {
          this.noteOn(data[1], data[2]);
        } else {
          this.noteOff(data[1]);
        }
        break;
      case 0x80:
        this.noteOff(data[1]);
        break;
      case 0xb0:
        if (data[1] === 1) {
          this.modulation(data[2] / 127);
        } else if (data[1] === 64) {
          this.sustain(data[2] >= 64);
        } else if (data[1] === 120 || data[1] === 123) {
          this.allNotesOff(data[1] === 120);
        }
        break;
      case 0xe0:
        this.bend(Math.max(-1, ((data[2] << 7) + data[1] - 8192) / 8191));
        break;
      case 0xd0: // channel aftertouch, vibrato as deep as each sample's PRESSURE
        this.engine.pressure(data[1] / 127);
        this.onPressure(data[1] / 127);
        break;
      case 0xa0: // polyphonic aftertouch, the same for one key
        this.engine.keyPressure(data[1], data[2] / 127);
        this.onPressure(data[2] / 127);
        break;
      case 0xc0:
        if (data[1] < this.store.programs.length) {
          this.store.selectProgram(data[1]);
        }
        break;
    }
  }
}
