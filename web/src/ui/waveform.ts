// A sample's waveform with its points, what the sampler keeps of it, and playback heads, with zoom.
//
// START and END (tags S and E at the bottom) and the loop (LS and LE at the top) can be dragged. The mouse wheel
// zooms around the pointer, dragging elsewhere or shift + wheel pans, a double click zooms in. The overview under
// the wave shows the whole sample and the part that is shown. The heads are drawn on a layer of their own, so they
// can move without redrawing the wave.

import { h } from './dom';
import type { PointName } from '../model/points';
import { isLooped } from '../model/types';
import type { Sample } from '../model/types';

const GRAB = 8;
/** the fewest samples across the view */
const MIN_SPAN = 24;
const TAGS: Record<PointName, string> = { start: 'S', end: 'E', loopStart: 'LS', loopEnd: 'LE' };

export class Waveform {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private overlay: HTMLCanvasElement;
  private overview: HTMLCanvasElement;
  private viewInfo: HTMLElement;
  private sample: Sample | null = null;
  /** the part shown, in samples */
  private from = 0;
  private to = 1;
  /** where the sampler's maximum length ends, null if the used part fits */
  private limit: number | null = null;
  /** samples of crossfade to show, 0 for none */
  private crossfade = 0;
  private heads: number[] = [];
  private headsFrame = 0;
  private dragging: PointName | 'pan' | null = null;
  onPoint: (which: PointName, value: number) => void = () => {};
  /** a point marker was grabbed, so its parameter can be selected for fine tuning */
  onGrab: (which: PointName) => void = () => {};

