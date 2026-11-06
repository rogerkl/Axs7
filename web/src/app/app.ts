import type { AudioEngine } from '../audio/engine';
import type { Player } from '../audio/player';
import type { Store } from '../model/store';
import type { Lcd } from '../ui/lcd';
import type { Actions } from './actions';
import type { MidiController } from './midi';
import type { Renderer } from './renderer';
import type { Settings, ViewName } from './settings';

/** What the views and actions share */
export interface App {
  store: Store;
  engine: AudioEngine;
  player: Player;
  lcd: Lcd;
  settings: Settings;
  midi: MidiController;
  actions: Actions;
  renderer: Renderer;
  /** the page open, null when none is, for only playing */
  readonly view: ViewName | null;
  /** @param view null to close the page */
  showView(view: ViewName | null): void;
  saveSettings(): void;
  /** @param slot from 0, the sampler slot transfers use */
  setSlot(slot: number): void;
  /** How many slots the sampler has, the slot is kept within them */
  setSlotCount(count: number): void;
  /** @returns a function that stops listening */
  onSlot(listener: () => void): () => void;
}

export interface View {
  el: HTMLElement;
  dispose(): void;
}
