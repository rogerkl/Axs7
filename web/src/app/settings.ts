// Settings kept in the browser between visits

export type ViewName = 'samples' | 'keygroups' | 'filter' | 'amp' | 'midi' | 'bank';

export interface Settings {
  midiIn: string | null;
  midiOut: string | null;
  /** keyboard channel, 0 for omni */
  channel: number;
  /** sampler slot for transfers, from 0 */
  slot: number;
  /** how many sample slots the sampler has: 6 on a standard X7000, more with a memory expansion */
  slotCount: number;
  normalize: boolean;
  /** keep a loaded file's rate, or resample it to the nearest of the sampler's rates */
  loadRate: 'keep' | 'sampler';
  ackIntervalMs: number;
  lookaheadMs: number;
  fillerPerBlock: number;
  volume: number;
  polyphony: number;
  view: ViewName;
}

const KEY = 'axs7.settings';

const DEFAULTS: Settings = {
  midiIn: null, midiOut: null, channel: 0, slot: 0, slotCount: 6, normalize: true, loadRate: 'keep', ackIntervalMs: 50, lookaheadMs: 1500,
  fillerPerBlock: 0, volume: 0.8, polyphony: 16, view: 'samples',
};

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
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
