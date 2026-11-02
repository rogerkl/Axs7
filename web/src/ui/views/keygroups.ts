// PROGRAM: the current program's name and its keygroups, each a sample over a key range with its pitch, like an
// X7000 program ("P1:S1:L=36:H=96"). The sound is the sample's (OUT and LFO).

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
  const { store } = app;
  const head = h('div', { class: 'row program-row' });
  const table = h('div', { class: 'kg-table', role: 'table', 'aria-label': 'Keygroups' });
  let cells: ParamCell[] = [];

  function buildHead(): void {
    const name = h('input', { class: 'name-input', value: store.program.name, maxLength: 24,
      'aria-label': 'Program name', onChange: () => store.updateProgram({ name: name.value.trim() || 'PROGRAM' }) });
    const program = new ParamCell({
      key: 'program.number', label: 'PROGRAM', min: 1, max: store.programs.length, coarse: 1,
      get: () => store.programIndex + 1, set: (v) => store.selectProgram(v - 1),
      format: (v) => String(v).padStart(2, '0'),
    });
    head.replaceChildren(program.el, name,
      h('button', { class: 'soft', onClick: () => store.addProgram() }, 'NEW PROGRAM'),
      h('button', { class: 'soft danger', onClick: () => {
        if (confirm(`Delete ${store.program.name}? The samples stay in memory.`)) {
          store.removeProgram();
        }
      } }, 'DELETE PROGRAM'));
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
        h('span', { class: 'info' }, 'Select LOW, HIGH or ROOT and play a note to set it, like on the sampler '
          + '(LOW moves on to HIGH). PITCH FIXED plays every key at the root\'s pitch, the X7000\'s CONSTANT '
          + 'PITCH. The sound is the sample\'s, see OUT and LFO. A new keygroup gets the selected sample, a bar above '
          + 'the keys selects its keygroup. Notes are named as on the sampler, C3 = MIDI 60.'))),
    dispose: () => off.forEach((f) => f()),
  };
}
