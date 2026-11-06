// Parameters edited like on the sampler: select one, then turn the data knob. A cell also changes with the
// mouse wheel, by dragging up and down, with the arrow keys while selected, and a double click types a value.

import { h } from './dom';

export interface ParamSpec {
  /** stays the same when the view is rebuilt, so the selection survives */
  key: string;
  label: string;
  min: number;
  max: number;
  get(): number;
  set(value: number): void;
  format?(value: number): string;
  /** more about the value for the LCD, like the time or frequency it stands for */
  detail?(value: number): string;
  parse?(text: string): number | null;
  /** steps for coarse changes (shift), by default a twentieth of the range */
  coarse?: number;
  /**
   * the value is a note, which can also be set by playing it once the cell is selected, like on the sampler: one
   * note, then the cell only takes the knob and the like, until it is selected again
   */
  noteInput?: boolean;
  /** the key of the cell to select after a played note has set this one, like LOW moving on to HIGH */
  noteNext?: string;
}

class DataEntry {
  cell: ParamCell | null = null;
  /** the selected cell takes a played note: it takes notes and hasn't had one since it was selected */
  listening = false;
  private key: string | null = null;
  /** the cells by key, to find where a played note moves on to */
  private cells = new Map<string, WeakRef<ParamCell>>();
  onChange: (cell: ParamCell | null) => void = () => {};

  select(cell: ParamCell | null): void {
    this.cell?.el.classList.remove('selected', 'listening');
    this.cell = cell;
    this.key = cell?.spec.key ?? null;
    this.listening = cell?.spec.noteInput === true;
    cell?.el.classList.add('selected');
    cell?.el.classList.toggle('listening', this.listening);
    this.onChange(cell);
  }

  /** Called by a new cell, takes over the selection from a cell with the same key that was rebuilt */
  adopt(cell: ParamCell): void {
    this.cells.set(cell.spec.key, new WeakRef(cell));
    if (cell.spec.key === this.key) {
      this.cell = cell;
      cell.el.classList.add('selected');
      cell.el.classList.toggle('listening', this.listening);
    }
  }

  nudge(steps: number, coarse = false): void {
    if (this.cell?.el.isConnected) {
      this.cell.change(steps, coarse);
    }
  }

  /**
   * A played note: sets the selected cell if it is listening for one, and moves on to the next cell if it has one.
   * Without one, the cell stops listening, so playing on doesn't change it again.
   */
  note(note: number): void {
    const cell = this.cell;
    if (!this.listening || !cell?.el.isConnected || !cell.spec.noteInput) {
      return;
    }
    this.listening = false;
    cell.el.classList.remove('listening');
    cell.setValue(note); // may build the cell again, which takes over the selection
    const next = cell.spec.noteNext ? this.cells.get(cell.spec.noteNext)?.deref() : undefined;
    if (next?.el.isConnected) {
      this.select(next);
    } else if (this.cell) {
      this.onChange(this.cell);
    }
  }

  changed(cell: ParamCell): void {
    if (cell === this.cell) {
      this.onChange(cell);
    }
  }
}

export const dataEntry = new DataEntry();

export class ParamCell {
  readonly el: HTMLElement;
  private value: HTMLElement;

  constructor(readonly spec: ParamSpec, className = '') {
    this.value = h('div', { class: 'param-value' });
    this.el = h('div', { class: `param ${className}${spec.noteInput ? ' note-input' : ''}`,
      title: `Select, then turn the data knob, scroll, drag or use the arrow keys${spec.noteInput
        ? ', or play the note' : ''}. Double click to type.` },
    h('div', { class: 'param-label' }, spec.label), this.value);
    this.el.addEventListener('pointerdown', this.onPointerDown);
    this.el.addEventListener('wheel', this.onWheel, { passive: false });
    this.el.addEventListener('dblclick', () => this.edit());
    this.refresh();
    dataEntry.adopt(this);
  }

  text(): string {
    const v = this.spec.get();
    return this.spec.format ? this.spec.format(v) : String(v);
  }

  refresh(): void {
    this.value.textContent = this.text();
  }

  change(steps: number, coarse = false): void {
    const { min, max } = this.spec;
    const step = coarse ? this.spec.coarse ?? Math.max(1, Math.round((max - min) / 20)) : 1;
    this.setValue(this.spec.get() + steps * step);
  }

  setValue(v: number): void {
    const value = Math.max(this.spec.min, Math.min(this.spec.max, Math.round(v)));
    if (value !== this.spec.get()) {
      this.spec.set(value);
      this.refresh();
      dataEntry.changed(this);
    }
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || (e.target as Element).closest('input, button')) {
      return;
    }
    dataEntry.select(this);
    const startY = e.clientY;
    const start = this.spec.get();
    const scale = Math.max(1, Math.round((this.spec.max - this.spec.min) / 256));
    this.el.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => this.setValue(start + Math.round((startY - m.clientY) / 3) * scale);
    const up = () => {
      this.el.removeEventListener('pointermove', move);
      this.el.removeEventListener('pointerup', up);
      this.el.removeEventListener('pointercancel', up);
    };
    this.el.addEventListener('pointermove', move);
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    dataEntry.select(this);
    this.change(e.deltaY < 0 ? 1 : -1, e.shiftKey);
  };

  private edit(): void {
    const input = h('input', { class: 'param-input', value: this.text() });
    let finished = false;
    const finish = (apply: boolean) => {
      if (finished) {
        return; // removing the focused input fires blur, which comes here again
      }
      finished = true;
      if (apply) {
        const parsed = this.spec.parse ? this.spec.parse(input.value) : Number(input.value);
        if (parsed !== null && Number.isFinite(parsed)) {
          this.setValue(parsed);
        }
      }
      input.replaceWith(this.value);
      this.refresh();
    };
    input.addEventListener('keydown', (k) => {
      if (k.key === 'Enter') {
        finish(true);
      } else if (k.key === 'Escape') {
        finish(false);
      }
      k.stopPropagation();
    });
    input.addEventListener('blur', () => finish(true));
    this.value.replaceWith(input);
    input.select();
  }
}

/** A cell that steps through named choices */
export function choiceCell<T extends string>(key: string, label: string, choices: readonly T[], names: string[],
  get: () => T, set: (v: T) => void, className = ''): ParamCell {
  return new ParamCell({
    key, label, min: 0, max: choices.length - 1, coarse: 1,
    get: () => Math.max(0, choices.indexOf(get())),
    set: (i) => set(choices[i]),
    format: (i) => names[i],
    parse: (text) => {
      const i = names.findIndex((n) => n.toLowerCase() === text.trim().toLowerCase());
      return i >= 0 ? i : null;
    },
  }, className);
}
