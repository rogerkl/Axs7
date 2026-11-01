// SAMPLES: the sample memory, and the selected sample's name and loop.

import type { App, View } from '../../app/app';
import { newKeygroup } from '../../model/mapping';
import type { LoopMode, Sample } from '../../model/types';
import { h, pickFiles } from '../dom';
import { ParamCell, choiceCell } from '../param';
import { slotCell } from '../slot';
import { Waveform } from '../waveform';

const LOOP_MODES = ['off', 'forward', 'alternating'] as const satisfies readonly LoopMode[];
const LOOP_NAMES = ['OFF', 'FWD', 'ALT'];

function duration(s: Sample): string {
  return `${(s.data.length / s.rate).toFixed(2)}S`;
}

export function samplesView(app: App): View {
  const { store, actions } = app;
  const list = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Samples in memory' });
  const detail = h('div', { class: 'detail' });
  const wave = new Waveform();
  let cells: ParamCell[] = [];
  /** listeners of the detail that is shown, removed when it is rebuilt */
  let detailOff: (() => void)[] = [];

  /** The sampler slot with what to do with it: receive from it, and send the selected sample to it */
  function samplerGroup(withSend: boolean): HTMLElement {
    const slot = slotCell(app, 'samples.slot', 'compact');
    const send = withSend ? h('button', { class: 'soft', onClick: () => actions.send() }) : null;
    const receive = h('button', { class: 'soft', onClick: () => actions.receive() });
    const texts = () => {
      const n = app.settings.slot + 1;
      if (send) {
        send.textContent = `SEND TO SLOT ${n}`;
        send.title = `Send this sample to slot ${n} on the sampler, it replaces what is there`;
      }
      receive.textContent = `RECEIVE FROM SLOT ${n}`;
      receive.title = `Receive the sample in slot ${n} on the sampler into memory`;
    };
    texts();
    detailOff.push(slot.dispose, app.onSlot(texts));
    return h('div', { class: 'sampler-group', role: 'group', 'aria-label': 'Sampler' },
      h('span', { class: 'group-title' }, 'SAMPLER'), slot.cell.el, send, receive);
  }

  wave.onLoop = (loopStart, loopEnd) => {
    const s = store.selectedSample;
    if (s) {
      store.updateSample(s.id, { loopStart, loopEnd });
    }
  };

  function row(s: Sample, index: number): HTMLElement {
    return h('button', {
      class: `list-row${s.id === store.selectedSampleId ? ' selected' : ''}`, role: 'option',
      'aria-selected': s.id === store.selectedSampleId, onClick: () => store.selectSample(s.id),
    },
    h('span', { class: 'c-num' }, String(index + 1).padStart(2, '0')),
    h('span', { class: 'c-name' }, s.name),
    h('span', { class: 'c-small' }, `${(s.rate / 1000).toFixed(1)}K`),
    h('span', { class: 'c-small' }, duration(s)),
    h('span', { class: 'c-small' }, LOOP_NAMES[LOOP_MODES.indexOf(s.loopMode)]));
  }

  function buildList(): void {
    const samples = [...store.samples.values()];
    list.replaceChildren(
      h('div', { class: 'list-head' }, h('span', { class: 'c-num' }, '#'), h('span', { class: 'c-name' }, 'NAME'),
        h('span', { class: 'c-small' }, 'RATE'), h('span', { class: 'c-small' }, 'LENGTH'),
        h('span', { class: 'c-small' }, 'LOOP')),
      ...samples.map(row),
      ...(samples.length ? [] : [h('div', { class: 'list-empty' }, 'MEMORY EMPTY')]));
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function buildDetail(): void {
    detailOff.forEach((f) => f());
    detailOff = [];
    const s = store.selectedSample;
    wave.setSample(s);
    if (!s) {
      cells = [];
      detail.replaceChildren(wave.el, h('div', { class: 'empty-help' },
        h('p', {}, 'Load WAV files (several at once, the loop in a WAV file is kept), or receive a sample from the '
          + 'sampler. Memory is only limited by the browser.'),
        h('div', { class: 'row' },
          h('button', { class: 'soft', onClick: async () => actions.loadFiles(await pickFiles('.wav,audio/*', true)) },
            'LOAD WAV')),
        samplerGroup(false)));
      return;
    }
    const id = s.id;
    const sample = () => store.samples.get(id) ?? s;
    const name = h('input', { class: 'name-input', value: s.name, maxLength: 24, 'aria-label': 'Sample name',
      onChange: () => store.updateSample(id, { name: name.value.trim() || s.name }) });
    cells = [
      choiceCell('sample.loop', 'LOOP', LOOP_MODES, LOOP_NAMES, () => sample().loopMode,
        (loopMode) => store.updateSample(id, { loopMode })),
      new ParamCell({
        key: 'sample.start', label: 'START', min: 0, max: s.data.length, coarse: Math.max(1, Math.round(s.rate / 100)),
        get: () => sample().loopStart,
        set: (v) => store.updateSample(id, { loopStart: Math.min(v, Math.max(0, sample().loopEnd - 2)) }),
        detail: (v) => `${(v / s.rate).toFixed(3)}S`,
      }, 'wide'),
      new ParamCell({
        key: 'sample.end', label: 'END', min: 0, max: s.data.length, coarse: Math.max(1, Math.round(s.rate / 100)),
        get: () => sample().loopEnd,
        set: (v) => store.updateSample(id, { loopEnd: Math.max(v, Math.min(s.data.length, sample().loopStart + 2)) }),
        detail: (v) => `${(v / s.rate).toFixed(3)}S`,
      }, 'wide'),
    ];
    const audition = h('button', { class: 'soft', title: 'Hold to play the sample at its own pitch' }, 'PLAY');
    audition.addEventListener('pointerdown', () => actions.auditionStart(sample()));
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      audition.addEventListener(type, () => actions.auditionStop());
    }
    detail.replaceChildren(
      h('div', { class: 'row' }, name,
        h('span', { class: 'info' }, `${s.rate.toFixed(s.rate % 1 ? 2 : 0)} HZ · ${s.data.length} SAMPLES · `
          + duration(s))),
      wave.el,
      h('div', { class: 'params' }, ...cells.map((c) => c.el)),
      h('div', { class: 'row' },
        audition,
        h('button', { class: 'soft', title: 'Add a keygroup for this sample to the program',
          onClick: () => {
            store.addKeygroup(newKeygroup(id));
            app.lcd.flash(`ADDED TO ${store.program.name}`);
          } }, 'ADD TO PROGRAM'),
        h('button', { class: 'soft', onClick: () => actions.saveWav(sample()) }, 'SAVE WAV'),
        h('button', { class: 'soft danger', onClick: () => {
          if (confirm(`Delete ${sample().name}?`)) {
            store.removeSample(id);
          }
        } }, 'DELETE')),
      samplerGroup(true));
  }

  function refresh(id?: string): void {
    for (const c of cells) {
      c.refresh();
    }
    wave.draw();
    const s = id && store.samples.get(id);
    const rows = [...list.querySelectorAll('.list-row')];
    const index = [...store.samples.keys()].indexOf(id ?? '');
    if (s && rows[index]) {
      rows[index].replaceWith(row(s, index));
    }
  }

  buildList();
  buildDetail();
  const off = [
    store.on('samples', () => {
      buildList();
      buildDetail();
    }),
    store.on('selection', () => {
      buildList();
      if (wave.el.isConnected && (detail.dataset.sample ?? '') === (store.selectedSampleId ?? '')) {
        return;
      }
      detail.dataset.sample = store.selectedSampleId ?? '';
      buildDetail();
    }),
    store.on('sample', refresh),
  ];
  detail.dataset.sample = store.selectedSampleId ?? '';
  return {
    el: h('div', { class: 'view view-samples' }, list, detail),
    dispose: () => [...off, ...detailOff].forEach((f) => f()),
  };
}
