// SAMPLES: the sample memory, and the selected sample's name, loop, rate and transfers.

import type { App, View } from '../../app/app';
import { newKeygroup } from '../../model/mapping';
import { BANDWIDTHS, MAX_SAMPLES, nearestBandwidth, samplerBandwidth } from '../../protocol/akai';
import { maxCrossfade } from '../../audio/dsp';
import { samplerFit } from '../../model/convert';
import { isLooped } from '../../model/types';
import type { LoopMode, Sample } from '../../model/types';
import { h, pickFiles } from '../dom';
import { ParamCell, choiceCell, dataEntry } from '../param';
import { isPortion, movePoint } from '../../model/points';
import type { PointName } from '../../model/points';
import { slotCell } from '../slot';
import { Waveform } from '../waveform';

/** The X7000's scan modes: one shot, looping, alternating, drum trigger */
const LOOP_MODES = ['off', 'forward', 'alternating', 'drum'] as const satisfies readonly LoopMode[];
const LOOP_NAMES = ['ONE', 'LOOP', 'ALT', 'DRUM'];

/** How long the part between START and END is */
function duration(s: Sample): string {
  return `${((s.end - s.start) / s.rate).toFixed(2)}S`;
}

const khz = (rate: number) => `${(rate / 1000).toFixed(1)}K`;

/** What the sampler keeps of a sample, for a badge: null if it fits whole */
function fitText(s: Sample): { text: string; warn: boolean } | null {
  const fit = samplerFit(s);
  const seconds = `${fit.maxSeconds.toFixed(2)}S`;
  if (fit.fits) {
    return fit.limit < s.data.length ? { text: 'FITS: THE SAMPLER ENDS IT AT THE LOOP END', warn: false } : null;
  }
  return !isLooped(s.loopMode) ? { text: `TOO LONG: THE SAMPLER KEEPS ${seconds}, IT IS CUT THERE`, warn: true }
    : { text: `LOOP END PAST THE SAMPLER'S ${seconds}: MOVE IT, OR RESAMPLE LOWER`, warn: true };
}

