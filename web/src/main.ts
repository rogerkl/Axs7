import './style.css';
import { Actions } from './app/actions';
import type { App, View } from './app/app';
import { MidiController } from './app/midi';
import { loadSettings, saveSettings } from './app/settings';
import type { ViewName } from './app/settings';
import { AudioEngine } from './audio/engine';
import { Player } from './audio/player';
import { noteName } from './model/notes';
import { Persistence } from './model/persist';
import { Store } from './model/store';
import { MAX_SLOTS } from './protocol/akai';
import { Fader, Knob, Wheel, panelButton } from './ui/controls';
import { h, pickFiles, typing } from './ui/dom';
import { Keyboard } from './ui/keyboard';
import { Lcd } from './ui/lcd';
import { dataEntry } from './ui/param';
import { slotStepper } from './ui/slot';
import { programView } from './ui/views/keygroups';
import { samplesView } from './ui/views/samples';
import { lfoView, outView } from './ui/views/sound';
import { bankView, midiView } from './ui/views/system';

const SECTIONS: [ViewName, string, (app: App) => View][] = [
  ['samples', 'SAMPLE', samplesView],
  ['out', 'OUT', outView],
  ['lfo', 'LFO', lfoView],
  ['program', 'PROGRAM', programView],
  ['midi', 'MIDI', midiView],
  ['bank', 'BANK', bankView],
];

/** Computer keyboard as a piano, from the base note: A W S E D F T G Y H U J K O L P and the key after L */
const PIANO_KEYS: Record<string, number> = {
  KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11,
  KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16,
};

