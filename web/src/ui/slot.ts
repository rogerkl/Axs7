// The sample slot on the sampler that RECEIVE asks for and SEND replaces. It is chosen here, the slot number goes in
// the dump request and in the header of a sent dump. How many slots there are is a setting (6 on a standard X7000,
// more with a memory expansion).

import type { App } from '../app/app';
import { h } from './dom';
import { ParamCell, dataEntry } from './param';

/** A slot cell that follows changes made elsewhere. Call dispose when it goes away. */
export function slotCell(app: App, key: string, className = ''): { cell: ParamCell; dispose: () => void } {
  const cell = new ParamCell({
    key, label: 'SLOT', min: 1, coarse: 1,
    get max() {
      return app.settings.slotCount;
    },
    get: () => app.settings.slot + 1,
    set: (v) => app.setSlot(v - 1),
    detail: () => `OF ${app.settings.slotCount}`,
  }, className);
  return { cell, dispose: app.onSlot(() => cell.refresh()) };
}

/** The panel's slot selector next to RECEIVE and SEND: the slot number with ▲ and ▼ */
export function slotStepper(app: App): HTMLElement {
  const { cell } = slotCell(app, 'panel.slot', 'slot-cell'); // on the panel for good, never disposed
  const step = (steps: number) => () => {
    dataEntry.select(cell); // so the knob carries on from here
    cell.change(steps);
  };
  const value = cell.el.querySelector('.param-value')!;
  value.before(h('button', { class: 'slot-step', 'aria-label': 'Next sampler slot', onClick: step(1) }, '▲'));
  value.after(h('button', { class: 'slot-step', 'aria-label': 'Previous sampler slot', onClick: step(-1) }, '▼'));
  cell.el.title = 'The sample slot on the sampler that RECEIVE gets and SEND replaces';
  return cell.el;
}