export function samplesView(app: App): View {
  const { store, actions } = app;
  const list = h('div', { class: 'list', role: 'listbox', 'aria-label': 'Samples in memory' });
  const loadRate = choiceCell('samples.loadRate', 'RATE ON LOAD', ['keep', 'sampler'] as const, ['KEEP', 'SAMPLER'],
    () => app.settings.loadRate, (v) => {
      app.settings.loadRate = v;
      app.saveSettings();
    }, 'wide');
  loadRate.el.title = 'KEEP loads files at their own rate, SAMPLER resamples them to the nearest of the sampler\'s '
    + 'rates';
  const loadRow = h('div', { class: 'row load-row' },
    h('button', { class: 'soft', onClick: async () => actions.loadFiles(await pickFiles('.wav,audio/*', true)) },
      'LOAD WAV'), loadRate.el);
  const detail = h('div', { class: 'detail' });
  const wave = new Waveform();
  let cells: ParamCell[] = [];
  /** listeners of the detail that is shown, removed when it is rebuilt */
  let detailOff: (() => void)[] = [];
  /** run when the shown sample's values change */
  let detailRefresh: (() => void)[] = [];
  /** the shown sample's point cells, to select the one whose marker is grabbed on the waveform */
  let pointCells: Partial<Record<PointName, ParamCell>> = {};

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

  /**
   * Resampling to one of the sampler's rates, like on the sampler: to make a sample's rate the sampler's, or to
   * save space on the sampler with a lower rate. The sample is replaced, keygroups keep playing it at its pitch.
   */
  function resampleGroup(s: Sample): HTMLElement {
    const last = BANDWIDTHS.length - 1;
    let to = BANDWIDTHS.indexOf(nearestBandwidth(s.rate)); // BANDWIDTHS go from the highest rate down
    const result = h('span', { class: 'info' });
    const button = h('button', { class: 'soft', onClick: () => actions.resample(store.samples.get(s.id) ?? s,
      BANDWIDTHS[to].rate) }, 'RESAMPLE');
    const describe = () => {
      const bw = BANDWIDTHS[to];
      const n = Math.round((s.data.length * bw.rate) / s.rate);
      const same = Math.abs(bw.rate - s.rate) < 0.01;
      const fit = samplerFit(store.samples.get(s.id) ?? s, bw.rate);
      button.disabled = same;
      result.textContent = same ? 'THE SAMPLE IS AT THIS RATE' : `${n} SAMPLES, `
        + (!fit.fits ? `THE SAMPLER KEEPS ${fit.maxSeconds.toFixed(2)}S`
          : fit.limit < s.data.length ? 'FITS TO THE LOOP END' : 'FITS ON THE SAMPLER');
      result.classList.toggle('warn', !same && !fit.fits);
    };
    detailRefresh.push(describe);
    const cell = new ParamCell({
      key: 'samples.resampleTo', label: 'TO', min: 0, max: last, coarse: 12, // the rates are a semitone apart
      get: () => last - to,
      set: (v) => {
        to = last - v;
        describe();
      },
      format: (v) => khz(BANDWIDTHS[last - v].rate),
      detail: (v) => `MAX ${(MAX_SAMPLES / BANDWIDTHS[last - v].rate).toFixed(2)}S`,
      parse: (text) => {
        const hz = Number(text.replace(/k$/i, '')) * (/k$/i.test(text) || Number(text) < 100 ? 1000 : 1);
        return hz > 0 ? last - BANDWIDTHS.indexOf(nearestBandwidth(hz)) : null;
      },
    }, 'wide');
    cell.el.title = 'One of the sampler\'s rates, a semitone apart. Lower rates hold longer samples.';
    describe();
    return h('div', { class: 'sampler-group', role: 'group', 'aria-label': 'Resample' },
      h('span', { class: 'group-title' }, 'RESAMPLE'), cell.el, button, result);
  }

  /**
   * Crossfade loop: the end of a forward loop fades into what comes before the loop start, so the jump back to the
   * start doesn't click. Shown on the waveform while the sample is shown.
   */
  function crossfadeGroup(s: Sample): HTMLElement {
    const { settings } = app;
    const sample = () => store.samples.get(s.id) ?? s;
    const room = () => maxCrossfade(sample().data.length, sample().loopStart, sample().loopEnd);
    const ms = (samples: number) => Math.round((samples / s.rate) * 1000);
    const length = () => Math.min(room(), Math.max(1, Math.round((settings.xfadeMs / 1000) * s.rate)));
    const note = h('span', { class: 'info' });
    const apply = h('button', { class: 'soft', onClick: () => actions.crossfade(sample(), length(), settings.xfadeShape) },
      'APPLY');
    const lengthCell = new ParamCell({
      key: 'samples.xfadeLength', label: 'LENGTH', min: 1, coarse: 10,
      get max() {
        return Math.max(1, ms(room()));
      },
      get: () => Math.min(settings.xfadeMs, Math.max(1, ms(room()))),
      set: (v) => {
        settings.xfadeMs = v;
        app.saveSettings();
        update();
      },
      format: (v) => `${v}MS`,
      parse: (text) => Number(text.replace(/ms$/i, '')) || null,
      detail: () => `${length()} SAMPLES`,
    }, 'wide');
    const shapeCell = choiceCell('samples.xfadeShape', 'SHAPE', ['linear', 'equal'] as const, ['LIN', 'EQP'],
      () => settings.xfadeShape, (v) => {
        settings.xfadeShape = v;
        app.saveSettings();
      });
    shapeCell.el.title = 'LIN for a steady sound, alike on both sides of the seam. EQP (equal power) keeps the level '
      + 'when the two sides differ, like noise.';
    const update = () => {
      const s2 = sample();
      const ok = s2.loopMode === 'forward' && room() > 0;
      apply.disabled = !ok;
      note.textContent = s2.loopMode !== 'forward' ? 'NEEDS A FORWARD LOOP'
        : room() === 0 ? 'MOVE THE LOOP START LATER, THE FADE USES WHAT COMES BEFORE IT'
          : `THE LAST ${ms(length())}MS OF THE LOOP FADE INTO THE ${ms(length())}MS BEFORE ITS START`;
      wave.setCrossfade(ok ? length() : 0);
    };
    update();
    detailRefresh.push(() => {
      lengthCell.refresh(); // the room changes with the loop
      shapeCell.refresh();
      update();
    });
    return h('div', { class: 'sampler-group', role: 'group', 'aria-label': 'Crossfade loop' },
      h('span', { class: 'group-title' }, 'CROSSFADE'), lengthCell.el, shapeCell.el, apply, note);
  }

  wave.onPoint = (which, value) => {
    const s = store.selectedSample;
    if (s) {
      store.updateSample(s.id, movePoint(s, which, value));
    }
  };
  // a grabbed marker's parameter is selected, so the knob and the arrow keys fine tune it a sample at a time
  wave.onGrab = (which) => {
    const cell = pointCells[which];
    if (cell) {
      dataEntry.select(cell);
    }
  };

  function row(s: Sample, index: number): HTMLElement {
    return h('button', {
      class: `list-row${s.id === store.selectedSampleId ? ' selected' : ''}`, role: 'option',
      'aria-selected': s.id === store.selectedSampleId, onClick: () => store.selectSample(s.id),
    },
    h('span', { class: 'c-num' }, String(index + 1).padStart(2, '0')),
    h('span', { class: 'c-name' }, s.name),
    samplerBandwidth(s.rate)
      ? h('span', { class: 'c-small' }, khz(s.rate))
      : h('span', { class: 'c-small off-rate', title: 'Not one of the sampler\'s rates' }, `${khz(s.rate)}!`),
    samplerFit(s).fits ? h('span', { class: 'c-small' }, duration(s))
      : h('span', { class: 'c-small off-rate', title: 'Too long for the sampler' }, `${duration(s)}!`),
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
    detailRefresh = [];
    wave.setCrossfade(0);
    wave.setLimit(null);
    wave.setHeads([]);
    const s = store.selectedSample;
    wave.setSample(s);
    if (!s) {
      cells = [];
      detail.replaceChildren(wave.el, h('div', { class: 'empty-help' },
        h('p', {}, 'Load WAV files (several at once, the loop in a WAV file is kept), or receive a sample from the '
          + 'sampler. Memory is only limited by the browser.'),
        samplerGroup(false)));
      return;
    }
    const id = s.id;
    const sample = () => store.samples.get(id) ?? s;
    const name = h('input', { class: 'name-input', value: s.name, maxLength: 24, 'aria-label': 'Sample name',
      onChange: () => store.updateSample(id, { name: name.value.trim() || s.name }) });
    const pointCell = (which: PointName, label: string) => {
      const cell = new ParamCell({
        key: `sample.${which}`, label, min: 0, max: s.data.length, coarse: Math.max(1, Math.round(s.rate / 100)),
        get: () => sample()[which],
        set: (v) => {
          store.updateSample(id, movePoint(sample(), which, v));
          wave.reveal(sample()[which]); // keep it in view when zoomed in
        },
        detail: (v) => `${(v / s.rate).toFixed(3)}S`,
      }, 'wide');
      pointCells[which] = cell;
      return cell;
    };
    pointCells = {};
    cells = [
      pointCell('start', 'START'),
      pointCell('end', 'END'),
      choiceCell('sample.loop', 'SCAN', LOOP_MODES, LOOP_NAMES, () => sample().loopMode,
        (loopMode) => store.updateSample(id, { loopMode })),
      pointCell('loopStart', 'LOOP START'),
      pointCell('loopEnd', 'LOOP END'),
    ];
    const crossfade = crossfadeGroup(s);
    const lastEdit = actions.lastEdit?.id === s.id ? actions.lastEdit : null;
    const audition = h('button', { class: 'soft', title: 'Hold to play the sample at its own pitch' }, 'PLAY');
    audition.addEventListener('pointerdown', () => actions.auditionStart(sample()));
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      audition.addEventListener(type, () => actions.auditionStop());
    }
    const bw = samplerBandwidth(s.rate);
    const fitBadge = h('span', { class: 'badge' });
    const length = h('span', { class: 'info' });
    const trim = h('button', { class: 'soft', onClick: () => actions.trim(sample()),
      title: 'Keep only the part between START and END, to save memory (UNDO brings the rest back)' }, 'TRIM');
    const showFit = () => {
      const now = sample();
      const fit = fitText(now);
      fitBadge.hidden = !fit;
      fitBadge.textContent = fit?.text ?? '';
      fitBadge.classList.toggle('warn', !!fit?.warn);
      // the sampler's limit counts from START
      const limitAt = now.start + samplerFit(now).limit;
      wave.setLimit(limitAt < now.end ? limitAt : null);
      length.textContent = `${s.rate.toFixed(s.rate % 1 ? 2 : 0)} HZ · `
        + (isPortion(now) ? `USING ${duration(now)} OF ${(now.data.length / now.rate).toFixed(2)}S`
          : `${now.data.length} SAMPLES · ${duration(now)}`);
      trim.disabled = !isPortion(now);
    };
    showFit();
    detailRefresh.push(showFit);
    detail.replaceChildren(
      h('div', { class: 'row' }, name,
        length,
        bw ? h('span', { class: 'badge' }, `SAMPLER RATE, ${bw.name.toUpperCase()} BANDWIDTH`)
          : h('span', { class: 'badge warn' }, 'NOT A SAMPLER RATE: RESAMPLE, OR IT IS WHEN SENT'),
        fitBadge),
      wave.el,
      h('div', { class: 'params' }, ...cells.map((c) => c.el)),
      h('div', { class: 'row' },
        audition,
        h('button', { class: 'soft', title: 'Add a keygroup for this sample to the program',
          onClick: () => {
            store.addKeygroup(newKeygroup(id));
            app.lcd.flash(`ADDED TO ${store.program.name}`);
          } }, 'ADD TO PROGRAM'),
        trim,
        lastEdit ? h('button', { class: 'soft', onClick: () => actions.undoEdit() }, `UNDO ${lastEdit.what}`) : null,
        h('button', { class: 'soft', onClick: () => actions.saveWav(sample()) }, 'SAVE WAV'),
        h('button', { class: 'soft danger', onClick: () => {
          if (confirm(`Delete ${sample().name}?`)) {
            store.removeSample(id);
          }
        } }, 'DELETE')),
      crossfade,
      resampleGroup(s),
      samplerGroup(true));
  }

  function refresh(id?: string): void {
    for (const c of cells) {
      c.refresh();
    }
    for (const f of detailRefresh) {
      f();
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
    app.engine.onPositions((bySample) => wave.setHeads(bySample.get(store.selectedSampleId ?? '') ?? [])),
  ];
  detail.dataset.sample = store.selectedSampleId ?? '';
  return {
    el: h('div', { class: 'view view-samples' }, h('div', { class: 'detail' }, loadRow, list), detail),
    dispose: () => [...off, ...detailOff].forEach((f) => f()),
  };
}