  constructor() {
    this.canvas = h('canvas', { class: 'wave', 'aria-label': 'Waveform: drag the points, scroll to zoom' });
    this.overlay = h('canvas', { class: 'wave-heads', 'aria-hidden': 'true' });
    this.overview = h('canvas', { class: 'wave-overview', 'aria-label': 'Overview, click to move the view' });
    this.viewInfo = h('span', { class: 'wave-view' });
    const tool = (label: string, title: string, run: () => void) =>
      h('button', { class: 'soft small', title, onClick: run }, label);
    const goTo = (which: PointName) => () => this.sample && this.centerOn(this.sample[which], this.detailSpan());
    this.el = h('div', { class: 'wave-wrap' },
      h('div', { class: 'wave-tools' },
        tool('−', 'Zoom out', () => this.zoomBy(2)),
        tool('+', 'Zoom in', () => this.zoomBy(0.5)),
        tool('ALL', 'Show the whole sample', () => this.showAll()),
        h('span', { class: 'wave-tools-gap' }),
        tool('START', 'Zoom to START', goTo('start')),
        tool('LOOP START', 'Zoom to the loop start', goTo('loopStart')),
        tool('LOOP END', 'Zoom to the loop end', goTo('loopEnd')),
        tool('END', 'Zoom to END', goTo('end')),
        this.viewInfo),
      h('div', { class: 'wave-stage' }, this.canvas, this.overlay),
      this.overview);
    new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) {
        this.canvas.style.cursor = this.markerAt(e.offsetX, e.offsetY) ? 'ew-resize'
          : this.zoomed() ? 'grab' : 'default';
      }
    });
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('dblclick', (e) => {
      if (!this.markerAt(e.offsetX, e.offsetY)) {
        this.zoomBy(0.25, this.indexAt(e.offsetX));
      }
    });
    this.overview.addEventListener('pointerdown', (e) => {
      this.overview.setPointerCapture(e.pointerId);
      const move = (m: PointerEvent) => {
        const r = this.overview.getBoundingClientRect();
        this.centerOn(((m.clientX - r.left) / r.width) * this.length, this.to - this.from);
      };
      move(e);
      this.overview.onpointermove = move;
      this.overview.onpointerup = () => {
        this.overview.onpointermove = null;
      };
    });
  }

  private get length(): number {
    return this.sample?.data.length ?? 0;
  }

  private zoomed(): boolean {
    return this.to - this.from < this.length;
  }

  setSample(sample: Sample | null): void {
    const fresh = sample?.data !== this.sample?.data; // another sample, or new audio after a resample or trim
    this.sample = sample;
    if (fresh) {
      this.from = 0;
      this.to = Math.max(1, this.length);
    }
    this.draw();
  }

  /** Where the sampler's maximum length ends, null if the used part fits whole */
  setLimit(limit: number | null): void {
    if (limit !== this.limit) {
      this.limit = limit;
      this.draw();
    }
  }

  /** Shows a crossfade loop: the end of the loop that fades, and what before the start it fades into */
  setCrossfade(length: number): void {
    if (length !== this.crossfade) {
      this.crossfade = length;
      this.draw();
    }
  }

  /** Playback heads at these positions in the sample */
  setHeads(positions: number[]): void {
    this.heads = positions;
    if (!this.headsFrame) {
      this.headsFrame = requestAnimationFrame(() => {
        this.headsFrame = 0;
        this.drawHeads();
      });
    }
  }

  // ---------------------------------------------------------------- view

  private setView(from: number, span: number): void {
    const n = this.length;
    const s = Math.max(Math.min(MIN_SPAN, n), Math.min(n, span));
    this.from = Math.max(0, Math.min(n - s, from));
    this.to = this.from + s;
    this.draw();
  }

  showAll(): void {
    this.setView(0, this.length);
  }

  /** @param factor below 1 zooms in */
  zoomBy(factor: number, anchor = (this.from + this.to) / 2): void {
    const span = (this.to - this.from) * factor;
    const at = (anchor - this.from) / (this.to - this.from);
    this.setView(anchor - at * span, span);
  }

  centerOn(index: number, span: number): void {
    this.setView(index - span / 2, span);
  }

  /** Keeps a point in view when it is moved from elsewhere (the knob), without changing the zoom */
  reveal(index: number): void {
    if (index < this.from || index > this.to) {
      this.centerOn(index, this.to - this.from);
    }
  }

  /** The span to zoom to a point with: as it is if zoomed in already, else 50 ms */
  private detailSpan(): number {
    const span = this.to - this.from;
    return span < this.length / 4 ? span : Math.max(256, Math.round((this.sample?.rate ?? 44100) * 0.05));
  }

  private indexAt(cssX: number): number {
    return this.from + (cssX / Math.max(1, this.canvas.clientWidth)) * (this.to - this.from);
  }

  private cssX(index: number): number {
    return ((index - this.from) / (this.to - this.from)) * this.canvas.clientWidth;
  }

  // ---------------------------------------------------------------- pointer

  /**
   * The point marker at a position. Where two are close, the loop's tags are at the top and START and END's at the
   * bottom, so the height picks one.
   */
  private markerAt(px: number, py: number): PointName | null {
    const s = this.sample;
    if (!s) {
      return null;
    }
    const names: PointName[] = isLooped(s.loopMode) ? ['start', 'end', 'loopStart', 'loopEnd'] : ['start', 'end'];
    const near = names.map((n) => ({ n, d: Math.abs(px - this.cssX(s[n])) })).filter((m) => m.d <= GRAB);
    if (!near.length) {
      return null;
    }
    const top = py < this.canvas.clientHeight / 2;
    const closest = Math.min(...near.map((m) => m.d));
    const tied = near.filter((m) => m.d - closest < 2);
    return (tied.find((m) => m.n.startsWith('loop') === top) ?? tied[0]).n;
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.sample || e.button !== 0) {
      return;
    }
    const marker = this.markerAt(e.offsetX, e.offsetY);
    if (!marker && !this.zoomed()) {
      return;
    }
    this.dragging = marker ?? 'pan';
    if (marker) {
      this.onGrab(marker);
    }
    this.canvas.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startFrom = this.from;
    const move = (m: PointerEvent) => {
      const rect = this.canvas.getBoundingClientRect();
      if (this.dragging === 'pan') {
        this.canvas.style.cursor = 'grabbing';
        this.setView(startFrom - ((m.clientX - startX) / rect.width) * (this.to - this.from), this.to - this.from);
      } else if (this.dragging) {
        this.onPoint(this.dragging, this.indexAt(m.clientX - rect.left));
      }
    };
    const up = () => {
      this.dragging = null;
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
      this.canvas.removeEventListener('pointercancel', up);
    };
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.sample) {
      return;
    }
    e.preventDefault();
    const span = this.to - this.from;
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const delta = (e.shiftKey ? e.deltaY : 0) + e.deltaX;
      this.setView(this.from + (delta / Math.max(1, this.canvas.clientWidth)) * span, span);
    } else {
      this.zoomBy(Math.exp(e.deltaY * 0.002), this.indexAt(e.offsetX));
    }
  };

  // ---------------------------------------------------------------- drawing

  private drawHeads(): void {
    const c = this.overlay;
    if (!c.isConnected) {
      return;
    }
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!this.sample) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    ctx.fillStyle = getComputedStyle(c).getPropertyValue('--wave-head').trim();
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 6 * dpr;
    for (const p of this.heads) {
      if (p < this.from || p > this.to) {
        continue;
      }
      const x = Math.round(this.cssX(p) * dpr);
      ctx.fillRect(x - dpr, 0, 2 * dpr, c.height);
      ctx.beginPath(); // a small pointer at the top
      ctx.moveTo(x - 5 * dpr, 0);
      ctx.lineTo(x + 5 * dpr, 0);
      ctx.lineTo(x, 6 * dpr);
      ctx.fill();
    }
  }

  draw(): void {
    const c = this.canvas;
    if (!c.isConnected) {
      return; // no styles to draw with yet, the resize observer draws it once it is on the page
    }
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const height = Math.max(1, Math.round(c.clientHeight * dpr));
    c.width = w;
    c.height = height;
    this.overlay.width = w;
    this.overlay.height = height;
    this.drawHeads();
    const ctx = c.getContext('2d')!;
    const css = getComputedStyle(c);
    const color = (name: string) => css.getPropertyValue(name).trim();
    ctx.fillStyle = color('--wave-grid');
    ctx.fillRect(0, Math.floor(height / 2), w, Math.max(1, dpr));
    const s = this.sample;
    this.drawOverview();
    if (!s || s.data.length === 0) {
      this.viewInfo.textContent = '';
      return;
    }
    const { from, to } = this;
    const span = to - from;
    const x = (i: number) => ((i - from) / span) * w;
    const band = (a: number, b: number, fill: string | CanvasGradient) => {
      const x1 = Math.max(0, x(a));
      const x2 = Math.min(w, x(b));
      if (x2 > x1) {
        ctx.fillStyle = fill;
        ctx.fillRect(x1, 0, Math.max(1, x2 - x1), height);
      }
    };
    const looped = isLooped(s.loopMode);
    if (looped) {
      band(s.loopStart, s.loopEnd, color('--wave-loop'));
    }
    const fade = s.loopMode === 'forward' ? Math.min(this.crossfade, s.loopStart, s.loopEnd - s.loopStart) : 0;
    if (fade > 0) {
      const xfade = color('--wave-xfade');
      const ramp = ctx.createLinearGradient(x(s.loopEnd - fade), 0, x(s.loopEnd), 0);
      ramp.addColorStop(0, 'transparent');
      ramp.addColorStop(1, xfade);
      band(s.loopEnd - fade, s.loopEnd, ramp);
      ctx.globalAlpha = 0.5;
      band(s.loopStart - fade, s.loopStart, xfade);
      ctx.globalAlpha = 1;
    }
    this.drawWave(ctx, x, w, height, color('--wave'), dpr);
    // what isn't used or kept
    band(0, s.start, color('--wave-unused'));
    band(s.end, s.data.length, color('--wave-unused'));
    if (looped) {
      band(s.loopEnd, s.end, color('--wave-dropped')); // the sampler ends a looped sample at the loop end
    }
    if (this.limit !== null) {
      band(this.limit, s.data.length, color('--wave-over'));
      const lx = x(this.limit);
      if (lx >= 0 && lx <= w) {
        ctx.fillStyle = color('--wave-limit');
        for (let y = 0; y < height; y += 8 * dpr) {
          ctx.fillRect(lx, y, 2 * dpr, 4 * dpr); // dashed
        }
        ctx.font = `${9 * dpr}px "Helvetica Neue", Arial, sans-serif`;
        const label = 'SAMPLER LIMIT';
        const tw = ctx.measureText(label).width;
        ctx.fillText(label, lx + tw + 6 * dpr < w ? lx + 4 * dpr : lx - tw - 4 * dpr, height / 2 - 6 * dpr);
      }
    }
    // the points, with tags: the loop's at the top, START and END at the bottom
    const marker = (which: PointName, fill: string) => {
      const mx = x(s[which]);
      if (mx < -GRAB * dpr || mx > w + GRAB * dpr) {
        return;
      }
      const atEnd = which === 'end' || which === 'loopEnd';
      ctx.fillStyle = fill;
      ctx.fillRect(Math.round(mx) - (atEnd ? 2 * dpr : 0), 0, 2 * dpr, height);
      const tag = TAGS[which];
      ctx.font = `bold ${8.5 * dpr}px "Helvetica Neue", Arial, sans-serif`;
      const tw = ctx.measureText(tag).width + 6 * dpr;
      const th = 12 * dpr;
      const tx = atEnd ? mx - tw : mx;
      const ty = which.startsWith('loop') ? 0 : height - th;
      ctx.fillRect(tx, ty, tw, th);
      ctx.fillStyle = '#10140d';
      ctx.fillText(tag, tx + 3 * dpr, ty + 9 * dpr);
    };
    if (looped) {
      marker('loopStart', color('--wave-marker'));
      marker('loopEnd', color('--wave-marker'));
    }
    marker('start', color('--wave-point'));
    marker('end', color('--wave-point'));
    const seconds = (i: number) => (i / s.rate).toFixed(span / s.rate < 0.5 ? 4 : 3);
    this.viewInfo.textContent = this.zoomed()
      ? `${seconds(from)}–${seconds(to)}S ×${(s.data.length / span).toFixed(span < s.data.length / 10 ? 0 : 1)}`
      : `${seconds(s.data.length)}S`;
  }

  /** Min/max per pixel when zoomed out, a line through the samples when zoomed in, with dots when far in */
  private drawWave(ctx: CanvasRenderingContext2D, x: (i: number) => number, w: number, height: number,
    color: string, dpr: number): void {
    const s = this.sample!;
    const { from, to } = this;
    const y = (v: number) => ((1 - v) * height) / 2;
    const perPixel = (to - from) / w;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    if (perPixel >= 1) {
      for (let px = 0; px < w; px++) {
        const a = Math.floor(from + px * perPixel);
        const b = Math.max(a + 1, Math.floor(from + (px + 1) * perPixel));
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = a; i < b && i < s.data.length; i++) {
          lo = Math.min(lo, s.data[i]);
          hi = Math.max(hi, s.data[i]);
        }
        if (lo <= hi) {
          ctx.fillRect(px, y(hi), 1, Math.max(1, y(lo) - y(hi)));
        }
      }
      return;
    }
    const first = Math.max(0, Math.floor(from) - 1);
    const last = Math.min(s.data.length - 1, Math.ceil(to) + 1);
    ctx.lineWidth = 1.5 * dpr;
    ctx.beginPath();
    for (let i = first; i <= last; i++) {
      if (i === first) {
        ctx.moveTo(x(i), y(s.data[i]));
      } else {
        ctx.lineTo(x(i), y(s.data[i]));
      }
    }
    ctx.stroke();
    if (perPixel < 1 / 6) {
      for (let i = first; i <= last; i++) {
        ctx.fillRect(x(i) - 1.5 * dpr, y(s.data[i]) - 1.5 * dpr, 3 * dpr, 3 * dpr);
      }
    }
  }

  private drawOverview(): void {
    const c = this.overview;
    const s = this.sample;
    const shown = !!s && this.zoomed();
    c.style.visibility = shown ? 'visible' : 'hidden'; // keeps its space, so the page doesn't jump when zooming
    if (!s || !shown) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const w = (c.width = Math.max(1, Math.round(c.clientWidth * dpr)));
    const height = (c.height = Math.max(1, Math.round(c.clientHeight * dpr)));
    const ctx = c.getContext('2d')!;
    const css = getComputedStyle(c);
    const n = s.data.length;
    ctx.fillStyle = css.getPropertyValue('--wave-dim').trim();
    for (let px = 0; px < w; px++) {
      const a = Math.floor((px * n) / w);
      const b = Math.max(a + 1, Math.floor(((px + 1) * n) / w));
      let peak = 0;
      for (let i = a; i < b && i < n; i += Math.max(1, Math.floor((b - a) / 64))) {
        peak = Math.max(peak, Math.abs(s.data[i]));
      }
      ctx.fillRect(px, (height * (1 - peak)) / 2, 1, Math.max(1, height * peak));
    }
    ctx.strokeStyle = css.getPropertyValue('--wave-marker').trim();
    ctx.lineWidth = 2 * dpr;
    ctx.strokeRect((this.from / n) * w, dpr, Math.max(3 * dpr, ((this.to - this.from) / n) * w), height - 2 * dpr);
  }
}
