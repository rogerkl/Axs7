import type { AudioEngine } from '../audio/engine';
import type { Player } from '../audio/player';
import type { Store } from '../model/store';
import type { Lcd } from '../ui/lcd';
import type { Actions } from './actions';
import type { MidiController } from './midi';
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
  showView(view: ViewName): void;
  saveSettings(): void;
  /** @param slot 0-5, the sampler slot transfers use */
  setSlot(slot: number): void;
  /** @returns a function that stops listening */
  onSlot(listener: () => void): () => void;
}

export interface View {
  el: HTMLElement;
  dispose(): void;
}
