// SAMPLES: the sample memory, and the selected sample's name, points, edits and transfers. The edits are settings,
// the sample is rendered from its original with them whenever they change.

import type { App, View } from '../../app/app';
import { newKeygroup } from '../../model/mapping';
import { BANDWIDTHS, MAX_SAMPLES, nearestBandwidth, samplerBandwidth } from '../../protocol/akai';
import { crossfadeRoom } from '../../audio/dsp';
import { samplerFit } from '../../model/convert';
import { attackRoom, isTwelveBit, portionPeak } from '../../model/edit';
import { isEdited } from '../../model/recipe';
import { isLooped } from '../../model/types';
import type { LoopMode, Sample } from '../../model/types';
import { h, pickFiles } from '../dom';
import { ParamCell, choiceCell, dataEntry } from '../param';
import { isPortion, movePoint, usedStart } from '../../model/points';
import type { PointName } from '../../model/points';
import { slotCell } from '../slot';
import { Waveform } from '../waveform';

/** The X7000's scan modes: one shot, looping, alternating, drum trigger */
const LOOP_MODES = ['off', 'forward', 'alternating', 'drum'] as const satisfies readonly LoopMode[];
const LOOP_NAMES = ['ONE', 'LOOP', 'ALT', 'DRUM'];

/** How long the part that plays is: START to END, from a loop start before START */
function duration(s: Sample): string {
  return `${((s.end - usedStart(s)) / s.rate).toFixed(2)}S`;
}

const khz = (rate: number) => `${(rate / 1000).toFixed(1)}K`;
/** Samples as ms at the sample's rate */
const msOf = (s: Sample, samples: number) => Math.round((samples / s.rate) * 1000);
/** How many samples a fade of ms is, as rendering makes it: no longer than its room */
const fadeSamples = (s: Sample, ms: number, room: number) => Math.min(room, Math.round((ms / 1000) * s.rate));

