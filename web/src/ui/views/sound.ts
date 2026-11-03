// OUT and LFO: a sample's sound, as on the X7000, where they belong to the sample. OUT is its level, lowpass filter
// and release, each with how much velocity changes it. LFO is its vibrato, also from MIDI aftertouch.

import type { App, View } from '../../app/app';
import {
  cutoffHz, formatHz, formatSeconds, lfoDelay, lfoDepth, lfoRate, releaseTime, velFilterOctaves,
} from '../../model/params';
import type { Sound } from '../../model/types';
import { h } from '../dom';
import { ParamCell } from '../param';

type SoundSpec = [keyof Sound, string, ((v: number) => string)?];

/** The selected sample's sound settings, with a SAMPLE cell to pick the sample, like the X7000's SAMPLE button */
function soundView(app: App, className: string, title: string, specs: SoundSpec[], help: string,
  extra?: { el: HTMLElement; dispose: () => void }): View {
  const { store } = app;
  const body = h('div', { class: 'detail' });
  let cells: ParamCell[] = [];

  function build(): void {
    const ids = [...store.samples.keys()];
    const s = store.selectedSample;
    if (!s) {
      cells = [];
      body.replaceChildren(h('div', { class: 'list-empty' }, 'NO SAMPLE IN MEMORY'));
      return;
    }
    const picker = new ParamCell({
      key: 'sound.sample', label: 'SAMPLE', min: 1, max: ids.length, coarse: 1,
      get: () => ids.indexOf(store.selectedSampleId ?? '') + 1,
      set: (v) => store.selectSample(ids[v - 1]),
      format: (v) => `S${String(v).padStart(2, '0')}`,
      detail: (v) => store.samples.get(ids[v - 1])?.name ?? '',
    });
    cells = specs.map(([field, label, detail]) => new ParamCell({
      key: `sound.${field}`, label, min: 0, max: 99, coarse: 10,
      get: () => store.selectedSample?.sound[field] ?? 0,
      set: (v) => store.updateSound(s.id, { [field]: v }),
      detail,
    }));
    body.replaceChildren(
      h('div', { class: 'row' }, picker.el, h('span', { class: 'sample-title' }, s.name)),
      h('div', { class: 'env-title' }, title),
      h('div', { class: 'params' }, ...cells.map((c) => c.el)),
      ...(extra ? [extra.el] : []),
      h('p', { class: 'info' }, help));
  }

  build();
  const off = [
    store.on('samples', build),
    store.on('selection', build),
    store.on('sample', () => cells.forEach((c) => c.refresh())),
  ];
  return {
    el: h('div', { class: `view ${className}` }, body),
    dispose: () => {
      off.forEach((f) => f());
      extra?.dispose();
    },
  };
}

const percent = (v: number) => `${Math.round((v / 99) * 100)}%`;

export function outView(app: App): View {
  return soundView(app, 'view-out', 'OUT', [
    ['level', 'LEVEL'],
    ['velLevel', 'VEL LEVEL', percent],
    ['filter', 'FILTER', (v) => formatHz(cutoffHz(v))],
    ['velFilter', 'VEL FILTER', (v) => `+${velFilterOctaves(v).toFixed(1)} OCT`],
    ['release', 'RELEASE', (v) => formatSeconds(releaseTime(v))],
    ['velRelease', 'VEL RELEASE', percent],
  ], 'As on the X7000: the filter is a lowpass without resonance, velocity raises its cutoff. Release is for looping '
    + 'and alternating samples, a one shot stops at key off and a drum trigger plays to its end. Velocity shortens the '
    + 'release: with VEL RELEASE at 99 a hard note has none, a soft one all of it. These settings are '
    + 'the sample\'s, every program playing it sounds the same. They are not part of a sample dump.');
}

export function lfoView(app: App): View {
  const cents = (v: number) => `±${Math.round(lfoDepth(v) * 100)} CENTS`;
  // what comes in, to see that the keyboard sends aftertouch at all (the X7000's doesn't)
  const meter = h('div', { class: 'pressure-meter' }, h('div', { class: 'pressure-fill' }));
  const value = h('span', { class: 'info' }, 'NONE YET');
  const previous = app.player.onPressure;
  app.player.onPressure = (v) => {
    previous(v);
    (meter.firstChild as HTMLElement).style.width = `${v * 100}%`;
    value.textContent = String(Math.round(v * 127));
  };
  return soundView(app, 'view-lfo', 'LFO', [
    ['lfoSpeed', 'SPEED', (v) => formatHz(lfoRate(v))],
    ['lfoDepth', 'DEPTH', cents],
    ['lfoDelay', 'DELAY', (v) => formatSeconds(lfoDelay(v))],
    ['pressure', 'PRESSURE', cents], // at full aftertouch
  ], 'Vibrato, starting DELAY after key on. The modulation wheel adds vibrato too, at the sample\'s speed. '
    + 'PRESSURE is the X7000\'s pressure sens: MIDI aftertouch (channel or polyphonic) adds vibrato that deep at full '
    + 'pressure, at once, without the delay.', {
    el: h('div', { class: 'row' }, h('span', { class: 'param-label' }, 'AFTERTOUCH IN'), meter, value),
    dispose: () => {
      app.player.onPressure = previous;
    },
  });
}
