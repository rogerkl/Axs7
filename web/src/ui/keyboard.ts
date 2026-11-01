// The 61 key keyboard (C1-C6, like the X7000's), with the current program's keygroups drawn above the keys.

import { h } from './dom';
import { isBlackKey, noteName } from '../model/notes';
import type { Program } from '../model/types';

export const KEYBOARD_LOW = 36;
export const KEYBOARD_HIGH = 96;
const BLACK_WIDTH = 0.6;

interface KeyboardHandlers {
  noteOn(note: number, velocity: number): void;
  noteOff(note: number): void;
  selectKeygroup(id: string): void;
}

export class Keyboard {
  readonly el: HTMLElement;
  private keys = new Map<number, HTMLElement>();
  private band: HTMLElement;
  private whiteCount = 0;

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
    this.band = h('div', { class: 'kg-band', 'aria-label': 'Keygroups' });
    this.el = h('div', { class: 'keyboard' }, this.band, keyBed);
    this.play(keyBed);
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
  setKeygroups(program: Program, selectedId: string | null, sampleNames: Map<string, string>): void {
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
      const bar = h('button', {
        class: `kg-bar${kg.id === selectedId ? ' selected' : ''}${kg.sampleId ? '' : ' empty'}`
          + `${kg.low < KEYBOARD_LOW ? ' cut-left' : ''}${kg.high > KEYBOARD_HIGH ? ' cut-right' : ''}`,
        style: `left:${left}%;width:${right - left}%;top:${lane * 15}px`,
        title: `${name}: ${noteName(kg.low)}–${noteName(kg.high)}, root ${noteName(kg.root)}`,
        onClick: () => this.handlers.selectKeygroup(kg.id),
      }, root, h('span', { class: 'kg-name' }, name));
      bars.push(bar);
    }
    this.band.style.height = `${Math.max(1, lanes.length) * 15 + 3}px`;
    this.band.replaceChildren(...bars);
  }
}
