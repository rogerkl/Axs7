// The front panel's controls: buttons, the data knob, the pitch and modulation wheels and the volume fader.

import { h } from './dom';

export interface PanelButton {
  el: HTMLElement;
  button: HTMLButtonElement;
  setLed(on: boolean, blink?: boolean): void;
}

/**
 * A light grey panel button with its label printed above it, and an optional LED. `printed: false` leaves the
 * label out, for buttons whose name is printed elsewhere (the blue strip).
 */
export function panelButton(label: string, onClick: () => void,
  options: { led?: boolean; title?: string; printed?: boolean } = {}): PanelButton {
  const led = options.led ? h('span', { class: 'led' }) : null;
  const button = h('button', { class: 'pbtn', title: options.title ?? label, 'aria-label': label, onClick });
  const el = h('div', { class: 'pbtn-wrap' },
    h('span', { class: 'pbtn-label' }, led, options.printed === false ? null : label), button);
  return {
    el,
    button,
    setLed(on, blink = false) {
      led?.classList.toggle('on', on);
      led?.classList.toggle('blink', on && blink);
    },
  };
}

/** Pointer drag in steps of `pixels` up/down */
function dragSteps(el: HTMLElement, pixels: number, onSteps: (steps: number, e: PointerEvent) => void,
  onEnd?: () => void): void {
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    let last = e.clientY;
    const move = (m: PointerEvent) => {
      const steps = Math.trunc((last - m.clientY) / pixels);
      if (steps !== 0) {
        last -= steps * pixels;
        onSteps(steps, m);
      }
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onEnd?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  });
}

/** The data entry knob, an endless encoder */
export class Knob {
  readonly el: HTMLElement;
  private cap: HTMLElement;
  private angle = 0;

  constructor(onTurn: (steps: number, coarse: boolean) => void) {
    this.cap = h('div', { class: 'knob-cap' }, h('div', { class: 'knob-mark' }));
    const knob = h('div', { class: 'knob', title: 'Data entry: drag up/down or scroll, shift for bigger steps',
      role: 'slider', 'aria-label': 'Data entry' }, this.cap);
    this.el = h('div', { class: 'knob-wrap' }, knob, h('span', { class: 'panel-label' }, 'DATA'));
    const turn = (steps: number, coarse: boolean) => {
      this.angle += steps * 15;
      this.cap.style.transform = `rotate(${this.angle}deg)`;
      onTurn(steps, coarse);
    };
    dragSteps(knob, 6, (steps, e) => turn(steps, e.shiftKey));
    knob.addEventListener('wheel', (e) => {
      e.preventDefault();
      turn(e.deltaY < 0 ? 1 : -1, e.shiftKey);
    }, { passive: false });
  }
}

/** A pitch or modulation wheel. The pitch wheel springs back to the middle when let go. */
export class Wheel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private value: number;

  constructor(label: string, private readonly range: { min: number; max: number; spring: boolean },
    private readonly onChange: (value: number) => void) {
    this.value = range.spring ? 0 : range.min;
    this.body = h('div', { class: 'wheel-body' });
    const slot = h('div', { class: 'wheel-slot', role: 'slider', 'aria-label': label }, this.body);
    this.el = h('div', { class: 'wheel-wrap' }, slot, h('span', { class: 'panel-label' }, label));
    dragSteps(slot, 1, (steps) => this.input(this.value + steps / 50), () => {
      if (range.spring) {
        this.input(0);
      }
    });
    this.show();
  }

  private input(v: number): void {
    this.set(v);
    this.onChange(this.value);
  }

  /** Shows a value from elsewhere (MIDI) */
  set(v: number): void {
    this.value = Math.max(this.range.min, Math.min(this.range.max, v));
    this.show();
  }

  private show(): void {
    const { min, max } = this.range;
    // -1..1 over the wheel's travel
    const pos = ((this.value - min) / (max - min)) * 2 - 1;
    this.body.style.backgroundPositionY = `${-pos * 18}px`;
    this.body.style.setProperty('--tilt', `${-pos * 14}px`);
  }
}

/** The volume fader */
export class Fader {
  readonly el: HTMLElement;
  private cap: HTMLElement;

  constructor(label: string, private value: number, onChange: (value: number) => void) {
    this.cap = h('div', { class: 'fader-cap' });
    const track = h('div', { class: 'fader-track', role: 'slider', 'aria-label': label }, this.cap);
    this.el = h('div', { class: 'fader-wrap' }, track, h('span', { class: 'panel-label' }, label));
    dragSteps(track, 1, (steps) => {
      this.value = Math.max(0, Math.min(1, this.value + steps / 80));
      this.show();
      onChange(this.value);
    });
    this.show();
  }

  private show(): void {
    this.cap.style.bottom = `${this.value * 78}%`;
  }
}
