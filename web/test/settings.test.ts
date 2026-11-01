import { afterEach, describe, expect, test } from 'vitest';
import { loadSettings, saveSettings } from '../src/app/settings';

const storage = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  },
});

describe('settings', () => {
  afterEach(() => storage.clear());

  test('files are converted to a sampler rate on load by default', () => {
    expect(loadSettings().loadRate).toBe('sampler');
  });

  test('the KEEP the first version saved as its default gives way to the new default, other settings stay', () => {
    storage.set('axs7.settings', JSON.stringify({ slot: 6, slotCount: 16, loadRate: 'keep' }));
    expect(loadSettings()).toMatchObject({ loadRate: 'sampler', slot: 6, slotCount: 16, version: 2 });
  });

  test('a KEEP chosen now stays', () => {
    const settings = loadSettings();
    settings.loadRate = 'keep';
    saveSettings(settings);
    expect(loadSettings().loadRate).toBe('keep');
  });
});
