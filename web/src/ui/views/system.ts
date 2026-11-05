// MIDI: ports, keyboard channel and transfer settings, with the transfer log. BANK: the banks, the samples in their
// slots and their programs, and the memory saved and loaded.

import type { App, View } from '../../app/app';
import { MAX_SLOTS } from '../../protocol/akai';
import { h, pickFiles } from '../dom';
import { ParamCell } from '../param';
import { slotCell } from '../slot';
import type { Sample } from '../../model/types';

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
    new ParamCell({ key: 'midi.wholeSample', label: 'RECEIVE ALL', min: 0, max: 1, get: () => (settings.wholeSample ? 1 : 0),
      set: (v) => {
        settings.wholeSample = v === 1;
        save();
      }, format: (v) => (v ? 'ON' : 'OFF'), parse: (t) => (/^on$/i.test(t) ? 1 : /^off$/i.test(t) ? 0 : null),
      detail: () => 'START 0 END MAX' }),
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
        h('span', { class: 'info' }, 'RECEIVE and SEND use the slot\'s START, END, scan mode, rate, sound and key '
          + 'ranges, which a sample dump doesn\'t carry, on SYSEX CHAN. As the sampler only sends START to END, '
          + 'RECEIVE ALL ON sets START to 0 and END to the most on the sampler while receiving, then back. This '
          + 'button only asks and logs them: on SYSEX CHAN first, then on the other channels, and keeps the one that '
          + 'is answered.')),
      h('p', { class: 'info' }, 'SLOTS is how many sample slots the sampler has: 6 on a standard one, more '
        + 'with a memory expansion. The same input plays the programs (also from an X7000\'s own keyboard) and '
        + 'receives sample dumps. Use Chrome or Edge, from localhost or https. Filler adds pauses between blocks '
        + 'when sending, the sampler doesn\'t need them. A sample is sent as it sounds: normalizing and 12 bit are its '
        + 'own settings (SAMPLE view).'),
      logEl),
    dispose: () => {
      midi.onChange = previous;
      slot.dispose();
    },
  };
}

