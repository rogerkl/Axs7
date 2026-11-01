// What the panel buttons do: load files, transfers with the sampler, banks.

import { decodeAudioFile, resampleInBrowser } from '../audio/decode';
import { bankToZip, zipToBank } from '../model/bank';
import { dumpFromSample, sampleFromDump, sampleFromWav, wavLoops } from '../model/convert';
import { defaultSound, newId } from '../model/mapping';
import { plainRecipe } from '../model/recipe';
import type { Sample } from '../model/types';
import { receiveDump, transmitDump } from '../midi/transfer';
import { readWav, encodeWav } from '../protocol/wav';
import { nearestBandwidth, samplerBandwidth } from '../protocol/akai';
import { download } from '../ui/dom';
import type { App } from './app';

/** Not a MIDI note, so auditioning doesn't collide with played notes */
const AUDITION_KEY = 200;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Actions {
  busy: 'receive' | 'send' | null = null;
  private abort: AbortController | null = null;
  /** when the ACKs scheduled by the last receive have gone out */
  private acksUntil = 0;
  onBusy: () => void = () => {};

  constructor(private app: App) {}

  private setBusy(busy: Actions['busy']): void {
    this.busy = busy;
    this.onBusy();
  }

  /**
   * Loads audio files as samples. The file is kept as the original; what is loaded starts out normalized, and at
   * the nearest of the sampler's rates with RATE ON LOAD = SAMPLER, as edits that can be changed. A wav file saved
   * from a sample that came from the sampler is marked as such again, and isn't edited.
   */
  async loadFiles(files: File[]): Promise<void> {
    const { store, lcd, renderer } = this.app;
    let loaded = 0;
    for (const file of files) {
      const name = store.uniqueSampleName(file.name.replace(/\.[^.]+$/, ''));
      try {
        const buffer = await file.arrayBuffer();
        const wav = readWav(buffer);
        let sample: Sample;
        if (wav) {
          sample = sampleFromWav(wav, name);
        } else {
          const { rate, data } = await decodeAudioFile(buffer);
          sample = { id: newId(), name, source: data, sourceRate: rate, recipe: plainRecipe(), fromSampler: false,
            rate, data, start: 0, end: data.length, loopStart: 0, loopEnd: data.length, loopMode: 'off',
            reverse: false, sound: defaultSound() };
        }
        if (!sample.fromSampler) {
          sample.recipe.normalize = true;
          if (this.app.settings.loadRate === 'sampler' && !samplerBandwidth(sample.sourceRate)) {
            sample.recipe.resampleTo = nearestBandwidth(sample.sourceRate).rate;
          }
          Object.assign(sample, await renderer.render(sample));
        }
        renderer.adopt([sample]);
        store.addSample(sample);
        loaded++;
      } catch (e) {
        this.app.midi.logLine(`Could not load ${file.name}: ${errorText(e)}`, 'error');
        lcd.flash(`CAN'T LOAD ${file.name}`);
      }
    }
    if (loaded > 0) {
      lcd.flash(loaded === 1 ? `LOADED ${store.selectedSample?.name}` : `LOADED ${loaded} SAMPLES`);
    }
  }

  /** Back to the original, without edits */
  resetEdits(sample: Sample): void {
    this.app.store.updateRecipe(sample.id, plainRecipe());
    this.app.lcd.flash('EDITS OFF');
  }

  /** Stops waiting for a transfer. A sent dump can't be called back, it is with the MIDI driver. */
  cancel(): void {
    this.abort?.abort();
  }

  private midiReady(): boolean {
    if (this.app.midi.ready) {
      return true;
    }
    this.app.lcd.flash('SELECT MIDI PORTS FIRST');
    this.app.showView('midi');
    return false;
  }

  /** The ACKs a receive scheduled ahead can't be called back, the next transfer waits for them */
  private async waitForAcks(): Promise<void> {
    const wait = this.acksUntil + 50 - performance.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }

  async receive(): Promise<void> {
    if (this.busy === 'receive') {
      this.cancel();
      return;
    }
    if (this.busy || !this.midiReady()) {
      return;
    }
    const { store, lcd, settings, midi } = this.app;
    const slot = settings.slot;
    this.setBusy('receive');
    this.abort = new AbortController();
    try {
      lcd.hold(`RECEIVING SLOT ${slot + 1}`);
      await this.waitForAcks();
      const r = await receiveDump(midi.link!, slot, {
        ackIntervalMs: settings.ackIntervalMs,
        lookaheadMs: settings.lookaheadMs,
        signal: this.abort.signal,
        onProgress: (p) => lcd.hold(`RECEIVING SLOT ${slot + 1} ${(p.elapsedMs / 1000).toFixed(0).padStart(2)}S`),
      });
      this.acksUntil = r.timing.lastAckAt;
      midi.logLine(`Received ${r.length} bytes from slot ${slot + 1} in ${r.timing.seconds.toFixed(1)} s: `
        + `${r.blocks ?? 0} of ${r.expectedBlocks ?? '?'} blocks, ${r.checksumErrors ?? 0} checksum errors`);
      for (const p of r.problems) {
        midi.logLine(p, 'warn');
      }
      if (!r.header || !r.blocks) {
        lcd.release();
        lcd.flash('RECEIVE FAILED, SEE MIDI');
        return;
      }
      const sample = sampleFromDump(r, store.uniqueSampleName(`SLOT ${slot + 1}`));
      store.addSample(sample);
      lcd.release();
      lcd.flash(r.ok ? `RECEIVED ${sample.name}` : 'RECEIVED WITH ERRORS');
    } catch (e) {
      const timing = (e as { timing?: { lastAckAt: number } }).timing;
      if (timing) {
        this.acksUntil = timing.lastAckAt;
      }
      lcd.release();
      if ((e as Error).name === 'AbortError') {
        lcd.flash('RECEIVE CANCELLED');
      } else {
        midi.logLine(`Receive failed: ${errorText(e)}`, 'error');
        lcd.flash('RECEIVE FAILED, SEE MIDI');
      }
    } finally {
      this.abort = null;
      this.setBusy(null);
    }
  }

  async send(): Promise<void> {
    if (this.busy === 'send') {
      this.cancel();
      return;
    }
    const { store, lcd, settings, midi } = this.app;
    const sample = store.selectedSample;
    if (this.busy) {
      return;
    }
    if (!sample) {
      lcd.flash('NO SAMPLE SELECTED');
      return;
    }
    if (!this.midiReady()) {
      return;
    }
    const slot = settings.slot;
    this.setBusy('send');
    this.abort = new AbortController();
    try {
      lcd.hold(`PREPARING ${sample.name}`);
      const { dump, notes } = await dumpFromSample(sample,
        { slot, filler: { fillerPerBlock: settings.fillerPerBlock } }, resampleInBrowser);
      for (const note of notes) {
        midi.logLine(`${sample.name}: ${note}`);
      }
      await this.waitForAcks();
      const r = await transmitDump(midi.link!, dump, {
        signal: this.abort.signal,
        onProgress: (p) => lcd.hold(`SENDING SLOT ${slot + 1} ${Math.min(99, Math.round(p.elapsedMs / p.wireMs * 100))
          .toString().padStart(2)}%`),
      });
      midi.logLine(`Sent ${sample.name} to slot ${slot + 1}: ${r.bytes} bytes, ${r.numBlocks} blocks, `
        + `${r.replies} replies from the sampler`);
      lcd.release();
      if (r.cancelled) {
        lcd.flash('STOPPED WAITING');
      } else {
        lcd.flash(r.replies >= r.numBlocks ? `SENT TO SLOT ${slot + 1}` : `SENT, ${r.replies}/${r.numBlocks} ACKS`);
      }
    } catch (e) {
      lcd.release();
      midi.logLine(`Send failed: ${errorText(e)}`, 'error');
      lcd.flash('SEND FAILED, SEE MIDI');
    } finally {
      this.abort = null;
      this.setBusy(null);
    }
  }

  /** Plays a sample at its own pitch, with its sound */
  auditionStart(sample: Sample | null): void {
    if (!sample) {
      this.app.lcd.flash('NO SAMPLE SELECTED');
      return;
    }
    const { engine } = this.app;
    void engine.start();
    engine.noteOff(AUDITION_KEY);
    engine.noteOn(AUDITION_KEY, 1, [{ sample, ratio: 1, gain: 1 }]);
  }

  auditionStop(): void {
    this.app.engine.noteOff(AUDITION_KEY);
  }

  /** The sample as it plays, with its loop, and marked if it came from the sampler */
  saveWav(sample: Sample): void {
    download(encodeWav(sample.data, sample.rate, wavLoops(sample), sample.fromSampler ? { fromSampler: true } : undefined),
      `${sample.name}.wav`, 'audio/wav');
  }

  saveBank(): void {
    const { store, lcd } = this.app;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    download(bankToZip({ samples: [...store.samples.values()], programs: store.programs,
      programIndex: store.programIndex }), `axs7-bank-${stamp}.zip`, 'application/zip');
    lcd.flash('BANK SAVED');
  }

  async loadBank(file: File): Promise<void> {
    const { store, lcd } = this.app;
    try {
      const bank = zipToBank(new Uint8Array(await file.arrayBuffer()));
      this.app.renderer.adopt(bank.samples); // they come rendered
      if (store.samples.size > 0 && !confirm(`Load ${file.name}? It replaces the samples and programs in memory.`)) {
        return;
      }
      this.app.player.allNotesOff(true);
      store.replaceAll(bank.samples, bank.programs, bank.programIndex);
      lcd.flash(`LOADED ${bank.samples.length} SAMPLES`);
    } catch (e) {
      this.app.midi.logLine(`Could not load ${file.name}: ${errorText(e)}`, 'error');
      lcd.flash('NOT A BANK FILE');
    }
  }

  clearMemory(): void {
    const { store, lcd, player } = this.app;
    if (confirm('Clear all samples and programs from memory? Save a bank first to keep them.')) {
      player.allNotesOff(true);
      store.replaceAll([], []);
      lcd.flash('MEMORY CLEARED');
    }
  }
}
