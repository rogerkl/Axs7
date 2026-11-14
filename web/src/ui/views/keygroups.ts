// PROGRAM: the current bank and program, P1-P32 as on the X7000, the program's name and its keygroups, each a sample
// over a key range with its pitch, like an X7000 program ("P1:S1:L=36:H=96"). The sound is the sample's (OUT and
// LFO). A keygroup can be muted or soloed to hear it alone, and moved to another program.
//
// In SM-87's DRUMS bank (model/sm87.ts) P1-P16 are drums: one keygroup each, tuned in semitones (no FINE), with a
// pan, and the tuning SM-87 gives the drum shown.

import type { App, View } from '../../app/app';
import { newKeygroup } from '../../model/mapping';
import { SM87_DRUMS, SM87_PAN_MAX, SM87_TUNE_KEY, SM87_TUNE_MAX, drumName, drumTune, isDrum } from '../../model/sm87';
import { noteName, parseNote } from '../../model/notes';
import type { Keygroup } from '../../model/types';
import { h } from '../dom';
import { sm87Meter } from './sm87';
import { ParamCell, choiceCell, dataEntry } from '../param';

const pad = (n: number) => String(n).padStart(2, '0');

/** Key range and root: like on the sampler, a note played once one is selected sets it */
const noteSpec = { min: 0, max: 127, coarse: 12, format: noteName, parse: parseNote, noteInput: true,
  detail: () => (dataEntry.listening ? 'OR PLAY KEY' : '') };

