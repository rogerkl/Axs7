import { describe, expect, test } from 'vitest';
import type { AudioEngine } from '../src/audio/engine';
import { Player } from '../src/audio/player';
import { defaultSound, newKeygroup } from '../src/model/mapping';
import { Store } from '../src/model/store';
import type { Sample } from '../src/model/types';

const sample: Sample = { id: 's', name: 'S', rate: 44100, data: new Float32Array(100), start: 0, end: 100,
  loopStart: 0, loopEnd: 100, loopMode: 'off', reverse: false, sound: defaultSound() };

function setup() {
  const store = new Store();
  store.addSample(sample);
  store.addKeygroup(newKeygroup('s', { id: 'k', low: 36, high: 48 }));
  store.removeKeygroup(store.program.keygroups[0].id); // the one added for the first sample
  const played: { key: number; samples: string[] }[] = [];
  const engine = {
    start: () => Promise.resolve(),
    noteOn: (key: number, _v: number, voices: { sample: Sample }[]) =>
      played.push({ key, samples: voices.map((v) => v.sample.id) }),
    noteOff: () => {},
  } as unknown as AudioEngine;
  return { store, player: new Player(store, engine), played };
}

describe('player', () => {
  test('a note sets a key range before it sounds, so it sounds with the new range', () => {
    const { store, player, played } = setup();
    player.noteOn(72);
    expect(played).toEqual([{ key: 72, samples: [] }]); // outside 36-48
    player.onNoteOn = (note) => store.updateKeygroup('k', { high: note });
    player.noteOn(84);
    expect(store.selectedKeygroup?.high).toBe(84);
    expect(played[1]).toEqual({ key: 84, samples: ['s'] });
  });

  test('notes from MIDI go the same way, on the keyboard channel', () => {
    const { player, played } = setup();
    const notes: number[] = [];
    player.onNoteOn = (note) => notes.push(note);
    player.channel = 2;
    player.midi(Uint8Array.of(0x90, 40, 100)); // channel 1, ignored
    player.midi(Uint8Array.of(0x91, 41, 100));
    player.midi(Uint8Array.of(0x91, 42, 0)); // note off as note on with velocity 0
    expect(notes).toEqual([41]);
    expect(played.map((p) => p.key)).toEqual([41]);
  });
});
