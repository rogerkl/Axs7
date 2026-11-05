// The 61 key keyboard (C1-C6, like the X7000's), with the current program's keygroups drawn above the keys. A
// keygroup's bar is dragged by an end to move LOW or HIGH, or in the middle to move LOW, HIGH and ROOT together.

import { h } from './dom';
import { isBlackKey, noteName } from '../model/notes';
import type { Keygroup, Program } from '../model/types';

export const KEYBOARD_LOW = 36;
export const KEYBOARD_HIGH = 96;
const BLACK_WIDTH = 0.6;
/** How near a bar's end (in px) a drag moves that end, not the whole keygroup */
const BAR_END = 7;

type KeyRange = Pick<Keygroup, 'low' | 'high' | 'root'>;
type BarDrag = 'low' | 'high' | 'move';

interface KeyboardHandlers {
  noteOn(note: number, velocity: number): void;
  noteOff(note: number): void;
  selectKeygroup(id: string): void;
  /** a keygroup's bar dragged to another key range */
  moveKeygroup(id: string, range: Partial<KeyRange>): void;
}

/** What plays of the program, for showing it on the bars */
export interface Listening {
  /** the keygroups that play */
  audible: ReadonlySet<string>;
  soloed: ReadonlySet<string>;
}

export class Keyboard {
  readonly el: HTMLElement;
  private keys = new Map<number, HTMLElement>();
  private keyBed: HTMLElement;
  private band: HTMLElement;
  private whiteCount = 0;
  /** the program shown, for dragging its keygroups */
  private program: Program | null = null;

  constructor(private handlers: KeyboardHandlers) {
    for (let n = KEYBOARD_LOW; n <= KEYBOARD_HIGH; n++) {
      if (!isBlackKey(n)) {
        this.whiteCount++;
      }
    }
    const keyBed = h('div', { class: 'keys' });
    for (let n = KEYBOARD_LOW; n <= KEYBOARD_HIGH; n++) {
      const black = isBlackKey(n);
      const [left, right] = this.span(n);
      const key = h('div', {
        class: black ? 'key black' : 'key white',
        style: `left:${left}%;width:${right - left}%`,
        'data-note': n,
        title: noteName(n),
      }, !black && n % 12 === 0 ? h('span', { class: 'key-name' }, noteName(n)) : null);
      this.keys.set(n, key);
      keyBed.append(key);
    }
    this.keyBed = keyBed;
    this.band = h('div', { class: 'kg-band', 'aria-label': 'Keygroups' });
    this.el = h('div', { class: 'keyboard' }, this.band, keyBed);
    this.play(keyBed);
    this.dragBars();
  }

  /**
   * The key at a point across the keyboard, a black one where it is over one. Past the ends, the keys there would
   * be, so a keygroup can be dragged beyond the 61 keys.
   */
  private noteAt(clientX: number): number {
    const r = this.keyBed.getBoundingClientRect();
    const at = ((clientX - r.left) / r.width) * 100;
    const semitone = ((100 / this.whiteCount) * 7) / 12;
    if (at < 0) {
      return Math.max(0, KEYBOARD_LOW - Math.ceil(-at / semitone));
    }
    if (at >= 100) {
      return Math.min(127, KEYBOARD_HIGH + Math.ceil((at - 100) / semitone));
    }
    let white = KEYBOARD_LOW;
    for (let n = KEYBOARD_LOW; n <= KEYBOARD_HIGH; n++) {
      const [left, right] = this.span(n);
      if (at >= left && at < right) {
        if (isBlackKey(n)) {
          return n;
        }
        white = n;
      }
    }
    return white;
  }

  /** Which part of a bar is at a point: an end that can be moved, or the middle */
  private barPart(bar: HTMLElement, kg: Keygroup, clientX: number): BarDrag {
    const r = bar.getBoundingClientRect();
    const end = Math.min(BAR_END, r.width / 3);
    // an end cut off at the edge of the keyboard isn't the keygroup's end
    if (clientX - r.left <= end && kg.low >= KEYBOARD_LOW) {
      return 'low';
    }
    if (r.right - clientX <= end && kg.high <= KEYBOARD_HIGH) {
      return 'high';
    }
    return 'move';
  }

  /** Dragging bars: on the band, as the bars are drawn again while their keygroup changes */
  private dragBars(): void {
    let drag: { id: string; part: BarDrag; from: number; was: KeyRange } | null = null;
    const barOf = (e: PointerEvent) => {
      const bar = (e.target as HTMLElement).closest<HTMLElement>('.kg-bar');
      const kg = bar && this.program?.keygroups.find((k) => k.id === bar.dataset.id);
      return bar && kg ? { bar, kg } : null;
    };
    this.band.addEventListener('pointerdown', (e) => {
      const hit = e.button === 0 ? barOf(e) : null;
      if (!hit) {
        return;
      }
      e.preventDefault();
      this.band.setPointerCapture(e.pointerId);
      const { low, high, root } = hit.kg;
      drag = { id: hit.kg.id, part: this.barPart(hit.bar, hit.kg, e.clientX), from: this.noteAt(e.clientX),
        was: { low, high, root } };
      this.band.dataset.drag = drag.part;
      this.handlers.selectKeygroup(hit.kg.id);
    });
    this.band.addEventListener('pointermove', (e) => {
      if (!drag) {
        const hit = barOf(e);
        if (hit) {
          hit.bar.style.cursor = this.barPart(hit.bar, hit.kg, e.clientX) === 'move' ? 'grab' : 'ew-resize';
        }
        return;
      }
      const moved = this.noteAt(e.clientX) - drag.from;
      const { low, high, root } = drag.was;
      const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
      let range: Partial<KeyRange>;
      if (drag.part === 'low') {
        range = { low: clamp(low + moved, 0, high) };
      } else if (drag.part === 'high') {
        range = { high: clamp(high + moved, low, 127) };
      } else {
        // all three together, as far as they all stay on MIDI notes
        const by = clamp(moved, -Math.min(low, root), 127 - Math.max(high, root));
        range = { low: low + by, high: high + by, root: root + by };
      }
      const now = this.program?.keygroups.find((k) => k.id === drag!.id);
      if (now && (Object.keys(range) as (keyof KeyRange)[]).some((k) => now[k] !== range[k])) {
        this.handlers.moveKeygroup(drag.id, range);
      }
    });
    const end = (e: PointerEvent) => {
      if (drag) {
        drag = null;
        delete this.band.dataset.drag;
        if (this.band.hasPointerCapture(e.pointerId)) {
          this.band.releasePointerCapture(e.pointerId);
        }
      }
    };
    this.band.addEventListener('pointerup', end);
    this.band.addEventListener('pointercancel', end);
  }

