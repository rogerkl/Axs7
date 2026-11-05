// PROGRAM: the current bank and program, P1-P32 as on the X7000, the program's name and its keygroups, each a sample
// over a key range with its pitch, like an X7000 program ("P1:S1:L=36:H=96"). The sound is the sample's (OUT and
// LFO). A keygroup can be muted or soloed to hear it alone, and moved to another program.

import type { App, View } from '../../app/app';
import { newKeygroup } from '../../model/mapping';
import { noteName, parseNote } from '../../model/notes';
import type { Keygroup } from '../../model/types';
import { h } from '../dom';
import { ParamCell, choiceCell } from '../param';

/** Key range and root: like on the sampler, playing a note sets them while selected */
const noteSpec = { min: 0, max: 127, coarse: 12, format: noteName, parse: parseNote, noteInput: true,
  detail: () => 'OR PLAY KEY' };

export function programView(app: App): View {
  const { store, lcd } = app;
  const head = h('div', { class: 'row program-row' });
  const table = h('div', { class: 'kg-table', role: 'table', 'aria-label': 'Keygroups' });
  let cells: ParamCell[] = [];

  function buildHead(): void {
    const name = h('input', { class: 'name-input', value: store.program.name, maxLength: 24,
      'aria-label': 'Program name', onChange: () => store.updateProgram({ name: name.value.trim() || 'PROGRAM' }) });
    const bank = new ParamCell({
      key: 'program.bank', label: 'BANK', min: 1, max: store.banks.length, coarse: 1,
      get: () => store.bankIndex + 1, set: (v) => store.selectBank(v - 1),
      detail: () => store.bank.name,
    });
    const program = new ParamCell({
      key: 'program.number', label: 'PROGRAM', min: 1, max: store.programs.length, coarse: 8,
      get: () => store.programIndex + 1, set: (v) => store.selectProgram(v - 1),
      format: (v) => String(v).padStart(2, '0'),
    });
    head.replaceChildren(bank.el, program.el, name,
      h('button', { class: 'soft danger', onClick: () => {
        if (store.program.keygroups.length === 0
          || confirm(`Clear ${store.program.name}, take its keygroups out? The samples stay in memory.`)) {
          store.clearProgram();
        }
      } }, 'CLEAR PROGRAM'));
  }

  function kgCell(kg: Keygroup, field: 'low' | 'high' | 'root' | 'semitones' | 'cents', label: string)
    : ParamCell {
    const ranges = {
      low: noteSpec, high: noteSpec, root: noteSpec,
      semitones: { min: -60, max: 60, coarse: 12, format: (v: number) => (v > 0 ? `+${v}` : String(v)) },
      cents: { min: -100, max: 100, coarse: 10, format: (v: number) => (v > 0 ? `+${v}` : String(v)) },
    } as const;
    const cell = new ParamCell({
      key: `kg.${kg.id}.${field}`, label, ...ranges[field],
      // a played note sets LOW and moves on to HIGH, like on the sampler
      noteNext: field === 'low' ? `kg.${kg.id}.high` : undefined,
      get: () => store.program.keygroups.find((k) => k.id === kg.id)?.[field] ?? 0,
      set: (v) => store.updateKeygroup(kg.id, { [field]: v }),
    }, 'compact');
    cell.el.addEventListener('pointerdown', () => store.selectKeygroup(kg.id));
    return cell;
  }

  /** Mute or solo: a button that is lit while on */
  function listenButton(kg: Keygroup, label: string, on: boolean, title: string, toggle: () => void): HTMLElement {
    return h('button', { class: `soft small listen${on ? ' on' : ''}`, 'aria-pressed': on, title,
      'aria-label': `${title}, keygroup ${store.program.keygroups.indexOf(kg) + 1}`, onClick: toggle }, label);
  }

  /** Every program of every bank to move a keygroup to, by bank */
  function moveSelect(kg: Keygroup, i: number): HTMLSelectElement {
    const pad = (n: number) => String(n).padStart(2, '0');
    const select = h('select', { class: 'move-select', 'aria-label': `Move keygroup ${i + 1} to`,
      title: 'Move the keygroup to another program, of this bank or another',
      onChange: () => {
        const [bank, program] = select.value.split(':').map(Number);
        if (store.moveKeygroup(kg.id, bank, program)) {
          lcd.flash(`MOVED TO ${store.banks.length > 1 ? `B${bank + 1} ` : ''}P${pad(program + 1)}`);
        }
      } },
    h('option', { value: '', disabled: true, selected: true }, 'MOVE TO…'),
    ...store.banks.map((bank, b) => h('optgroup', { label: `B${b + 1} ${bank.name}` },
      ...bank.programs.map((p, j) => h('option', { value: `${b}:${j}`,
        disabled: b === store.bankIndex && j === store.programIndex }, `P${pad(j + 1)} ${p.name}`)))));
    return select;
  }

  function buildTable(): void {
    cells = [];
    const samples = [...store.samples.values()];
    const rows = store.program.keygroups.map((kg, i) => {
      const select = h('select', { class: 'sample-select', 'aria-label': `Keygroup ${i + 1} sample`,
        onChange: () => store.updateKeygroup(kg.id, { sampleId: select.value || null }) },
      h('option', { value: '' }, '– NO SAMPLE –'),
      ...samples.map((s) => h('option', { value: s.id, selected: s.id === kg.sampleId }, s.name)));
      // the X7000's CONSTANT PITCH: every key plays the root's pitch
      const pitch = choiceCell(`kg.${kg.id}.pitch`, 'PITCH', ['track', 'fixed'] as const, ['TRACK', 'FIXED'],
        () => (store.program.keygroups.find((k) => k.id === kg.id)?.fixedPitch ? 'fixed' : 'track'),
        (v) => store.updateKeygroup(kg.id, { fixedPitch: v === 'fixed' }), 'compact');
      pitch.el.addEventListener('pointerdown', () => store.selectKeygroup(kg.id));
      const rowCells = [kgCell(kg, 'low', 'LOW'), kgCell(kg, 'high', 'HIGH'), kgCell(kg, 'root', 'ROOT'),
        kgCell(kg, 'semitones', 'SEMI'), kgCell(kg, 'cents', 'FINE'), pitch];
      cells.push(...rowCells);
      return h('div', {
        class: `kg-row${kg.id === store.selectedKeygroupId ? ' selected' : ''}`, role: 'row',
        onPointerdown: () => store.selectKeygroup(kg.id),
      },
      h('span', { class: 'kg-num' }, `KG${String(i + 1).padStart(2, '0')}`),
      select, ...rowCells.map((c) => c.el),
      listenButton(kg, 'M', store.muted.has(kg.id), 'Mute: not played', () => store.toggleMute(kg.id)),
      listenButton(kg, 'S', store.soloed.has(kg.id), 'Solo: only the soloed keygroups are played',
        () => store.toggleSolo(kg.id)),
      moveSelect(kg, i),
      h('button', { class: 'soft small danger', title: 'Remove keygroup', 'aria-label': `Remove keygroup ${i + 1}`,
        onClick: () => store.removeKeygroup(kg.id) }, '✕'));
    });
    table.replaceChildren(...rows,
      ...(rows.length ? [] : [h('div', { class: 'list-empty' }, 'NO KEYGROUPS. ADD ONE FOR THE SELECTED SAMPLE.')]));
  }

  function markSelected(): void {
    store.program.keygroups.forEach((kg, i) =>
      table.children[i]?.classList.toggle('selected', kg.id === store.selectedKeygroupId));
  }

  buildHead();
  buildTable();
  const off = [
    store.on('programs', () => {
      buildHead();
      buildTable();
    }),
    store.on('keygroups', buildTable),
    store.on('samples', buildTable),
    store.on('program', () => cells.forEach((c) => c.refresh())),
    store.on('selection', markSelected),
  ];
  return {
    el: h('div', { class: 'view view-keygroups' }, head, table,
      h('div', { class: 'row' },
        h('button', { class: 'soft', onClick: () => {
          const s = store.selectedSample;
          store.addKeygroup(newKeygroup(s?.id ?? null));
        } }, 'ADD KEYGROUP'),
        h('span', { class: 'info' }, 'A bank has 32 programs, as the sampler, and remembers which sample is in '
          + 'each of the sampler\'s slots (BANK view). Select LOW, HIGH or ROOT and play a note to set it, like on the '
          + 'sampler '
          + '(LOW moves on to HIGH). PITCH FIXED plays every key at the root\'s pitch, the sampler\'s CONSTANT '
          + 'PITCH. The sound is the sample\'s, see OUT and LFO. A new keygroup gets the selected sample, a bar above '
          + 'the keys selects its keygroup: drag an end of it to move LOW or HIGH, or the middle to move the keygroup '
          + 'with its ROOT. M mutes a keygroup and S solos it, to hear one of overlapping keygroups alone (only here, '
          + 'they aren\'t saved or sent). MOVE TO moves a keygroup to another program. Notes are named as on the '
          + 'sampler, C3 = MIDI 60.'))),
    dispose: () => off.forEach((f) => f()),
  };
}
