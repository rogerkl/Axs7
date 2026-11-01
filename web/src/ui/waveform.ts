// A sample's waveform with its loop. The loop start and end markers can be dragged.

import { h } from './dom';
import type { Sample } from '../model/types';

const GRAB = 8;

export class Waveform {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private sample: Sample | null = null;
  private dragging: 'start' | 'end' | null = null;
  onLoop: (start: number, end: number) => void = () => {};

  constructor() {
    this.canvas = h('canvas', { class: 'wave', 'aria-label': 'Waveform, drag the loop markers' });
    this.el = h('div', { class: 'wave-wrap' }, this.canvas);
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) {
        this.canvas.style.cursor = this.markerAt(e.offsetX) ? 'ew-resize' : 'default';
      }
    });
  }

  setSample(sample: Sample | null): void {
    this.sample = sample;
    this.draw();
  }

  private x(index: number): number {
    return this.sample ? (index / Math.max(1, this.sample.data.length)) * this.canvas.clientWidth : 0;
  }

  private markerAt(px: number): 'start' | 'end' | null {
    const s = this.sample;
    if (!s || s.loopMode === 'off') {
      return null;
    }
    const dEnd = Math.abs(px - this.x(s.loopEnd));
    const dStart = Math.abs(px - this.x(s.loopStart));
    if (Math.min(dEnd, dStart) > GRAB) {
      return null;
    }
    return dEnd <= dStart ? 'end' : 'start';
  }

  private onPointerDown = (e: PointerEvent): void => {
    const marker = this.markerAt(e.offsetX);
    const s = this.sample;
    if (!marker || !s) {
      return;
    }
    this.dragging = marker;
    this.canvas.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      const index = Math.round(((m.clientX - rect.left) / rect.width) * s.data.length);
      if (this.dragging === 'start') {
        this.onLoop(Math.max(0, Math.min(index, s.loopEnd - 2)), s.loopEnd);
      } else {
        this.onLoop(s.loopStart, Math.max(s.loopStart + 2, Math.min(index, s.data.length)));
      }
    };
    const up = () => {
      this.dragging = null;
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
  };

  draw(): void {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const height = Math.max(1, Math.round(c.clientHeight * dpr));
    c.width = w;
    c.height = height;
    const ctx = c.getContext('2d')!;
    const css = getComputedStyle(c);
    const color = (name: string) => css.getPropertyValue(name).trim();
    ctx.fillStyle = color('--wave-grid');
    ctx.fillRect(0, Math.floor(height / 2), w, Math.max(1, dpr));
    const s = this.sample;
    if (!s || s.data.length === 0) {
      return;
    }
    const n = s.data.length;
    const x = (i: number) => (i / n) * w;
    if (s.loopMode !== 'off') {
      ctx.fillStyle = color('--wave-loop');
      ctx.fillRect(x(s.loopStart), 0, x(s.loopEnd) - x(s.loopStart), height);
    }
    ctx.fillStyle = color('--wave');
    for (let px = 0; px < w; px++) {
      const a = Math.floor((px * n) / w);
      const b = Math.max(a + 1, Math.floor(((px + 1) * n) / w));
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = a; i < b && i < n; i++) {
        lo = Math.min(lo, s.data[i]);
        hi = Math.max(hi, s.data[i]);
      }
      if (lo <= hi) {
        const y1 = ((1 - hi) * height) / 2;
        const y2 = ((1 - lo) * height) / 2;
        ctx.fillRect(px, y1, 1, Math.max(1, y2 - y1));
      }
    }
    if (s.loopMode !== 'off') {
      ctx.fillStyle = color('--wave-marker');
      ctx.fillRect(x(s.loopStart), 0, 2 * dpr, height);
      ctx.fillRect(Math.max(0, x(s.loopEnd) - 2 * dpr), 0, 2 * dpr, height);
    }
  }
}
