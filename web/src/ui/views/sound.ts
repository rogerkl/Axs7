// FILTER and AMP: the current program's filter with its envelope, and its level with the amp envelope.

import type { App, View } from '../../app/app';
import { envTime, formatHz, formatTime, resonanceQ } from '../../model/params';
import type { Envelope } from '../../model/types';
import { h } from '../dom';
import { ParamCell, choiceCell } from '../param';

const POLYPHONY = ['6', '8', '16', '32'] as const;

function envelopeCells(app: App, which: 'filterEnv' | 'ampEnv'): ParamCell[] {
  const { store } = app;
  const cell = (field: keyof Envelope, label: string) => new ParamCell({
    key: `${which}.${field}`, label, min: 0, max: 99, coarse: 10,
    get: () => store.program[which][field],
    set: (v) => store.updateEnvelope(which, { [field]: v }),
    detail: field === 'sustain' ? undefined : formatTime,
  });
  return [cell('attack', 'ATTACK'), cell('decay', 'DECAY'), cell('sustain', 'SUSTAIN'), cell('release', 'RELEASE')];
}

/** Draws an envelope, time on a compressed scale so short and long settings both show */
class EnvelopeGraph {
  readonly el: HTMLCanvasElement = h('canvas', { class: 'env-graph', 'aria-hidden': 'true' });

  constructor(private get: () => Envelope) {
    new ResizeObserver(() => this.draw()).observe(this.el);
  }

  draw(): void {
    const c = this.el;
    const dpr = window.devicePixelRatio || 1;
    const w = (c.width = Math.max(1, Math.round(c.clientWidth * dpr)));
    const height = (c.height = Math.max(1, Math.round(c.clientHeight * dpr)));
    const ctx = c.getContext('2d')!;
    const env = this.get();
    const scale = (v: number) => Math.cbrt(envTime(v));
    const a = scale(env.attack);
    const d = scale(env.decay);
    const r = scale(env.release);
    const hold = 0.8;
    const total = a + d + hold + r;
    const x = (t: number) => 4 * dpr + (t / total) * (w - 8 * dpr);
    const y = (level: number) => height - 4 * dpr - level * (height - 8 * dpr);
    const s = env.sustain / 99;
    ctx.strokeStyle = getComputedStyle(c).getPropertyValue('--wave').trim();
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    ctx.moveTo(x(0), y(0));
    ctx.lineTo(x(a), y(1));
    for (let i = 1; i <= 16; i++) {
      ctx.lineTo(x(a + (d * i) / 16), y(s + (1 - s) * 0.001 ** (i / 16)));
    }
    ctx.lineTo(x(a + d + hold), y(s));
    for (let i = 1; i <= 16; i++) {
      ctx.lineTo(x(a + d + hold + (r * i) / 16), y(s * 0.001 ** (i / 16)));
    }
    ctx.stroke();
  }
}

function soundView(app: App, className: string, top: ParamCell[], which: 'filterEnv' | 'ampEnv', help: string,
  extra: ParamCell[] = []): View {
  const { store } = app;
  const env = envelopeCells(app, which);
  const graph = new EnvelopeGraph(() => store.program[which]);
  const refresh = () => {
    for (const c of [...top, ...env, ...extra]) {
      c.refresh();
    }
    graph.draw();
  };
  const off = [store.on('program', refresh), store.on('programs', refresh)];
  return {
    el: h('div', { class: `view ${className}` },
      h('div', { class: 'params' }, ...top.map((c) => c.el), ...extra.map((c) => c.el)),
      h('div', { class: 'env' },
        h('div', { class: 'env-title' }, which === 'filterEnv' ? 'FILTER ENVELOPE' : 'AMP ENVELOPE'),
        h('div', { class: 'params' }, ...env.map((c) => c.el)), graph.el),
      h('p', { class: 'info' }, help)),
    dispose: () => off.forEach((f) => f()),
  };
}

export function filterView(app: App): View {
  const { store } = app;
  const signed = (v: number) => (v > 0 ? `+${v}` : String(v));
  return soundView(app, 'view-filter', [
    new ParamCell({ key: 'filter.cutoff', label: 'CUTOFF', min: 0, max: 99, coarse: 10, get: () => store.program.cutoff,
      set: (cutoff) => store.updateProgram({ cutoff }), detail: formatHz }),
    new ParamCell({ key: 'filter.resonance', label: 'RESONANCE', min: 0, max: 99, coarse: 10,
      get: () => store.program.resonance, set: (resonance) => store.updateProgram({ resonance }),
      detail: (v) => `Q ${resonanceQ(v).toFixed(1)}` }),
    new ParamCell({ key: 'filter.env', label: 'ENV AMT', min: -99, max: 99, coarse: 10,
      get: () => store.program.envAmount, set: (envAmount) => store.updateProgram({ envAmount }), format: signed,
      detail: (v) => `${signed(Math.round((v / 99) * 8 * 10) / 10)} OCT` }),
  ], 'filterEnv', 'Resonant lowpass, 12 dB/octave. The envelope moves the cutoff up (or down) by up to 8 octaves.');
}

export function ampView(app: App): View {
  const { store, settings, engine } = app;
  return soundView(app, 'view-amp', [
    new ParamCell({ key: 'amp.level', label: 'LEVEL', min: 0, max: 99, coarse: 10, get: () => store.program.level,
      set: (level) => store.updateProgram({ level }) }),
    new ParamCell({ key: 'amp.velocity', label: 'VEL SENS', min: 0, max: 99, coarse: 10,
      get: () => store.program.velocity, set: (velocity) => store.updateProgram({ velocity }) }),
  ], 'ampEnv', 'Voices: the X7000 has 6. The oldest note stops when they are all in use.', [
    choiceCell('amp.voices', 'VOICES', POLYPHONY, [...POLYPHONY],
      () => String(settings.polyphony) as (typeof POLYPHONY)[number], (v) => {
        settings.polyphony = Number(v);
        engine.polyphony(settings.polyphony);
        app.saveSettings();
      }),
  ]);
}
