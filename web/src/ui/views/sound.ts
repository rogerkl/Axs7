// OUT and LFO: a sample's sound, as on the X7000, where they belong to the sample. OUT is its level, lowpass filter
// and release, each with how much velocity changes it. LFO is its vibrato, also from MIDI aftertouch.

import type { App, View } from '../../app/app';
import {
  cutoffHz, formatHz, formatSeconds, levelDb, lfoDelay, lfoDepth, lfoRate, pressureSteps, releaseTime, velFilterOctaves,
  velLevelRange, velReleaseDoublings, vibratoStep,
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
      format: (v) => String(v).padStart(2, '0'), // as numbered in the SAMPLE view's list
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

export function outView(app: App): View {
  return soundView(app, 'view-out', 'OUT', [
    ['level', 'LEVEL', (v) => `${levelDb(v).toFixed(1)}DB`],
    ['velLevel', 'VEL LEVEL', (v) => `${Math.round(velLevelRange(v))}DB RANGE`],
    ['filter', 'FILTER', (v) => formatHz(cutoffHz(v))],
    ['velFilter', 'VEL FILTER', (v) => `±${velFilterOctaves(v).toFixed(1)} OCT`],
    ['release', 'RELEASE', (v) => formatSeconds(releaseTime(v))],
    ['velRelease', 'VEL RELEASE', (v) => `×${(2 ** velReleaseDoublings(v)).toFixed(1)} SLOW OFF`],
  ], 'As measured on the sampler: LEVEL 0 is 34 dB under 99, not silent. The filter is a steep lowpass (36 dB an '
    + 'octave) without resonance, a velocity over 64 raises its cutoff, under 64 lowers it. The release fades a sample '
    + 'out after key off, a one shot too (the manual has it for looping only), a drum trigger plays to its end. VEL RELEASE '
    + 'follows the note off\'s velocity, how fast the key comes up: over 64 shortens the release, under 64 makes it '
    + 'longer (the screen and computer keyboard send 64). These settings are '
    + 'the sample\'s, every program playing it sounds the same. They are not part of a sample dump.');
}

export function lfoView(app: App): View {
  const cents = (semitones: number) => `±${Math.round(semitones * 100)} CENTS`;
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
    ['lfoSpeed', 'SPEED', (v) => (v ? formatHz(lfoRate(v)) : 'OFF')],
    ['lfoDepth', 'DEPTH', (v) => cents(lfoDepth(v))],
    ['lfoDelay', 'DELAY', (v) => `${formatSeconds(lfoDelay(v))} A STEP`],
    ['pressure', 'PRESSURE', (v) => cents(vibratoStep(pressureSteps(v)))], // at full aftertouch
  ], 'Vibrato as measured on the sampler: a sine from key on, in 8 depths 6.4 cents apart, up to ±47 cents. DELAY '
    + 'brings it in a step at a time. The modulation wheel adds a step for each sixteenth of its travel, at the '
    + 'sample\'s speed. PRESSURE is the sampler\'s pressure sens, for MIDI channel aftertouch: at 99 it adds a step for '
    + 'each sixteenth of the pressure, at once, without the delay, at 50 half as many. Polyphonic aftertouch does '
    + 'nothing, as on the sampler. PRESSURE isn\'t sent with the sample: set it on the sampler.', {
    el: h('div', { class: 'row' }, h('span', { class: 'param-label' }, 'AFTERTOUCH IN'), meter, value),
    dispose: () => {
      app.player.onPressure = previous;
    },
  });
}
