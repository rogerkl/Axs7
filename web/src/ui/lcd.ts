// The green two line display. Line 1 shows the status (program, voices), line 2 the selected parameter, or a
// message for a while, or the progress of a transfer while it runs.

import { h } from './dom';

export const LCD_WIDTH = 24;

export class Lcd {
  readonly el: HTMLElement;
  private lines: HTMLElement[];
  private message: string | null = null;
  private held: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** what the display shows when nothing else */
  status: () => [string, string] = () => ['', ''];

  constructor() {
    this.lines = [h('div', { class: 'lcd-line' }), h('div', { class: 'lcd-line' })];
    this.el = h('div', { class: 'lcd', role: 'status', 'aria-live': 'polite' }, ...this.lines);
  }

  static fit(text: string): string {
    return text.toUpperCase().slice(0, LCD_WIDTH).padEnd(LCD_WIDTH);
  }

  /** Text at the left, value at the right of a line */
  static pair(label: string, value: string): string {
    const v = value.toUpperCase();
    return label.toUpperCase().slice(0, LCD_WIDTH - v.length - 1).padEnd(LCD_WIDTH - v.length) + v;
  }

  render(): void {
    const [line1, line2] = this.status();
    this.lines[0].textContent = Lcd.fit(line1);
    this.lines[1].textContent = Lcd.fit(this.held ?? this.message ?? line2);
  }

  /** Shows a message on line 2 for a while */
  flash(text: string, ms = 2000): void {
    this.message = text;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.message = null;
      this.render();
    }, ms);
    this.render();
  }

  /** Ends a message from flash() early */
  clearMessage(): void {
    clearTimeout(this.timer);
    this.message = null;
    this.render();
  }

  /** Shows text on line 2 until released, for progress */
  hold(text: string): void {
    this.held = text;
    this.render();
  }

  release(): void {
    this.held = null;
    this.render();
  }
}