async function main(): Promise<void> {
  const settings = loadSettings();
  const store = new Store();
  const engine = new AudioEngine(store);
  const player = new Player(store, engine);
  player.channel = settings.channel;
  const lcd = new Lcd();
  const midi = new MidiController(settings, player);
  const bay = h('main', { class: 'bay', 'aria-live': 'off' });
  let view: View | null = null;
  let voices = 0;
  const sectionButtons = new Map<ViewName, ReturnType<typeof panelButton>>();
  const slotListeners = new Set<() => void>();

  const app: App = {
    store, engine, player, lcd, settings, midi, actions: null as unknown as Actions,
    saveSettings: () => saveSettings(settings),
    setSlot(slot) {
      settings.slot = Math.max(0, Math.min(settings.slotCount - 1, slot));
      saveSettings(settings);
      for (const listener of slotListeners) {
        listener();
      }
    },
    setSlotCount(count) {
      settings.slotCount = Math.max(1, Math.min(MAX_SLOTS, count));
      app.setSlot(settings.slot);
    },
    onSlot(listener) {
      slotListeners.add(listener);
      return () => slotListeners.delete(listener);
    },
    showView(name) {
      view?.dispose();
      const section = SECTIONS.find(([n]) => n === name) ?? SECTIONS[0];
      view = section[2](app);
      bay.replaceChildren(view.el);
      settings.view = section[0];
      saveSettings(settings);
      for (const [n, b] of sectionButtons) {
        b.setLed(n === section[0]);
      }
      lcd.render();
    },
  };
  settings.slotCount = Math.max(1, Math.min(MAX_SLOTS, settings.slotCount));
  settings.slot = Math.max(0, Math.min(settings.slotCount - 1, settings.slot));
  const actions = new Actions(app);
  app.actions = actions;
  engine.volume(settings.volume ** 2);
  engine.polyphony(settings.polyphony);
  engine.onError = (message) => {
    midi.logLine(message, 'error');
    lcd.flash('AUDIO ENGINE ERROR');
  };

  try {
    const persistence = await Persistence.open((e) => midi.logLine(`Could not save to the browser: ${e}`, 'warn'));
    const saved = await persistence.load();
    if (saved.samples.length || saved.programs.length) {
      store.replaceAll(saved.samples, saved.programs, saved.programIndex);
    }
    persistence.attach(store);
  } catch (e) {
    midi.logLine(`Memory isn't kept between visits: ${e}`, 'warn');
  }

  // ---- display and data entry
  lcd.status = () => {
    // a sample's settings show the sample, the rest the program, like the X7000's S1: and P1:
    const s = store.selectedSample;
    const sampleView = s && ['samples', 'out', 'lfo'].includes(settings.view);
    const line1 = Lcd.pair(sampleView
      ? `S${String([...store.samples.keys()].indexOf(s.id) + 1).padStart(2, '0')} ${s.name}`
      : `P${String(store.programIndex + 1).padStart(2, '0')} ${store.program.name}`, voices ? `${voices}V` : '');
    const cell = dataEntry.cell;
    if (cell?.el.isConnected) {
      const detail = cell.spec.detail?.(cell.spec.get());
      return [line1, Lcd.pair(cell.spec.label, cell.text() + (detail ? ` ${detail}` : ''))];
    }
    if (engine.state !== 'running') {
      return [line1, 'PLAY A KEY TO START'];
    }
    return [line1, store.selectedSample ? `SAMPLE ${store.selectedSample.name}` : 'LOAD OR RECEIVE A SAMPLE'];
  };
  dataEntry.onChange = () => lcd.clearMessage();
  engine.onVoices = (n) => {
    voices = n;
    lcd.render();
    voicesEl.textContent = `${n}`;
  };

  // ---- front panel
  const pitch = new Wheel('PITCH', { min: -1, max: 1, spring: true }, (v) => player.bend(v));
  const mod = new Wheel('MOD', { min: 0, max: 1, spring: false }, (v) => player.modulation(v));
  player.onBend = (v) => pitch.set(v);
  player.onModulation = (v) => mod.set(v);
  const volume = new Fader('VOLUME', settings.volume, (v) => {
    settings.volume = v;
    engine.volume(v ** 2);
    saveSettings(settings);
  });
  const knob = new Knob((steps, coarse) => dataEntry.nudge(steps, coarse));

  const audition = panelButton('PLAY SMP', () => {}, { title: 'Hold to play the selected sample at its own pitch' });
  audition.button.addEventListener('pointerdown', () => actions.auditionStart(store.selectedSample));
  for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
    audition.button.addEventListener(type, () => actions.auditionStop());
  }
  const smallButtons = [
    panelButton('PROG ◀', () => store.selectProgram(store.programIndex - 1), { title: 'Previous program' }),
    panelButton('PROG ▶', () => store.selectProgram(store.programIndex + 1), { title: 'Next program' }),
    panelButton('NEW PROG', () => {
      store.addProgram();
      app.showView('program');
    }, { title: 'New program' }),
    panelButton('LOAD WAV', async () => actions.loadFiles(await pickFiles('.wav,audio/*', true)),
      { title: 'Load WAV or other audio files into memory' }),
    audition,
    panelButton('PANIC', () => player.allNotesOff(true), { title: 'Stop all sound' }),
  ];

  const receive = panelButton('RECEIVE', () => actions.receive(), { led: true });
  const send = panelButton('SEND', () => actions.send(), { led: true });
  const slotTitles = () => {
    receive.button.title = `Receive the sample in slot ${settings.slot + 1} from the sampler (again to cancel)`;
    send.button.title = `Send the selected sample to slot ${settings.slot + 1} on the sampler, it replaces what is there`;
  };
  slotTitles();
  app.onSlot(slotTitles);
  actions.onBusy = () => {
    receive.setLed(actions.busy === 'receive', true);
    send.setLed(actions.busy === 'send', true);
  };
  const transferButtons = [receive, send,
    panelButton('SAVE', () => actions.saveBank(), { title: 'Save the memory as a bank (zip file)' }),
    panelButton('LOAD', async () => {
      const [file] = await pickFiles('.zip', false);
      if (file) {
        await actions.loadBank(file);
      }
    }, { title: 'Load a bank (zip file)' }),
  ];

  const strip = h('div', { class: 'strip' });
  const band = h('div', { class: 'strip-band' });
  const stripButtons = h('div', { class: 'strip-buttons' });
  for (const [name, label] of SECTIONS) {
    band.append(h('div', { class: 'strip-cell' }, label));
    const b = panelButton(label, () => app.showView(name), { led: true, printed: false });
    sectionButtons.set(name, b);
    stripButtons.append(b.el);
  }
  strip.append(band, stripButtons);

  const screws = ['tl', 'tr', 'bl', 'br'].map((p) => h('span', { class: `screw ${p}`, 'aria-hidden': 'true' }));
  const top = h('section', { class: 'top-panel', 'aria-label': 'Front panel' }, ...screws,
    h('div', { class: 'brand-row' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-name' }, 'Axs7'),
        h('span', { class: 'brand-sub' }, 'virtual sampler')),
      h('div', { class: 'tagline' }, '12-BIT SAMPLE TRANSFER · WEB MIDI · MULTI-SAMPLE PROGRAMS'),
      h('div', { class: 'model-mark', 'aria-hidden': 'true' }, 'AXS7')),
    h('div', { class: 'controls' },
      h('div', { class: 'block dark wheels' }, pitch.el, mod.el, volume.el),
      h('div', { class: 'block dark display' }, lcd.el, knob.el),
      h('div', { class: 'block buttons6' }, ...smallButtons.map((b) => b.el)),
      h('div', { class: 'block dark main' }, slotStepper(app),
        h('div', { class: 'buttons4' }, ...transferButtons.map((b) => b.el)), strip)));

  // ---- keyboard
  const keyboard = new Keyboard({
    noteOn: (n, v) => player.noteOn(n, v),
    noteOff: (n) => player.noteOff(n),
    selectKeygroup: (id) => {
      store.selectKeygroup(id);
      if (settings.view !== 'program') {
        app.showView('program');
      }
    },
  });
  player.onNotes = (down) => keyboard.setDown(down);
  player.onNoteOn = (note) => dataEntry.note(note);
  const updateKeyboard = () => keyboard.setKeygroups(store.program, store.selectedKeygroupId,
    new Map([...store.samples.values()].map((s) => [s.id, s.name])));
  const memoryEl = h('span', { class: 'plate-value' });
  const voicesEl = h('span', { class: 'plate-value' }, '0');
  const octaveEl = h('span', { class: 'plate-value' });
  const updatePlate = () => {
    memoryEl.textContent = `${store.samples.size} / ${(store.memoryBytes() / 1024 / 1024).toFixed(1)}MB`;
  };
  let octave = 60;
  const showOctave = () => {
    octaveEl.textContent = `${noteName(octave)}–${noteName(octave + 16)}`;
  };
  const plate = h('div', { class: 'plate' },
    h('div', { class: 'plate-title' }, 'AXS7 VIRTUAL SAMPLER'),
    h('div', { class: 'plate-row' }, h('span', {}, 'MEMORY'), memoryEl),
    h('div', { class: 'plate-row' }, h('span', {}, 'VOICES'), voicesEl),
    h('div', { class: 'plate-row', title: 'Computer keys A W S E D … play, Z and X change octave' },
      h('span', {}, 'KEYS'), octaveEl));
  const lower = h('section', { class: 'lower', 'aria-label': 'Keyboard' }, plate, keyboard.el);

  document.getElementById('app')!.append(h('div', { class: 'chassis' }, top, bay, lower));

  for (const event of ['samples', 'sample', 'programs', 'program', 'keygroups', 'selection'] as const) {
    store.on(event, () => {
      updateKeyboard();
      updatePlate();
      lcd.render();
    });
  }
  updateKeyboard();
  updatePlate();
  showOctave();
  app.showView(settings.view);

  // ---- audio starts with the first gesture, browsers don't allow it before
  const startAudio = () => {
    engine.start().then(() => lcd.render(), () => {});
  };
  document.addEventListener('pointerdown', startAudio, { capture: true });
  document.addEventListener('keydown', startAudio, { capture: true });

  // ---- computer keyboard: piano keys, octave, data entry with the arrow keys
  const held = new Map<string, number>();
  document.addEventListener('keydown', (e) => {
    if (typing() || e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    const steps = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 1, PageDown: -1 }[e.key];
    if (steps && dataEntry.cell?.el.isConnected) {
      e.preventDefault();
      dataEntry.nudge(steps, e.shiftKey || e.key.startsWith('Page'));
      return;
    }
    if (e.code === 'KeyZ' || e.code === 'KeyX') {
      octave = Math.max(24, Math.min(96, octave + (e.code === 'KeyZ' ? -12 : 12)));
      showOctave();
      lcd.flash(`KEYS FROM ${noteName(octave)}`);
      return;
    }
    const offset = PIANO_KEYS[e.code];
    if (offset !== undefined) {
      e.preventDefault();
      if (!e.repeat && !held.has(e.code)) {
        held.set(e.code, octave + offset);
        player.noteOn(octave + offset, 100);
      }
    }
  });
  document.addEventListener('keyup', (e) => {
    const note = held.get(e.code);
    if (note !== undefined) {
      held.delete(e.code);
      player.noteOff(note);
    }
  });
  window.addEventListener('blur', () => {
    for (const note of held.values()) {
      player.noteOff(note);
    }
    held.clear();
  });

  lcd.render();
  if (import.meta.env.DEV) {
    Object.assign(window, { axs7: app }); // for poking at it from the console and browser tests
  }
  await midi.autoConnect();
}

void main();
