// MIDI: ports, keyboard channel and transfer settings, with the transfer log. BANK: memory, save and load.

import type { App, View } from '../../app/app';
import { MAX_SLOTS } from '../../protocol/akai';
import { h, pickFiles } from '../dom';
import { ParamCell } from '../param';
import { slotCell } from '../slot';

export function midiView(app: App): View {
  const { midi, settings, player, actions } = app;
  const ports = h('div', { class: 'row' });
  const logEl = h('pre', { class: 'log', 'aria-label': 'MIDI log' });
  const save = () => app.saveSettings();
  const slot = slotCell(app, 'midi.slot');
  const cells = [
    new ParamCell({ key: 'midi.channel', label: 'KEYB CHAN', min: 0, max: 16, coarse: 4, get: () => settings.channel,
      set: (v) => {
        settings.channel = v;
        player.channel = v;
        save();
      }, format: (v) => (v === 0 ? 'OMNI' : String(v)), parse: (t) => (/^omni$/i.test(t) ? 0 : Number(t)) }),
    slot.cell,
    new ParamCell({ key: 'midi.slotCount', label: 'SLOTS', min: 1, max: MAX_SLOTS, coarse: 2,
      get: () => settings.slotCount, set: (v) => app.setSlotCount(v), detail: () => 'ON SAMPLER' }),
    new ParamCell({ key: 'midi.paramsChannel', label: 'SYSEX CHAN', min: 1, max: 16, coarse: 4,
      get: () => settings.paramsChannel + 1, set: (v) => {
        settings.paramsChannel = v - 1;
        save();
      }, detail: () => 'PARAMETERS' }),
    new ParamCell({ key: 'midi.ack', label: 'ACK MS', min: 20, max: 300, coarse: 10, get: () => settings.ackIntervalMs,
      set: (v) => {
        settings.ackIntervalMs = v;
        save();
      }, detail: () => 'RECEIVE PACE' }),
    new ParamCell({ key: 'midi.lookahead', label: 'LOOKAHEAD', min: 200, max: 5000, coarse: 100,
      get: () => settings.lookaheadMs, set: (v) => {
        settings.lookaheadMs = v;
        save();
      }, detail: () => 'MS OF ACKS AHEAD' }),
    new ParamCell({ key: 'midi.filler', label: 'FILLER', min: 0, max: 500, coarse: 10,
      get: () => settings.fillerPerBlock, set: (v) => {
        settings.fillerPerBlock = v;
        save();
      }, detail: (v) => `${(v * 0.32).toFixed(1)}MS PAUSE` }),
  ];

  function render(): void {
    const link = midi.link;
    if (midi.problem) {
      ports.replaceChildren(h('span', { class: 'warn' }, midi.problem));
    } else if (!link) {
      ports.replaceChildren(
        h('button', { class: 'soft', onClick: () => midi.connect() }, 'CONNECT MIDI'),
        h('span', { class: 'info' }, midi.error ?? 'The browser asks for permission to use MIDI with sysex.'));
    } else {
      const select = (label: string, list: MIDIPort[], current: MIDIPort | null, change: (id: string | null) => void) => {
        const s = h('select', { 'aria-label': label, onChange: () => change(s.value || null) },
          h('option', { value: '' }, '– NONE –'),
          ...list.map((p) => h('option', { value: p.id, selected: p.id === current?.id }, p.name ?? p.id)));
        return h('label', { class: 'port' }, h('span', { class: 'param-label' }, label), s);
      };
      ports.replaceChildren(
        select('INPUT', link.inputs(), link.input, (id) => midi.select(id, link.output?.id ?? null)),
        select('OUTPUT', link.outputs(), link.output, (id) => midi.select(link.input?.id ?? null, id)));
    }
    cells.forEach((c) => c.refresh()); // a request for parameters keeps the channel that answered
    logEl.textContent = midi.log.slice(-60).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }

  const previous = midi.onChange;
  midi.onChange = () => {
    previous();
    render();
  };
  render();
  return {
    el: h('div', { class: 'view view-midi' }, ports,
      h('div', { class: 'params' }, ...cells.map((c) => c.el)),
      h('div', { class: 'row' },
        h('button', { class: 'soft', onClick: () => actions.requestParams() }, 'REQUEST PARAMETERS'),
        h('span', { class: 'info' }, 'RECEIVE asks for the slot\'s START, END, scan mode, rate, sound and key '
          + 'ranges on SYSEX CHAN, as a sample dump doesn\'t carry them. This only asks and logs them: on SYSEX CHAN '
          + 'first, then on the other channels, and keeps the one that is answered.')),
      h('p', { class: 'info' }, 'SLOTS is how many sample slots the sampler has: 6 on a standard X7000, more '
        + 'with a memory expansion. The same input plays the programs (also from the sampler\'s own keyboard) and '
        + 'receives sample dumps. Use Chrome or Edge, from localhost or https. Filler adds pauses between blocks '
        + 'when sending, the X7000 doesn\'t need them. A sample is sent as it sounds: normalizing and 12 bit are its '
        + 'own settings (SAMPLE view).'),
      logEl),
    dispose: () => {
      midi.onChange = previous;
      slot.dispose();
    },
  };
}

export function bankView(app: App): View {
  const { store, actions } = app;
  const stats = h('div', { class: 'params' });
  const programs = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Programs' });

  function render(): void {
    const mb = store.memoryBytes() / 1024 / 1024;
    const stat = (label: string, value: string) =>
      h('div', { class: 'param static' }, h('div', { class: 'param-label' }, label), h('div', { class: 'param-value' }, value));
    stats.replaceChildren(stat('SAMPLES', String(store.samples.size)), stat('PROGRAMS', String(store.programs.length)),
      stat('MEMORY', `${mb.toFixed(mb < 10 ? 1 : 0)}MB`));
    programs.replaceChildren(
      h('div', { class: 'list-head' }, h('span', { class: 'c-num' }, '#'), h('span', { class: 'c-name' }, 'PROGRAM'),
        h('span', { class: 'c-small' }, 'KEYGROUPS')),
      ...store.programs.map((p, i) => h('button', {
        class: `list-row${i === store.programIndex ? ' selected' : ''}`, role: 'option',
        'aria-selected': i === store.programIndex, onClick: () => store.selectProgram(i),
      }, h('span', { class: 'c-num' }, String(i + 1).padStart(2, '0')), h('span', { class: 'c-name' }, p.name),
      h('span', { class: 'c-small' }, String(p.keygroups.length)))));
  }

  render();
  const off = (['samples', 'programs', 'keygroups', 'program'] as const).map((e) => store.on(e, render));
  return {
    el: h('div', { class: 'view view-bank' },
      h('div', { class: 'detail' }, stats,
        h('div', { class: 'row' },
          h('button', { class: 'soft', onClick: () => actions.saveBank() }, 'SAVE BANK'),
          h('button', { class: 'soft', onClick: async () => {
            const [file] = await pickFiles('.zip', false);
            if (file) {
              await actions.loadBank(file);
            }
          } }, 'LOAD BANK'),
          h('button', { class: 'soft danger', onClick: () => actions.clearMemory() }, 'CLEAR MEMORY')),
        h('p', { class: 'info' }, 'A bank is a zip file with all samples as WAV files (with their loops) and the '
          + 'programs in bank.json. Memory is also kept in the browser between visits.')),
      programs),
    dispose: () => off.forEach((f) => f()),
  };
}
