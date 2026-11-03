// What the panel buttons do: load files, transfers with the sampler, banks.

import { decodeAudioFile, resampleInBrowser } from '../audio/decode';
import { bankToZip, zipToBank } from '../model/bank';
import { S612_KEYGROUP, diskFromSample, sampleFromDisk } from '../model/disk';
import { dumpFromSample, sampleFromDump, sampleFromWav, wavLoops } from '../model/convert';
import { defaultSound, newId } from '../model/mapping';
import { plainRecipe } from '../model/recipe';
import type { Sample } from '../model/types';
import { receiveDump, requestSampleParams, transmitDump } from '../midi/transfer';
import { sampleFromDumpWithParams } from '../model/s700';
import { readWav, encodeWav } from '../protocol/wav';
import { isQdImage } from '../protocol/qd';
import { hex, nearestBandwidth, samplerBandwidth } from '../protocol/akai';
import { S700_SCAN, bandwidthRate } from '../protocol/s700disk';
import type { S700SampleParams } from '../protocol/s700disk';
import { sampleParamsRequest } from '../protocol/sprm';
import { noteName } from '../model/notes';
import { download } from '../ui/dom';
import type { App } from './app';

/** Not a MIDI note, so auditioning doesn't collide with played notes */
const AUDITION_KEY = 200;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Actions {
  busy: 'receive' | 'send' | 'params' | null = null;
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
   *
   * An S700/X7000 disk image (.qd) brings its sample as the sampler has it, with its sound, and its keygroups in the
   * programs it was in on the sampler. An S612 disk's sample loads as a file does, in a program of its own.
   */
  async loadFiles(files: File[]): Promise<void> {
    const { store, lcd, renderer } = this.app;
    let loaded = 0;
    for (const file of files) {
      const name = store.uniqueSampleName(file.name.replace(/\.[^.]+$/, ''));
      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const disk = isQdImage(bytes) ? sampleFromDisk(bytes, name) : null;
        for (const note of disk?.notes ?? []) {
          this.app.midi.logLine(`${file.name}: ${note}`, 'warn');
        }
        if (disk?.format === 'S700') {
          renderer.adopt([disk.sample]); // as it is, nothing to render
          store.addSampleToPrograms(disk.sample, disk.programs);
          loaded++;
          continue;
        }
        const wav = disk ? null : readWav(buffer);
        let sample: Sample;
        if (disk) {
          sample = disk.sample; // an S612's, at its own rate: loaded as a file is
        } else if (wav) {
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
        if (disk) {
          // the S612 has no programs: the X7000 gives its sample a program of its own
          store.addSampleToOwnProgram(sample, S612_KEYGROUP);
        } else {
          store.addSample(sample);
        }
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

  /**
   * Receives the slot's sample. The sampler is asked for the slot's parameters first, on the channel REQUEST
   * PARAMETERS found: with them the sample comes with its points, scan mode, rate and sound, and its keygroups in the
   * programs it is in on the sampler. Without a reply it comes as the dump has it.
   */
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
      const params = await this.slotParams(slot, this.abort.signal);
      const r = await receiveDump(midi.link!, slot, {
        ackIntervalMs: settings.ackIntervalMs,
        lookaheadMs: settings.lookaheadMs,
        signal: this.abort.signal,
        onProgress: (p) => lcd.hold(`RECEIVING SLOT ${slot + 1} ${(p.elapsedMs / 1000).toFixed(0).padStart(2)}S`),
      });
      this.acksUntil = r.timing.lastAckAt;
      midi.logLine(`Received ${r.length} bytes from slot ${slot + 1} in ${r.timing.seconds.toFixed(1)} s: `
        + `${r.blocks ?? 0} of ${r.expectedBlocks ?? '?'} blocks, ${r.checksumErrors ?? 0} checksum errors`);
      if (r.header && r.headerBytes) {
        const h = r.header;
        midi.logLine(`Header: ${h.totalWords} words, loop ${h.loopStart}-${h.loopEnd} `
          + `${h.alternating ? 'alternating' : 'forward'}, period ${h.period} ns (${hex(r.headerBytes)})`);
      }
      for (const p of r.problems) {
        midi.logLine(p, 'warn');
      }
      if (!r.header || !r.blocks) {
        lcd.release();
        lcd.flash('RECEIVE FAILED, SEE MIDI');
        return;
      }
      const name = store.uniqueSampleName(`SLOT ${slot + 1}`);
      let sample: Sample;
      if (params) {
        const got = sampleFromDumpWithParams(r, params, name);
        for (const note of got.notes) {
          midi.logLine(`${name}: ${note}`, 'warn');
        }
        sample = got.sample;
        store.addSampleToPrograms(sample, got.programs);
      } else {
        sample = sampleFromDump(r, name);
        store.addSample(sample);
      }
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

  /** The slot's parameters, asked for once on the channel that answered last, logged; null without a reply */
  private async slotParams(slot: number, signal: AbortSignal): Promise<S700SampleParams | null> {
    const { settings, midi } = this.app;
    const r = await requestSampleParams(midi.link!, slot, { channel: settings.paramsChannel, id: settings.paramsId,
      search: false, signal });
    if (!r.reply) {
      midi.logLine(`No parameters of slot ${slot + 1} on channel ${settings.paramsChannel + 1} `
        + `(${hex([settings.paramsId])}h): the sample comes as the dump has it, without its rate, sound and programs. `
        + 'REQUEST PARAMETERS in the MIDI view looks on every channel.', 'warn');
      return null;
    }
    midi.logLine(`Parameters of slot ${r.reply.slot + 1}${r.reply.checksumOk ? '' : ', CHECKSUM ERROR'}:`,
      r.reply.checksumOk ? 'info' : 'warn');
    for (const line of paramsLines(r.reply.params)) {
      midi.logLine(line);
    }
    return r.reply.params;
  }

  /**
   * Asks the sampler for the slot's parameters with the S700's Akai exclusive request, on SYSEX CHAN first, then
   * every other channel, and logs the reply. The channel that answers is kept for RECEIVE.
   */
  async requestParams(): Promise<void> {
    if (this.busy === 'params') {
      this.cancel();
      return;
    }
    if (this.busy || !this.midiReady()) {
      return;
    }
    const { lcd, settings, midi } = this.app;
    const slot = settings.slot;
    this.setBusy('params');
    this.abort = new AbortController();
    try {
      await this.waitForAcks();
      midi.logLine(`Asking for the parameters of slot ${slot + 1}: `
        + `${hex(sampleParamsRequest(settings.paramsChannel, slot, settings.paramsId))}, on channel `
        + `${settings.paramsChannel + 1} first, then the others`);
      const r = await requestSampleParams(midi.link!, slot, {
        channel: settings.paramsChannel,
        id: settings.paramsId,
        signal: this.abort.signal,
        onRequest: (channel, id) => lcd.hold(`PARAMETERS? CH ${channel + 1} ${hex([id])}H`),
      });
      for (const m of r.other) {
        midi.logLine(`Akai message: ${hex(m.subarray(0, 16))}${m.length > 16 ? ` … (${m.length} bytes)` : ''}`);
      }
      lcd.release();
      if (!r.reply) {
        midi.logLine(`No reply to ${r.requests} requests: every channel, identifiers 41h and 65h. Is the sampler's `
          + 'MIDI OUT connected to the input?', 'warn');
        lcd.flash('NO REPLY, SEE MIDI');
        return;
      }
      settings.paramsChannel = r.reply.askedChannel;
      settings.paramsId = r.reply.askedId;
      this.app.saveSettings();
      const level = r.reply.checksumOk ? 'info' : 'warn';
      midi.logLine(`Parameters of slot ${r.reply.slot + 1}: asked on channel ${r.reply.askedChannel + 1} with `
        + `identifier ${hex([r.reply.askedId])}h, the reply on channel ${r.reply.channel + 1} with `
        + `${hex([r.reply.id])}h${r.reply.checksumOk ? '' : ', CHECKSUM ERROR'}`, level);
      for (const line of [...paramsLines(r.reply.params), `Bytes: ${hex(r.reply.bytes)}`]) {
        midi.logLine(line, level);
      }
      lcd.flash(`PARAMETERS OF SLOT ${r.reply.slot + 1}`);
    } catch (e) {
      lcd.release();
      if ((e as Error).name === 'AbortError') {
        lcd.flash('CANCELLED');
      } else {
        midi.logLine(`Request failed: ${errorText(e)}`, 'error');
        lcd.flash('REQUEST FAILED, SEE MIDI');
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

  /**
   * The sample as an S700/X7000 disk image (.qd), for a Gotek with FlashFloppy or an HxC: as the sampler will have
   * it, with its sound and its keygroups in the programs. What had to be changed is logged in the MIDI view.
   */
  async saveDisk(sample: Sample): Promise<void> {
    const { store, lcd, midi } = this.app;
    try {
      const { bytes, notes } = await diskFromSample(sample, store.programs, resampleInBrowser);
      for (const note of notes) {
        midi.logLine(`${sample.name}.qd: ${note}`);
      }
      download(bytes, `${sample.name}.qd`, 'application/octet-stream');
      lcd.flash(`SAVED ${sample.name}`);
    } catch (e) {
      midi.logLine(`Could not save ${sample.name}.qd: ${errorText(e)}`, 'error');
      lcd.flash('SAVE FAILED, SEE MIDI');
    }
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

const SCAN_NAMES = new Map<number, string>([[S700_SCAN.oneShot, 'ONE SHOT'], [S700_SCAN.looping, 'LOOP'],
  [S700_SCAN.alternating, 'ALT'], [S700_SCAN.drum, 'DRUM']]);

/** The parameters the sampler sent, for the log */
function paramsLines(p: S700SampleParams): string[] {
  const programs = p.programs.flatMap((k, i) => (k.low <= k.high
    ? [`P${i + 1} ${noteName(k.low)}-${noteName(k.high)}${k.transpose ? ` ${k.transpose > 0 ? '+' : ''}${k.transpose}` : ''}`
      + `${k.constantPitch ? ' FIXED' : ''}${k.audioTrigger === null ? '' : ` TRIGGER ${noteName(k.audioTrigger)}`}`]
    : []));
  return [
    `START ${p.start}, END ${p.end}, LOOP ${p.loop}, SCAN ${SCAN_NAMES.get(p.scanMode) ?? `? (${p.scanMode})`}`
      + `${p.reversed ? ', REVERSED' : ''}`,
    `Rate ${(samplerBandwidth(bandwidthRate(p.bandwidth))?.rate ?? bandwidthRate(p.bandwidth)).toFixed(1)} Hz `
      + `(code ${p.bandwidth}), root ${noteName(p.recordPitch)}, `
      + `fine tune ${p.fineTune}/16 semitone`,
    `LFO speed ${p.lfoSpeed} depth ${p.lfoDepth} delay ${p.lfoDelay}, filter ${p.filter}, release ${p.release}, `
      + `level ${p.loudness}, velocity to filter ${p.velFilter}, level ${p.velLoudness}, release ${p.velRelease}`,
    programs.length ? `Programs: ${programs.join(', ')}` : 'In no program',
  ];
}
