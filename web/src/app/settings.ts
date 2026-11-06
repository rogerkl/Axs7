// Settings kept in the browser between visits

export type ViewName = 'samples' | 'out' | 'lfo' | 'program' | 'midi' | 'bank';

export interface Settings {
  /** of the stored settings, see loadSettings */
  version: number;
  midiIn: string | null;
  midiOut: string | null;
  /** keyboard channel, 0 for omni */
  channel: number;
  /** sampler slot for transfers, from 0 */
  slot: number;
  /** how many sample slots the sampler has: 6 on a standard X7000, more with a memory expansion */
  slotCount: number;
  /** keep a loaded file's rate, or resample it to the nearest of the sampler's rates */
  loadRate: 'keep' | 'sampler';
  /**
   * the bank slot a loaded file goes in, as the sampler loads a disk: LOAD_SLOT_OFF none, LOAD_SLOT_FILE the slot
   * the file was saved from (or the first free one), else the slot, from 1
   */
  loadSlot: number;
  /** the programs a loaded file's keygroups go in: LOAD_ALL_PROGRAMS (the sampler's Pall), one, from 1, or
   * LOAD_NO_PROGRAMS (P**) */
  loadPrograms: number;
  /** the channel the sampler answered a request for parameters on (Akai exclusive), 0-15 */
  paramsChannel: number;
  /** the S700 identifier it answered to */
  paramsId: number;
  /** set START to 0 and END to the most on the sampler while receiving, so the dump has all of the sample, then
   * back */
  wholeSample: boolean;
  ackIntervalMs: number;
  lookaheadMs: number;
  fillerPerBlock: number;
  volume: number;
  polyphony: number;
}

const KEY = 'axs7.settings';

export const LOAD_SLOT_OFF = -1;
export const LOAD_SLOT_FILE = 0;
export const LOAD_ALL_PROGRAMS = 0;
export const LOAD_NO_PROGRAMS = 33;
const VERSION = 2;

const DEFAULTS: Settings = {
  version: VERSION, midiIn: null, midiOut: null, channel: 0, slot: 0, slotCount: 6,
  loadRate: 'sampler', loadSlot: 0, loadPrograms: 0, paramsChannel: 0, paramsId: 0x41, wholeSample: true, ackIntervalMs: 50, lookaheadMs: 1500, fillerPerBlock: 0, volume: 0.8, polyphony: 16,
};

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    if ((stored.version ?? 1) < 2) {
      // version 1 saved its default KEEP with any other setting, chosen or not. SAMPLER is the default now.
      delete stored.loadRate;
    }
    // the page that was open, kept before it started for playing
    delete (stored as { view?: unknown }).view;
    return { ...DEFAULTS, ...stored, version: VERSION };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // not available, the settings just aren't kept
  }
}