/** What the sampler keeps of a sample, for a badge: null if it fits whole */
function fitText(s: Sample): { text: string; warn: boolean } | null {
  const fit = samplerFit(s);
  const seconds = `${fit.maxSeconds.toFixed(2)}S`;
  // playing backwards, the sampler ends a loop at the loop start
  const loopPoint = s.reverse ? 'LOOP START' : 'LOOP END';
  if (fit.fits) {
    return fit.limit < s.end - s.start ? { text: `FITS: THE SAMPLER ENDS IT AT THE ${loopPoint}`, warn: false } : null;
  }
  return !isLooped(s.loopMode) ? { text: `TOO LONG: THE SAMPLER KEEPS ${seconds}, IT IS CUT THERE`, warn: true }
    : { text: `${loopPoint} PAST THE SAMPLER'S ${seconds}: MOVE IT, OR RESAMPLE LOWER`, warn: true };
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
    h('button', { class: 'soft', title: 'WAV or other audio files, or S700/X7000 QuickDisk images (.qd)',
      onClick: async () => actions.loadFiles(await pickFiles('.wav,.qd,audio/*', true)) }, 'LOAD WAV / QD'),
    loadRate.el);
  const detail = h('div', { class: 'detail' });
  /** under the list: what goes to the sampler, for the selected sample */
  const side = h('div', { class: 'side-groups' });
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
      receive.title = `Receive the sample in slot ${n} on the sampler into memory. The sampler sends from its `
        + 'START point, set START to 0 on it to get all of the sample';
    };
    texts();
    detailOff.push(slot.dispose, app.onSlot(texts));
    return h('div', { class: 'sampler-group', role: 'group', 'aria-label': 'Sampler' },
      h('span', { class: 'group-title' }, 'SAMPLER'), slot.cell.el, send, receive);
  }

  /** A fade's length in ms, 0 is off, up to the room there is for it */
  function fadeLengthCell(key: string, sample: () => Sample, room: () => number, get: () => number,
    set: (ms: number) => void): ParamCell {
    const maxMs = () => msOf(sample(), room());
    return new ParamCell({
      key, label: 'LENGTH', min: 0, coarse: 10,
      get max() {
        return maxMs();
      },
      get: () => Math.min(get(), maxMs()),
      set,
      format: (v) => (v === 0 ? 'OFF' : `${v}MS`),
      parse: (text) => {
        const ms = /^off$/i.test(text.trim()) ? 0 : Number(text.trim().replace(/ms$/i, ''));
        return Number.isFinite(ms) && ms >= 0 ? ms : null;
      },
      detail: (v) => (v === 0 ? '' : `${fadeSamples(sample(), v, room())} SMP`),
    }, 'wide');
  }

  /**
   * An attack rendered into the sample, the X7000 has no attack setting: what is played first fades in. It has to
   * end before the loop starts.
   */
  function attackGroup(s: Sample): HTMLElement {
    const sample = () => store.samples.get(s.id) ?? s;
    const room = () => attackRoom(sample());
    const note = h('span', { class: 'info' });
    const lengthCell = fadeLengthCell('samples.attackLength', sample, room, () => sample().recipe.attackMs,
      (attackMs) => store.updateRecipe(s.id, { attackMs }));
    const shapeCell = choiceCell('samples.attackShape', 'SHAPE', ['linear', 'curve'] as const, ['LIN', 'CURVE'],
      () => sample().recipe.attackShape, (attackShape) => store.updateRecipe(s.id, { attackShape }));
    shapeCell.el.title = 'LIN rises evenly, CURVE starts slower, like an exponential attack';
    const update = () => {
      const now = sample();
      const length = fadeSamples(now, now.recipe.attackMs, room());
      note.textContent = now.recipe.attackMs === 0 ? 'OFF: THE SAMPLE STARTS AS IT IS'
        : room() === 0 && !now.reverse && isLooped(now.loopMode) && now.loopStart <= now.start
          ? 'START IS IN THE LOOP: NO ROOM FOR AN ATTACK'
          : room() === 0 ? `MOVE THE LOOP ${now.reverse ? 'END EARLIER' : 'START LATER'}, THE ATTACK HAS TO END `
            + 'BEFORE THE LOOP'
          : `THE FIRST ${msOf(now, length)}MS PLAYED FADE IN FROM SILENCE${now.reverse ? ', BACK FROM END' : ''}`;
      wave.setAttack(length, now.recipe.attackShape === 'curve');
    };
    update();
    detailRefresh.push(() => {
      lengthCell.refresh(); // the room changes with the points
      shapeCell.refresh();
      update();
    });
    return h('div', { class: 'sampler-group', role: 'group', 'aria-label': 'Attack' },
      h('span', { class: 'group-title' }, 'ATTACK'), lengthCell.el, shapeCell.el, note);
  }

  /**
   * Crossfade loop: the end of a forward loop fades into what comes before the loop start, so the jump back to the
   * start doesn't click.
   */
  function crossfadeGroup(s: Sample): HTMLElement {
    const sample = () => store.samples.get(s.id) ?? s;
    const room = () => crossfadeRoom(sample());
    const note = h('span', { class: 'info' });
    const lengthCell = fadeLengthCell('samples.xfadeLength', sample, room, () => sample().recipe.crossfadeMs,
      (crossfadeMs) => store.updateRecipe(s.id, { crossfadeMs }));
    const shapeCell = choiceCell('samples.xfadeShape', 'SHAPE', ['linear', 'equal'] as const, ['LIN', 'EQP'],
      () => sample().recipe.crossfadeShape, (crossfadeShape) => store.updateRecipe(s.id, { crossfadeShape }));
    shapeCell.el.title = 'LIN for a steady sound, alike on both sides of the seam. EQP (equal power) keeps the level '
      + 'when the two sides differ, like noise.';
    const update = () => {
      const now = sample();
      const length = now.loopMode === 'forward' ? fadeSamples(now, now.recipe.crossfadeMs, room()) : 0;
      const ms = msOf(now, length);
      note.textContent = now.recipe.crossfadeMs === 0 ? 'OFF: THE LOOP AS IT IS'
        : now.loopMode !== 'forward' ? 'NEEDS A FORWARD LOOP'
          // reversed, the seam is at the loop start, and the fade takes what comes after the loop end
          : now.reverse ? (room() === 0 ? 'MOVE THE LOOP END EARLIER, THE FADE USES WHAT COMES AFTER IT'
            : `PLAYING BACKWARDS: THE FIRST ${ms}MS OF THE LOOP FADE INTO THE ${ms}MS AFTER ITS END`)
            : room() === 0 ? 'MOVE THE LOOP START LATER, THE FADE USES WHAT COMES BEFORE IT'
              : `THE LAST ${ms}MS OF THE LOOP FADE INTO THE ${ms}MS BEFORE ITS START`;
      wave.setCrossfade(length);
    };
    update();
    detailRefresh.push(() => {
      lengthCell.refresh(); // the room changes with the loop
      shapeCell.refresh();
      update();
    });
    return h('div', { class: 'sampler-group', role: 'group', 'aria-label': 'Crossfade loop' },
      h('span', { class: 'group-title' }, 'CROSSFADE'), lengthCell.el, shapeCell.el, note);
  }

  /**
   * Resampling to one of the sampler's rates, like on the sampler: to make a sample's rate the sampler's, or to
   * save space on the sampler with a lower rate. OWN keeps the original's rate. The points stay at the same times,
   * keygroups play the sample at its pitch.
   */
  function resampleGroup(s: Sample): HTMLElement {
    const sample = () => store.samples.get(s.id) ?? s;
    const last = BANDWIDTHS.length - 1;
    // 0 is the original's own rate, then the sampler's rates from the lowest up (BANDWIDTHS go from the highest)
    const rateAt = (v: number) => BANDWIDTHS[last - (v - 1)].rate;
    const valueOf = (rate: number | null) => (rate === null ? 0 : last - BANDWIDTHS.indexOf(nearestBandwidth(rate)) + 1);
    const result = h('span', { class: 'info' });
    const describe = () => {
      const now = sample();
      const own = Math.abs(now.rate - now.sourceRate) < 0.01;
      result.textContent = !own ? `FROM ${khz(now.sourceRate)}: ${now.data.length} SAMPLES`
        : samplerBandwidth(now.sourceRate) ? `THE ORIGINAL'S RATE, ${now.data.length} SAMPLES`
          : 'THE ORIGINAL\'S RATE ISN\'T THE SAMPLER\'S, IT IS RESAMPLED WHEN SENT';
    };
    const cell = new ParamCell({
      key: 'samples.resampleTo', label: 'TO', min: 0, max: last + 1, coarse: 12, // the rates are a semitone apart
      get: () => valueOf(sample().recipe.resampleTo),
      set: (v) => store.updateRecipe(s.id, { resampleTo: v === 0 ? null : rateAt(v) }),
      format: (v) => (v === 0 ? 'OWN' : khz(rateAt(v))),
      detail: (v) => (v === 0 ? khz(sample().sourceRate) : `MAX ${(MAX_SAMPLES / rateAt(v)).toFixed(2)}S`),
      parse: (text) => {
        if (/^(own|off)$/i.test(text.trim())) {
          return 0;
        }
        const hz = Number(text.replace(/k$/i, '')) * (/k$/i.test(text) || Number(text) < 100 ? 1000 : 1);
        return hz > 0 ? valueOf(hz) : null;
      },
    }, 'wide');
    cell.el.title = 'OWN keeps the original\'s rate, or one of the sampler\'s rates, a semitone apart. Lower rates hold '
      + 'longer samples.';
    describe();
    detailRefresh.push(() => {
      cell.refresh();
      describe();
    });
    return h('div', { class: 'sampler-group', role: 'group', 'aria-label': 'Resample' },
      h('span', { class: 'group-title' }, 'RESAMPLE'), cell.el, result);
  }

  /**
   * What the sampler will have, to hear and edit it that way: normalized, and 12 bit. A sample is sent as it is
   * here, made 12 bit if it isn't. One from the sampler is sent back as it came.
   */
  function asSentGroup(s: Sample): HTMLElement {
    const sample = () => store.samples.get(s.id) ?? s;
    const status = h('span', { class: 'info' });
    const cells = s.fromSampler ? [] : [
      choiceCell('samples.normalize', 'NORMALIZE', ['off', 'on'] as const, ['OFF', 'ON'],
        () => (sample().recipe.normalize ? 'on' : 'off'), (v) => store.updateRecipe(s.id, { normalize: v === 'on' })),
      choiceCell('samples.twelveBit', '12 BIT', ['off', 'on'] as const, ['OFF', 'ON'],
        () => (sample().recipe.twelveBit ? 'on' : 'off'), (v) => store.updateRecipe(s.id, { twelveBit: v === 'on' })),
    ];
    if (cells.length) {
      cells[0].el.title = 'The part between START and END to full level';
      cells[1].el.title = 'The values the sampler keeps, to hear it as the sampler will have it';
    }
    const update = () => {
      const now = sample();
      const level = portionPeak(now.data, usedStart(now), now.end);
      const db = 20 * Math.log10(level);
      status.textContent = `PEAK ${level === 0 ? '-∞' : db > -0.05 ? '0.0' : db.toFixed(1)} DB · `
        + (now.fromSampler ? 'FROM THE SAMPLER, SENT BACK AS IT CAME'
          : isTwelveBit(now.data.subarray(usedStart(now), now.end)) ? '12 BIT, SENT AS IT IS' : 'MADE 12 BIT WHEN SENT');
    };
    update();
    detailRefresh.push(() => {
      cells.forEach((c) => c.refresh());
      update();
    });
    return h('div', { class: 'sampler-group', role: 'group', 'aria-label': 'As sent' },
      h('span', { class: 'group-title' }, 'AS SENT'), ...cells.map((c) => c.el), status);
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
    h('span', { class: 'c-small', title: s.reverse ? 'Plays backwards' : undefined },
      (s.reverse ? '◀' : '') + LOOP_NAMES[LOOP_MODES.indexOf(s.loopMode)]));
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
    wave.setAttack(0);
    wave.setLimit(null);
    wave.setHeads([]);
    const s = store.selectedSample;
    wave.setSample(s);
    if (!s) {
      cells = [];
      detail.replaceChildren(wave.el, h('div', { class: 'empty-help' },
        h('p', {}, 'Load WAV files (several at once, the loop in a WAV file is kept, and one saved here has its '
          + 'settings and keygroups), S700/X7000 QuickDisk images '
          + '(.qd, with their sound and keygroups), or receive a sample from the sampler. Memory is only limited by '
          + 'the browser.'),
        samplerGroup(false)));
      side.replaceChildren();
      return;
    }
    const id = s.id;
    const sample = () => store.samples.get(id) ?? s;
    const name = h('input', { class: 'name-input', value: s.name, maxLength: 24, 'aria-label': 'Sample name',
      onChange: () => store.updateSample(id, { name: name.value.trim() || s.name }) });
    const pointCell = (which: PointName, label: string) => {
      const cell = new ParamCell({
        key: `sample.${which}`, label, min: 0,
        get max() {
          return sample().data.length;
        },
        get coarse() {
          return Math.max(1, Math.round(sample().rate / 100));
        },
        get: () => sample()[which],
        set: (v) => {
          store.updateSample(id, movePoint(sample(), which, v));
          wave.reveal(sample()[which]); // keep it in view when zoomed in
        },
        detail: (v) => `${(v / sample().rate).toFixed(3)}S`,
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
      // the X7000's SCAN DIRECTION: backwards from END to START, the loop mirrored
      choiceCell('sample.direction', 'DIR', ['fwd', 'rev'] as const, ['FWD', 'REV'],
        () => (sample().reverse ? 'rev' : 'fwd'), (v) => store.updateSample(id, { reverse: v === 'rev' })),
      pointCell('loopStart', 'LOOP START'),
      pointCell('loopEnd', 'LOOP END'),
    ];
    const audition = h('button', { class: 'soft', title: 'Hold to play the sample at its own pitch' }, 'PLAY');
    audition.addEventListener('pointerdown', () => actions.auditionStart(sample()));
    for (const type of ['pointerup', 'pointerleave', 'pointercancel']) {
      audition.addEventListener(type, () => actions.auditionStop());
    }
    const rateBadge = h('span', { class: 'badge' });
    const fitBadge = h('span', { class: 'badge' });
    const length = h('span', { class: 'info' });
    const reset = s.fromSampler ? null : h('button', { class: 'soft', onClick: () => actions.resetEdits(sample()),
      title: 'Back to the original as it was loaded: no resampling, normalizing, 12 bit, attack or crossfade' },
    'RESET EDITS');
    const showFit = () => {
      const now = sample();
      const fit = fitText(now);
      fitBadge.hidden = !fit;
      fitBadge.textContent = fit?.text ?? '';
      fitBadge.classList.toggle('warn', !!fit?.warn);
      const bw = samplerBandwidth(now.rate);
      rateBadge.textContent = bw ? `SAMPLER RATE, ${bw.name.toUpperCase()} BANDWIDTH`
        : 'NOT A SAMPLER RATE: RESAMPLE, OR IT IS WHEN SENT';
      rateBadge.classList.toggle('warn', !bw);
      // the sampler's limit counts from where playing starts: START, or END when reversed
      const { limitAt } = samplerFit(now);
      wave.setLimit(now.reverse ? (limitAt > now.start ? limitAt : null) : (limitAt < now.end ? limitAt : null));
      length.textContent = `${now.rate.toFixed(now.rate % 1 ? 2 : 0)} HZ · `
        + (isPortion(now) ? `USING ${duration(now)} OF ${(now.data.length / now.rate).toFixed(2)}S`
          : `${now.data.length} SAMPLES · ${duration(now)}`);
      if (reset) {
        reset.disabled = !isEdited(now.recipe);
      }
    };
    showFit();
    detailRefresh.push(showFit);
    const edits = s.fromSampler
      ? [h('p', { class: 'info sampler-note' }, 'FROM THE SAMPLER: IT IS SENT BACK AS IT CAME, SO THE AUDIO ISN\'T '
        + 'EDITED (NO RESAMPLING, NORMALIZING, ATTACK OR CROSSFADE). THE POINTS, SCAN, DIR AND SOUND CAN BE SET.')]
      : [attackGroup(s), crossfadeGroup(s), resampleGroup(s)];
    detail.replaceChildren(
      h('div', { class: 'row' }, name,
        length,
        s.fromSampler ? h('span', { class: 'badge', title: 'Received from the sampler, or saved from such a sample' },
          'FROM THE SAMPLER') : null,
        rateBadge,
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
        reset,
        h('button', { class: 'soft', onClick: () => actions.saveWav(sample()),
          title: 'The sample as it sounds, with its loop, and its settings and keygroups for loading it here again' },
        'SAVE WAV'),
        h('button', { class: 'soft', onClick: () => actions.saveDisk(sample()),
          title: 'An S700/X7000 disk image (.qd) of the sample, with its sound and keygroups, for a Gotek or HxC' },
        'SAVE QD'),
        h('button', { class: 'soft danger', onClick: () => {
          if (confirm(`Delete ${sample().name}?`)) {
            store.removeSample(id);
          }
        } }, 'DELETE')),
      ...edits);
    side.replaceChildren(asSentGroup(s), samplerGroup(true));
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
    // rendered again: new audio, and new points at a new rate
    store.on('audio', (id) => {
      if (id && id === store.selectedSampleId) {
        wave.setSample(store.selectedSample);
      }
      refresh(id);
    }),
    app.engine.onPositions((bySample) => wave.setHeads(bySample.get(store.selectedSampleId ?? '') ?? [])),
  ];
  detail.dataset.sample = store.selectedSampleId ?? '';
  return {
    el: h('div', { class: 'view view-samples' }, h('div', { class: 'detail' }, loadRow, list, side), detail),
    dispose: () => [...off, ...detailOff].forEach((f) => f()),
  };
}
