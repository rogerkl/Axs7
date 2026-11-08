import { describe, expect, test } from 'vitest';
import type { AudioEngine } from '../src/audio/engine';
import { Player } from '../src/audio/player';
import { defaultSound, newKeygroup } from '../src/model/mapping';
import { plainRecipe } from '../src/model/recipe';
import { Store } from '../src/model/store';
import type { Sample } from '../src/model/types';

const data = new Float32Array(100);
const sample: Sample = { id: 's', name: 'S', source: data, sourceRate: 44100, recipe: plainRecipe(), fromSampler: false,
  rate: 44100, data, start: 0, end: 100, loopStart: 0, loopEnd: 100, loopMode: 'off', reverse: false,
  sound: defaultSound(), bankId: null, slot: null, keygroups: [] };

function setup() {
  const store = new Store();
  store.addSample(sample, store.bank, 0);
  store.addKeygroup(newKeygroup('s', 0, { id: 'k', low: 36, high: 48 }));
  store.removeKeygroup(store.program.keygroups[0].id); // the one added for the first sample
  const played: { key: number; samples: string[] }[] = [];
  const engine = {
    start: () => Promise.resolve(),
    noteOn: (key: number, _v: number, voices: { sample: Sample }[]) =>
      played.push({ key, samples: voices.map((v) => v.sample.id) }),
    noteOff: (key: number, velocity: number) => played.push({ key, samples: [`off ${Math.round(velocity * 127)}`] }),
    pressure: (amount: number) => played.push({ key: -1, samples: [`pressure ${amount.toFixed(2)}`] }),
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

  test('channel aftertouch from MIDI reaches the engine, polyphonic doesn\'t, as on the X7000', () => {
    const { player, played } = setup();
    const seen: number[] = [];
    player.onPressure = (v) => seen.push(Math.round(v * 127));
    player.midi(Uint8Array.of(0xd0, 127));
    player.midi(Uint8Array.of(0xa0, 60, 64));
    expect(played).toEqual([{ key: -1, samples: ['pressure 1.00'] }]);
    expect(seen).toEqual([127]);
  });

  test('a note off\'s velocity reaches the engine, 64 for a note on at velocity 0', () => {
    const { player, played } = setup();
    player.midi(Uint8Array.of(0x90, 60, 100));
    player.midi(Uint8Array.of(0x80, 60, 20));
    player.midi(Uint8Array.of(0x90, 62, 100));
    player.midi(Uint8Array.of(0x90, 62, 0));
    expect(played.filter((p) => p.samples[0]?.startsWith('off'))).toEqual([{ key: 60, samples: ['off 20'] },
      { key: 62, samples: ['off 64'] }]);
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
