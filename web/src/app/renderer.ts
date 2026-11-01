// Keeps every sample's rendered audio in step with its original, recipe and points: when what it depends on
// changes, it is rendered again from the original. Renders of a sample don't overlap, and a burst of changes (a
// point dragged) renders once it settles a little.

import { resampleInBrowser } from '../audio/decode';
import { getDsp } from '../audio/dsp';
import type { Resampler } from '../model/convert';
import { renderKey } from '../model/recipe';
import { renderSample } from '../model/render';
import type { Rendered } from '../model/render';
import type { Store } from '../model/store';
import type { Sample } from '../model/types';

const SETTLE_MS = 30;

export class Renderer {
  /** the render key each sample's current audio was rendered with */
  private keys = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = new Set<string>();
  private again = new Set<string>();
  /** the last resampling of each sample's original, it is slow and points move more often than rates */
  private resampled = new Map<string, { source: Float32Array; to: number; data: Float32Array }>();

  constructor(private store: Store, private onError: (message: string) => void) {
    store.on('samples', () => {
      for (const id of store.samples.keys()) {
        this.check(id);
      }
    });
    store.on('sample', (id) => id && this.check(id));
  }

  /** Takes the samples' audio as rendered by their current settings, as when they come from storage or a bank */
  adopt(samples: Iterable<Sample>): void {
    for (const s of samples) {
      this.keys.set(s.id, renderKey(s));
    }
  }

  /** Renders a sample that isn't in the store yet */
  render(sample: Sample): Promise<Rendered> {
    return this.renderOne(sample);
  }

  private async renderOne(sample: Sample): Promise<Rendered> {
    const resample: Resampler = async (data, from, to) => {
      const cached = this.resampled.get(sample.id);
      if (cached?.source === data && cached.to === to) {
        return cached.data;
      }
      const out = await resampleInBrowser(data, from, to);
      this.resampled.set(sample.id, { source: data, to, data: out });
      return out;
    };
    return renderSample(sample, resample, await getDsp());
  }

  private check(id: string): void {
    const s = this.store.samples.get(id);
    if (s && renderKey(s) !== this.keys.get(id)) {
      clearTimeout(this.timers.get(id));
      this.timers.set(id, setTimeout(() => this.run(id), SETTLE_MS));
    }
  }

  private async run(id: string): Promise<void> {
    if (this.running.has(id)) {
      this.again.add(id);
      return;
    }
    this.running.add(id);
    try {
      const s = this.store.samples.get(id);
      if (s) {
        const key = renderKey(s);
        const rendered = await this.renderOne(s);
        if (this.store.samples.get(id) !== s) {
          return; // removed meanwhile
        }
        if (renderKey(s) !== key) {
          this.again.add(id); // changed meanwhile: this render would put back the points as they were
          return;
        }
        this.store.setRendered(id, rendered);
        this.keys.set(id, renderKey(s));
      }
    } catch (e) {
      this.onError(`Could not render ${this.store.samples.get(id)?.name}: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.running.delete(id);
      if (this.again.delete(id)) {
        this.check(id);
      }
    }
  }
}
