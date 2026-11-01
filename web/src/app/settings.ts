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
  normalize: boolean;
  /** keep a loaded file's rate, or resample it to the nearest of the sampler's rates */
  loadRate: 'keep' | 'sampler';
  /** crossfade loop length in ms, and its shape */
  xfadeMs: number;
  xfadeShape: 'linear' | 'equal';
  ackIntervalMs: number;
  lookaheadMs: number;
  fillerPerBlock: number;
  volume: number;
  polyphony: number;
  view: ViewName;
}

const KEY = 'axs7.settings';
const VERSION = 2;

const DEFAULTS: Settings = {
  version: VERSION, midiIn: null, midiOut: null, channel: 0, slot: 0, slotCount: 6, normalize: true,
  loadRate: 'sampler', xfadeMs: 50, xfadeShape: 'linear', ackIntervalMs: 50, lookaheadMs: 1500, fillerPerBlock: 0, volume: 0.8, polyphony: 16,
  view: 'samples',
};

export function loadSettings(): Settings {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    if ((stored.version ?? 1) < 2) {
      // version 1 saved its default KEEP with any other setting, chosen or not. SAMPLER is the default now.
      delete stored.loadRate;
    }
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