export function bankView(app: App): View {
  const { store, actions, settings } = app;
  const head = h('div', { class: 'row program-row' });
  const stats = h('div', { class: 'params' });
  const slots = h('div', { class: 'list slots', role: 'list', 'aria-label': 'Slots' });
  const programs = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Programs' });

  function buildHead(): void {
    const name = h('input', { class: 'name-input', value: store.bank.name, maxLength: 24, 'aria-label': 'Bank name',
      onChange: () => store.updateBank({ name: name.value.trim() || 'BANK' }) });
    const cell = new ParamCell({
      key: 'bank.number', label: 'BANK', min: 1, max: store.banks.length, coarse: 1,
      get: () => store.bankIndex + 1, set: (v) => store.selectBank(v - 1), detail: () => `OF ${store.banks.length}`,
    });
    head.replaceChildren(cell.el, name,
      h('button', { class: 'soft', onClick: () => store.addBank() }, 'NEW BANK'),
      h('button', { class: 'soft danger', onClick: () => {
        if (confirm(`Delete ${store.bank.name}, its programs and slots? The samples stay in memory.`)) {
          store.removeBank();
        }
      } }, 'DELETE BANK'));
  }

  function render(): void {
    const mb = store.memoryBytes() / 1024 / 1024;
    const stat = (label: string, value: string) =>
      h('div', { class: 'param static' }, h('div', { class: 'param-label' }, label), h('div', { class: 'param-value' }, value));
    stats.replaceChildren(stat('SAMPLES', String(store.samples.size)), stat('BANKS', String(store.banks.length)),
      stat('MEMORY', `${mb.toFixed(mb < 10 ? 1 : 0)}MB`));
    const samples = [...store.samples.values()];
    const bank = store.bank;
    const inBank = store.samplesIn(bank);
    // the sampler's slots, and any slot past them a sample of the bank is in
    const count = Math.max(settings.slotCount, ...inBank.map((s) => s.slot! + 1));
    /** where a sample is, for picking it */
    const where = (s: Sample) => {
      const b = store.banks.findIndex((x) => x.id === s.bankId);
      const slot = s.slot === null ? '' : `S${String(s.slot + 1).padStart(2, '0')}`;
      return b < 0 ? ` (NO BANK${slot ? `, ${slot}` : ''})` : s.bankId === bank.id ? ` (${slot})` : ` (B${b + 1} ${slot})`;
    };
    slots.replaceChildren(
      h('div', { class: 'list-head' }, h('span', { class: 'c-num' }, 'SLOT'), h('span', { class: 'c-name' }, 'SAMPLE')),
      ...Array.from({ length: count }, (_, i) => {
        const id = store.sampleAt(bank, i)?.id ?? null;
        const select = h('select', { class: 'sample-select', 'aria-label': `Slot ${i + 1} sample`,
          title: 'The sample in this slot of the bank, with its keygroups. One picked here leaves its bank or slot; '
            + 'the sample here before is then in no bank',
          onChange: () => {
            if (select.value) {
              const out = store.place(select.value, bank, i);
              if (out) {
                app.lcd.flash(`${out.name} NOW IN NO BANK`);
              }
            } else {
              store.clearSlot(bank, i);
            }
          } },
        h('option', { value: '' }, '– NONE –'),
        ...samples.map((s) => h('option', { value: s.id, selected: s.id === id }, `${s.name}${where(s)}`)));
        // the slot RECEIVE and SEND use
        return h('div', { class: `list-row${i === settings.slot ? ' selected' : ''}`, role: 'listitem',
          title: 'Click the number for RECEIVE and SEND to use this slot' },
        h('button', { class: 'c-num slot-pick', onClick: () => app.setSlot(i) }, `S${String(i + 1).padStart(2, '0')}`),
        select);
      }));
    programs.replaceChildren(
      h('div', { class: 'list-head' }, h('span', { class: 'c-num' }, '#'), h('span', { class: 'c-name' }, 'PROGRAM'),
        h('span', { class: 'c-small' }, 'KEYGROUPS')),
      ...store.programs.map((p, i) => h('button', {
        class: `list-row${i === store.programIndex ? ' selected' : ''}`, role: 'option',
        'aria-selected': i === store.programIndex, onClick: () => store.selectProgram(i),
      }, h('span', { class: 'c-num' }, `P${String(i + 1).padStart(2, '0')}`), h('span', { class: 'c-name' }, p.name),
      h('span', { class: 'c-small' }, p.keygroups.length ? String(p.keygroups.length) : '–'))));
  }

  buildHead();
  render();
  const off = [
    ...(['samples', 'keygroups', 'program'] as const).map((e) => store.on(e, render)),
    store.on('programs', () => {
      buildHead();
      render();
    }),
    app.onSlot(render),
  ];
  return {
    el: h('div', { class: 'view view-bank' },
      h('div', { class: 'detail' }, head,
        h('p', { class: 'info' }, 'A bank is what the sampler holds at once: a sample in each of its slots, and its '
          + '32 programs. As on the sampler, the key ranges are the samples\': a program plays the bank\'s samples, '
          + 'and a sample\'s keygroups go with it to another bank or slot. A sample is in one slot of one bank, or in '
          + 'no bank (then no program plays it): one put in a slot leaves the sample there in no bank. RECEIVE and '
          + 'loading a file put the sample in a slot of the current bank. Samples in no bank are in memory still.'),
        slots,
        h('div', { class: 'row' },
          h('button', { class: 'soft', onClick: () => actions.receiveBank() }, 'RECEIVE BANK'),
          h('button', { class: 'soft', onClick: () => actions.sendBank() }, 'SEND BANK'),
          h('span', { class: 'info' }, 'Every slot (SLOTS in MIDI) from the sampler into this bank, or this bank\'s '
            + 'samples to their slots, each with its parameters as RECEIVE and SEND do. Press again, or RECEIVE or '
            + 'SEND, to stop.')),
        stats,
        h('div', { class: 'row' },
          h('button', { class: 'soft', onClick: () => actions.saveMemory() }, 'SAVE MEMORY'),
          h('button', { class: 'soft', onClick: async () => {
            const [file] = await pickFiles('.zip', false);
            if (file) {
              await actions.loadMemory(file);
            }
          } }, 'LOAD MEMORY'),
          h('button', { class: 'soft danger', onClick: () => actions.clearMemory() }, 'CLEAR MEMORY')),
        h('p', { class: 'info' }, 'A memory file is a zip file with every bank and sample: the samples as WAV files '
          + '(with their loops), the banks and settings in memory.json. Bank files from before banks load too. Memory '
          + 'is also kept in the browser between visits.')),
      programs),
    dispose: () => off.forEach((f) => f()),
  };
}