export function programView(app: App): View {
  const { store, lcd } = app;
  const head = h('div', { class: 'row program-row' });
  const table = h('div', { class: 'kg-table', role: 'table', 'aria-label': 'Keygroups' });
  let cells: ParamCell[] = [];
  /** in one of SM-87's banks: how much of its firmware's room they take */
  const meter = sm87Meter(app);
  /** in SM-87's DRUMS bank: how a drum is made of its program */
  const drumsInfo = h('span', { class: 'info' }, `SM-87 DRUMS: P1-P${SM87_DRUMS} are the HR-16's drums, P17-P32 `
    + 'aren\'t used. A drum plays its keygroup\'s sample once, START to END (no loop, filter or release), at the '
    + `drum's LEVEL (until set, the sample's LEVEL in OUT) and the sample's VEL>LEVEL, panned with PAN. It is tuned `
    + `as ${noteName(SM87_TUNE_KEY)} plays it here, in semitones: ROOT and SEMI (PITCH FIXED: SEMI only). A drum `
    + 'has one keygroup. SAVE PACKAGE or INSTALL ON FM-1 (BANK view) put them into SM-87; OPEN IN EMULATOR tries '
    + 'them.');
  let headCells: ParamCell[] = [];
  /** the tuning SM-87 gives each drum's keygroup, shown in its row */
  let tunes: (() => void)[] = [];
  const drums = () => store.bank.sm87 === 'drums';
  const signed = (v: number) => (v > 0 ? `+${v}` : String(v));

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
    const drum = drumName(store.bank, store.programIndex);
    const pan = drum ? new ParamCell({
      key: 'program.pan', label: 'PAN', min: -SM87_PAN_MAX, max: SM87_PAN_MAX, coarse: 1,
      get: () => store.bank.programs[store.programIndex].pan ?? 0, set: (v) => store.updateProgram({ pan: v }),
      format: (v) => (v < 0 ? `<${-v}` : v > 0 ? `${v}>` : '<>'), detail: () => `${drum} ON SM-87`,
    }) : null;
    /** the sample a drum plays: its first keygroup's */
    const drumSample = () => {
      const k = store.program.keygroups[0];
      return k ? store.samples.get(k.sampleId) ?? null : null;
    };
    // a drum's own level, on the curve of the sample's LEVEL, which it replaces; until set, the sample's
    const level = drum ? new ParamCell({
      key: 'program.level', label: 'LEVEL', min: 0, max: 99, coarse: 10,
      get: () => store.bank.programs[store.programIndex].level ?? Math.round(drumSample()?.sound.level ?? 85),
      set: (v) => store.updateProgram({ level: v }),
      detail: () => (store.bank.programs[store.programIndex].level === undefined
        ? `${drumSample() ? 'THE SAMPLE\'S' : 'NO SAMPLE'}` : `${drum} ON SM-87`),
    }) : null;
    headCells = [pan, level].filter((c): c is ParamCell => c !== null);
    drumsInfo.hidden = !drums();
    meter.el.hidden = !store.bank.sm87;
    head.replaceChildren(bank.el, program.el, name, ...headCells.map((c) => c.el),
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

  /** The other programs of the bank to move a keygroup to: a keygroup plays in its sample's bank */
  function moveSelect(kg: Keygroup, i: number): HTMLSelectElement {
    const select = h('select', { class: 'move-select', 'aria-label': `Move keygroup ${i + 1} to`,
      title: 'Move the keygroup to another program of the bank. To another bank, the sample goes, with all its '
        + 'keygroups (BANK in the SAMPLE view)',
      onChange: () => {
        const program = Number(select.value);
        if (store.moveKeygroup(kg.id, program)) {
          lcd.flash(`MOVED TO P${pad(program + 1)}`);
        }
      } },
    h('option', { value: '', disabled: true, selected: true }, 'MOVE TO…'),
    // a drum has one keygroup
    ...store.bank.programs.map((p, j) => h('option', { value: j, disabled: j === store.programIndex
      || (drums() && (j >= SM87_DRUMS || store.programs[j].keygroups.length > 0)) }, `P${pad(j + 1)} ${p.name}`)));
    return select;
  }

  function buildTable(): void {
    cells = [];
    tunes = [];
    // a keygroup plays one of the bank's samples
    const samples = store.samplesIn(store.bank);
    const rows = store.program.keygroups.map((kg, i) => {
      const select = h('select', { class: 'sample-select', 'aria-label': `Keygroup ${i + 1} sample`,
        title: 'The sample, of the bank\'s: the keygroup goes to it',
        onChange: () => store.updateKeygroup(kg.id, { sampleId: select.value }) },
      ...samples.map((s) => h('option', { value: s.id, selected: s.id === kg.sampleId },
        `S${pad(s.slot! + 1)} ${s.name}`)));
      // the X7000's CONSTANT PITCH: every key plays the root's pitch
      const pitch = choiceCell(`kg.${kg.id}.pitch`, 'PITCH', ['track', 'fixed'] as const, ['TRACK', 'FIXED'],
        () => (store.program.keygroups.find((k) => k.id === kg.id)?.fixedPitch ? 'fixed' : 'track'),
        (v) => store.updateKeygroup(kg.id, { fixedPitch: v === 'fixed' }), 'compact');
      pitch.el.addEventListener('pointerdown', () => store.selectKeygroup(kg.id));
      // a drum is tuned in semitones: no FINE
      const rowCells = [kgCell(kg, 'low', 'LOW'), kgCell(kg, 'high', 'HIGH'), kgCell(kg, 'root', 'ROOT'),
        kgCell(kg, 'semitones', 'SEMI'), ...(drums() ? [] : [kgCell(kg, 'cents', 'FINE')]), pitch];
      cells.push(...rowCells);
      const tune = h('span', { class: 'kg-sm87', title: 'The tuning SM-87 gives the drum: as '
        + `${noteName(SM87_TUNE_KEY)} plays it here, in semitones (at most ${SM87_TUNE_MAX} either way)` });
      if (isDrum(store.bank, store.programIndex)) {
        const show = () => {
          const k = store.program.keygroups.find((x) => x.id === kg.id);
          const t = k ? drumTune(k) : 0;
          const kept = Math.max(-SM87_TUNE_MAX, Math.min(SM87_TUNE_MAX, t));
          tune.textContent = i > 0 ? 'NOT PLAYED' : `SM-87 ${signed(kept)}` + (kept !== t ? ` (${signed(t)})` : '');
          tune.classList.toggle('warn', i > 0 || Math.abs(t) > SM87_TUNE_MAX);
        };
        show();
        tunes.push(show);
      }
      return h('div', {
        class: `kg-row${kg.id === store.selectedKeygroupId ? ' selected' : ''}`, role: 'row',
        onPointerdown: () => store.selectKeygroup(kg.id),
      },
      h('span', { class: 'kg-num' }, `KG${String(i + 1).padStart(2, '0')}`),
      select, ...rowCells.map((c) => c.el), ...(isDrum(store.bank, store.programIndex) ? [tune] : []),
      listenButton(kg, 'M', store.muted.has(kg.id), 'Mute: not played', () => store.toggleMute(kg.id)),
      listenButton(kg, 'S', store.soloed.has(kg.id), 'Solo: only the soloed keygroups are played',
        () => store.toggleSolo(kg.id)),
      moveSelect(kg, i),
      h('button', { class: 'soft small danger', title: 'Remove keygroup', 'aria-label': `Remove keygroup ${i + 1}`,
        onClick: () => store.removeKeygroup(kg.id) }, '✕'));
    });
    table.replaceChildren(...rows, ...(rows.length ? [] : [h('div', { class: 'list-empty' },
      samples.length ? 'NO KEYGROUPS. ADD ONE FOR THE SELECTED SAMPLE.'
        : `NO SAMPLES IN ${store.bank.name}: GIVE A SAMPLE A SLOT IN IT (SAMPLE OR BANK VIEW)`)]));
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
    store.on('program', () => {
      cells.forEach((c) => c.refresh());
      headCells.forEach((c) => c.refresh());
      tunes.forEach((f) => f());
    }),
    store.on('selection', markSelected),
  ];
  return {
    el: h('div', { class: 'view view-keygroups' }, head, meter.el, table,
      h('div', { class: 'row' },
        h('button', { class: 'soft', onClick: () => {
          if (drums() && !isDrum(store.bank, store.programIndex)) {
            lcd.flash(`P17-P32 AREN'T DRUMS`);
            return;
          }
          if (drums() && store.program.keygroups.length) {
            lcd.flash('A DRUM HAS ONE KEYGROUP');
            return;
          }
          // the selected sample if it is in the bank, else the bank's first
          const s = store.selectedSample?.bankId === store.bank.id ? store.selectedSample : store.samplesIn(store.bank)[0];
          if (!s) {
            lcd.flash(`NO SAMPLES IN ${store.bank.name}`);
            return;
          }
          store.addKeygroup(newKeygroup(s.id, store.programIndex));
        } }, 'ADD KEYGROUP'),
        drumsInfo,
        h('span', { class: 'info' }, 'A bank has 32 programs, as the sampler. As on the sampler, the key ranges are '
          + 'the samples\': a program plays the samples in the bank\'s slots, and a sample\'s keygroups go with it '
          + 'to another bank. Select LOW, HIGH or ROOT and play a note to set it, like on the sampler '
          + '(LOW moves on to HIGH). It takes one note, select it again for another. PITCH FIXED plays every key at the root\'s pitch, the sampler\'s CONSTANT '
          + 'PITCH. The sound is the sample\'s, see OUT and LFO. A new keygroup gets the selected sample, a bar above '
          + 'the keys selects its keygroup: drag an end of it to move LOW or HIGH, or the middle to move the keygroup '
          + 'with its ROOT. M mutes a keygroup and S solos it, to hear one of overlapping keygroups alone (only here, '
          + 'they aren\'t saved or sent). MOVE TO moves a keygroup to another program. Notes are named as on the '
          + 'sampler, C3 = MIDI 60.'))),
    dispose: () => {
      off.forEach((f) => f());
      meter.dispose();
    },
  };
}