  /** Left and right edge of a key, in percent of the keyboard's width */
  private span(note: number): [number, number] {
    let whites = 0;
    for (let n = KEYBOARD_LOW; n < note; n++) {
      if (!isBlackKey(n)) {
        whites++;
      }
    }
    const w = 100 / this.whiteCount;
    if (isBlackKey(note)) {
      return [whites * w - (BLACK_WIDTH * w) / 2, whites * w + (BLACK_WIDTH * w) / 2];
    }
    return [whites * w, (whites + 1) * w];
  }

  private play(keyBed: HTMLElement): void {
    let current: number | null = null;
    const noteAt = (e: PointerEvent): [number, number] | null => {
      const el = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('.key');
      if (!el || !keyBed.contains(el)) {
        return null;
      }
      // further down the key is louder, like playing it harder
      const r = el.getBoundingClientRect();
      const depth = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
      return [Number(el.dataset.note), Math.round(40 + 87 * depth)];
    };
    const release = () => {
      if (current !== null) {
        this.handlers.noteOff(current);
        current = null;
      }
    };
    keyBed.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      keyBed.setPointerCapture(e.pointerId);
      const hit = noteAt(e);
      if (hit) {
        current = hit[0];
        this.handlers.noteOn(hit[0], hit[1]);
      }
    });
    keyBed.addEventListener('pointermove', (e) => {
      if (current === null) {
        return;
      }
      const hit = noteAt(e);
      if (hit && hit[0] !== current) {
        release();
        current = hit[0];
        this.handlers.noteOn(hit[0], hit[1]);
      }
    });
    keyBed.addEventListener('pointerup', release);
    keyBed.addEventListener('pointercancel', release);
  }

  setDown(down: ReadonlySet<number>): void {
    for (const [note, key] of this.keys) {
      key.classList.toggle('down', down.has(note));
    }
  }

  /** Draws the keygroups as bars over their key ranges, in lanes where they overlap */
  setKeygroups(program: Program, selectedId: string | null, sampleNames: Map<string, string>,
    listening: Listening): void {
    this.program = program;
    const lanes: number[] = [];
    const bars: HTMLElement[] = [];
    const sorted = [...program.keygroups].sort((a, b) => a.low - b.low);
    for (const kg of sorted) {
      let lane = lanes.findIndex((end) => end < kg.low);
      if (lane < 0) {
        lane = lanes.length;
      }
      lanes[lane] = kg.high;
      const low = Math.max(kg.low, KEYBOARD_LOW);
      const high = Math.min(kg.high, KEYBOARD_HIGH);
      if (low > high) {
        continue; // outside the keyboard
      }
      const left = this.span(low)[0];
      const right = this.span(high)[1];
      const name = kg.sampleId ? sampleNames.get(kg.sampleId) ?? '?' : 'NO SAMPLE';
      const root = kg.root >= KEYBOARD_LOW && kg.root <= KEYBOARD_HIGH
        ? h('span', { class: 'kg-root', style: `left:${((this.span(kg.root)[0] + this.span(kg.root)[1]) / 2 - left)
          / (right - left) * 100}%` }) : null;
      const solo = listening.soloed.has(kg.id);
      const silent = !listening.audible.has(kg.id);
      const bar = h('button', {
        class: `kg-bar${kg.id === selectedId ? ' selected' : ''}${kg.sampleId ? '' : ' empty'}`
          + `${kg.low < KEYBOARD_LOW ? ' cut-left' : ''}${kg.high > KEYBOARD_HIGH ? ' cut-right' : ''}`
          + `${solo ? ' solo' : ''}${silent ? ' silent' : ''}`,
        style: `left:${left}%;width:${right - left}%;top:${lane * 15}px`,
        'data-id': kg.id,
        title: `${name}: ${noteName(kg.low)}–${noteName(kg.high)}, root ${noteName(kg.root)}`
          + `${solo ? ', solo' : silent ? ', not playing (muted, or others soloed)' : ''}. Drag an end to move LOW `
          + 'or HIGH, the middle to move the keygroup',
        onClick: () => this.handlers.selectKeygroup(kg.id),
      }, root, h('span', { class: 'kg-name' }, `${solo ? 'S ' : ''}${name}`));
      bars.push(bar);
    }
    this.band.style.height = `${Math.max(1, lanes.length) * 15 + 3}px`;
    this.band.replaceChildren(...bars);
  }
}
