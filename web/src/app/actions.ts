// What the panel buttons do: load files, transfers with the sampler, banks.

import { decodeAudioFile, resampleInBrowser } from '../audio/decode';
import { memoryToZip, slotsUsed, zipToMemory } from '../model/memory';
import { usedStart } from '../model/points';
import { trimBlocked, trimmed, unplayed, writtenEdits } from '../model/render';
import { S612_KEYGROUP, diskFromSample, sampleFromDisk } from '../model/disk';
import { dumpFromSample, dumpWithParams, sampleFromDump, sampleFromWav, wavFromSample } from '../model/convert';
import { LOAD_ALL_PROGRAMS, LOAD_NO_PROGRAMS, LOAD_SLOT_FILE, LOAD_SLOT_OFF } from './settings';
import { defaultSound, newId } from '../model/mapping';
import { plainRecipe } from '../model/recipe';
import type { Bank, Sample } from '../model/types';
import { receiveDump, requestSampleParams, setSampleParams, transmitDump } from '../midi/transfer';
import type { ParamsReply } from '../midi/transfer';
import { inNoProgram, sampleFromDumpWithParams } from '../model/s700';
import type { Dumped } from '../model/s700';
import { readWav } from '../protocol/wav';
import { isQdImage } from '../protocol/qd';
import { ABORT_DUMP, MAX_SAMPLES, hex, nearestBandwidth, samplerBandwidth } from '../protocol/akai';
import type { Dump } from '../protocol/akai';
import { S700_SCAN, bandwidthRate } from '../protocol/s700disk';
import type { S700SampleParams } from '../protocol/s700disk';
import { bytesWithPoints, paramsDiffer, sampleParamsBytes, sampleParamsRequest } from '../protocol/sprm';
import { noteName } from '../model/notes';
import { sm87Bank, sm87Contents, sm87Taken } from '../model/sm87';
import { installPackage } from './sm87install';
import { Sm87BankError, Sm87Package, makeBank } from '../sm87/sm87bank.js';
import type { BankContents } from '../sm87/sm87bank.js';
import { emuHolds, emuSamples, emuUrl, openInEmulator } from '../sm87/sm87emu.js';
import type { EmuWatch } from '../sm87/sm87emu.js';
import { download } from '../ui/dom';
import type { App } from './app';

/** Not a MIDI note, so auditioning doesn't collide with played notes */
const AUDITION_KEY = 200;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isAbort = (e: unknown) => (e as Error | null)?.name === 'AbortError';

export class Actions {
  busy: 'receive' | 'send' | 'receiveBank' | 'sendBank' | 'params' | 'install' | null = null;
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
   * from a sample that came from the sampler is marked as such again, and isn't edited. A wav file saved here comes
   * back as it was, without those edits: its points, scan mode, direction, sound, slot and keygroups.
   *
   * An S700/X7000 disk image (.qd) brings its sample as the sampler has it, with its sound, and its keygroups in the
   * programs it was in on the sampler. An S612 disk's sample loads as a file does, in a program of its own.
   *
   * As the sampler loads a disk, a file goes in a slot of the current bank (LOAD SLOT): the slot it was saved from
   * (a wav file saved here knows it, a disk doesn't) or else the first free one, or the slot set, the next files in
   * the slots after it; or none. A sample that was in that slot is left in no bank. The sample keeps the keygroups
   * LOAD PROG says: all, those of one program, or none.
   */
  async loadFiles(files: File[]): Promise<void> {
    const { store, lcd, renderer, settings, midi } = this.app;
    let loaded = 0;
    /** where a file goes, null for no slot of the bank */
    const slotFor = (fileSlot: number | null): number | null => {
      if (settings.loadSlot === LOAD_SLOT_OFF) {
        return null;
      }
      if (settings.loadSlot !== LOAD_SLOT_FILE) {
        const slot = settings.loadSlot - 1 + loaded;
        return slot < settings.slotCount ? slot : null;
      }
      if (fileSlot !== null && fileSlot < settings.slotCount) {
        return fileSlot;
      }
      return store.freeSlot(store.bank, settings.slotCount);
    };
    const programs = (sample: Sample) => [...new Set(sample.keygroups.map((k) => k.program))].sort((a, b) => a - b)
      .map((p) => `P${p + 1}`).join(' ');
    const placed = (fileName: string, sample: Sample, out: Sample | null) => {
      const bank = store.bankOf(sample);
      midi.logLine(`${fileName}: ${bank ? `in slot ${sample.slot! + 1} of ${bank.name}, ` : ''}`
        + `${!bank ? (settings.loadSlot === LOAD_SLOT_OFF ? 'in no bank' : `no free slot in ${store.bank.name}, in no `
          + 'bank') : sample.keygroups.length ? `in ${programs(sample)}` : 'in no program'}`
        + (!bank && sample.keygroups.length ? ` (its keygroups in ${programs(sample)} kept)` : '')
        + (out ? `; ${out.name}, in that slot before, is in no bank now` : ''));
    };
    const place = (fileName: string, sample: Sample) => {
      // LOAD PROG: the keygroups loaded, as the sampler's Pall, Pn and P**
      if (settings.loadPrograms === LOAD_NO_PROGRAMS) {
        sample.keygroups = [];
      } else if (settings.loadPrograms !== LOAD_ALL_PROGRAMS) {
        sample.keygroups = sample.keygroups.filter((k) => k.program === settings.loadPrograms - 1);
      }
      const slot = slotFor(sample.slot);
      const out = slot === null ? store.addSample(sample) : store.addSample(sample, store.bank, slot);
      placed(fileName, sample, out);
    };
    for (const file of files) {
      const name = store.uniqueSampleName(file.name.replace(/\.[^.]+$/, ''));
      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const disk = isQdImage(bytes) ? sampleFromDisk(bytes, name) : null;
        for (const note of disk?.notes ?? []) {
          midi.logLine(`${file.name}: ${note}`, 'warn');
        }
        if (disk?.format === 'S700') {
          renderer.adopt([disk.sample]); // as it is, nothing to render
          place(file.name, disk.sample);
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
            reverse: false, sound: defaultSound(), bankId: null, slot: null, keygroups: [] };
        }
        // a wav file saved here is as it sounded, its settings with it: loaded as it is
        if (!sample.fromSampler && !wav?.meta.settings) {
          sample.recipe.normalize = true;
          if (this.app.settings.loadRate === 'sampler' && !samplerBandwidth(sample.sourceRate)) {
            sample.recipe.resampleTo = nearestBandwidth(sample.sourceRate).rate;
          }
          Object.assign(sample, await renderer.render(sample));
        }
        renderer.adopt([sample]);
        if (disk) {
          // the S612 has no programs: the X7000 gives its sample a program of its own
          const slot = slotFor(null);
          const out = slot === null ? null : store.sampleAt(store.bank, slot);
          store.addSampleToOwnProgram(sample, S612_KEYGROUP, slot);
          placed(file.name, sample, out);
        } else {
          place(file.name, sample);
        }
        loaded++;
      } catch (e) {
        midi.logLine(`Could not load ${file.name}: ${errorText(e)}`, 'error');
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

  /**
   * Makes the sample as it sounds now its original: its edits written into the audio, and only the part that plays
   * kept, from START (or a loop start before it) to END, as for a large file of which a part is wanted. The original
   * as loaded is let go: RESET EDITS goes back to this. Asks first.
   */
  async applyEdits(sample: Sample): Promise<void> {
    const { store, renderer, lcd, midi } = this.app;
    if (sample.fromSampler) {
      return;
    }
    const from = usedStart(sample);
    const cut = from > 0 || sample.end < sample.data.length;
    if (!confirm(`Write the edits into ${sample.name}${cut ? `, and keep only START to END of it (${
      ((sample.end - from) / sample.rate).toFixed(2)} of ${(sample.data.length / sample.rate).toFixed(2)} s)` : ''}? `
      + 'The original as it was loaded is let go, RESET EDITS then goes back to this. A memory file saved before '
      + 'still has it.')) {
      return;
    }
    try {
      // as the settings are now: a render can still be on its way
      const written = writtenEdits(await renderer.render(sample), sample);
      renderer.adopt([{ ...sample, ...written }]); // nothing to render again
      store.replaceOriginal(sample.id, written);
      lcd.flash('EDITS WRITTEN');
    } catch (e) {
      midi.logLine(`Could not write the edits of ${sample.name}: ${errorText(e)}`, 'error');
      lcd.flash('NOT WRITTEN, SEE MIDI');
    }
  }

  /**
   * Cuts off what doesn't play: the audio before START (or a loop start before it) and after END, of the original too,
   * for a sampler or a player with little memory. A sample from the sampler may be trimmed too: the part that plays
   * stays as it came. Edits stay as they are; a resampled or crossfaded sample is trimmed by APPLY EDITS. Asks first.
   */
  trim(sample: Sample): void {
    const { store, renderer, lcd } = this.app;
    const blocked = trimBlocked(sample);
    if (blocked) {
      lcd.flash(`${blocked}: APPLY EDITS TRIMS IT`);
      return;
    }
    const { before, after } = unplayed(sample);
    if (!before && !after) {
      lcd.flash('NOTHING TO TRIM');
      return;
    }
    const seconds = (n: number) => (n / sample.rate).toFixed(2);
    if (!confirm(`Keep only the part of ${sample.name} that plays, ${seconds(sample.end - before)} of `
      + `${seconds(sample.data.length)} s: START${usedStart(sample) < sample.start ? ' (the loop start before '
        + 'it)' : ''} to END? The rest is let go, from the original too. A memory file saved before still has it.`)) {
      return;
    }
    const t = trimmed(sample);
    renderer.adopt([{ ...sample, ...t }]); // as rendered: the same audio, cut
    store.trimSample(sample.id, t);
    lcd.flash(`TRIMMED TO ${seconds(t.data.length)}S`);
  }

  /**
   * Lets a sample from the sampler be edited like a loaded one. It is then sent and saved as edited, no longer as it
   * came, and keeps none of the sampler's mark: receive it again for that. Asks first.
   */
  allowEdits(sample: Sample): void {
    if (!sample.fromSampler || !confirm(`Allow editing ${sample.name}'s audio (resampling, normalizing, attack, `
      + 'fade out, crossfade, writing edits)? It is then sent and saved as edited, not as it came from the sampler, and that '
      + 'can\'t be switched back: receive it again for the sampler\'s own.')) {
      return;
    }
    this.app.store.allowEdits(sample.id);
    this.app.lcd.flash('EDITS ALLOWED');
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
   *
   * The sampler only sends START to END. With RECEIVE ALL on (settings.wholeSample), START is set to 0 and END to the
   * most on the sampler for the dump, by sending the slot's parameters back with them changed, and the parameters as
   * they were are sent again after it, also when it fails or is cancelled.
   */
  async receive(): Promise<void> {
    if (this.busy === 'receive' || this.busy === 'receiveBank') {
      this.cancel();
      return;
    }
    if (this.busy || !this.midiReady()) {
      return;
    }
    const { lcd, settings, midi, store } = this.app;
    const slot = settings.slot;
    this.setBusy('receive');
    this.abort = new AbortController();
    try {
      const got = await this.receiveSlot(slot, store.bank, this.abort.signal, `RECEIVING SLOT ${slot + 1}`, false);
      lcd.release();
      lcd.flash(!got || got.ok ? `RECEIVED ${got?.sample.name ?? ''}` : 'RECEIVED WITH ERRORS');
    } catch (e) {
      lcd.release();
      if (isAbort(e)) {
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

  /**
   * Receives every slot of the sampler (SLOTS), one after the other as RECEIVE does, into the bank that is current
   * when it starts. A slot whose sample is in no program on the sampler (an empty one too, see inNoProgram) isn't
   * received, it is emptied in the bank. A slot that fails is logged and passed over. Pressing it (or RECEIVE) again stops it.
   */
  async receiveBank(): Promise<void> {
    if (this.busy === 'receiveBank' || this.busy === 'receive') {
      this.cancel();
      return;
    }
    if (this.busy || !this.midiReady()) {
      return;
    }
    const { lcd, settings, midi, store } = this.app;
    const bank = store.bank;
    const count = settings.slotCount;
    this.setBusy('receiveBank');
    this.abort = new AbortController();
    const failed: number[] = [];
    const unused: number[] = [];
    let received = 0;
    try {
      midi.logLine(`Receiving slots 1-${count} into ${bank.name}`);
      for (let slot = 0; slot < count; slot++) {
        this.abort.signal.throwIfAborted();
        try {
          const got = await this.receiveSlot(slot, bank, this.abort.signal, `RECEIVE BANK ${slot + 1}/${count}`,
            true);
          if (!got) {
            unused.push(slot + 1);
            continue;
          }
          received++;
          if (!got.ok) {
            failed.push(slot + 1);
          }
        } catch (e) {
          if (isAbort(e)) {
            throw e;
          }
          midi.logLine(`Slot ${slot + 1} failed: ${errorText(e)}`, 'error');
          failed.push(slot + 1);
        }
      }
      lcd.release();
      midi.logLine(`Received ${received} of ${count} slots into ${bank.name}`
        + (unused.length ? `, slot ${unused.join(', ')} in no program` : '')
        + (failed.length ? `, slot ${failed.join(', ')} failed or with errors` : ''), failed.length ? 'warn' : 'info');
      lcd.flash(failed.length ? `RECEIVED, ${failed.length} WITH ERRORS`
        : `RECEIVED ${received}${unused.length ? `, ${unused.length} SKIPPED` : ` SLOT${received === 1 ? '' : 'S'}`}`);
    } catch (e) {
      lcd.release();
      if (isAbort(e)) {
        midi.logLine(`Receiving the bank stopped after ${received} of ${count} slots`, 'warn');
        lcd.flash('RECEIVE BANK CANCELLED');
      } else {
        midi.logLine(`Receiving the bank failed: ${errorText(e)}`, 'error');
        lcd.flash('RECEIVE FAILED, SEE MIDI');
      }
    } finally {
      this.abort = null;
      this.setBusy(null);
    }
  }

  /**
   * Receives a slot's sample into the slot of the bank, with its parameters and keygroups, the dump logged. A sample
   * in that slot of the bank before is left in no bank.
   *
   * @param label for the LCD while receiving
   * @param skipUnused a slot in no program isn't received but emptied in the bank, null returned
   * @throws Error if it fails, the AbortError if cancelled
   */
  private async receiveSlot(slot: number, bank: Bank, signal: AbortSignal, label: string, skipUnused: boolean)
    : Promise<{ sample: Sample; ok: boolean } | null> {
    const { store, lcd, settings, midi } = this.app;
    lcd.hold(label);
    await this.waitForAcks();
    const reply = await this.slotParams(slot, signal);
    if (reply?.checksumOk && reply.slot === slot && inNoProgram(reply.params)) {
      if (skipUnused) {
        midi.logLine(`Slot ${slot + 1} is in no program on the sampler (an empty slot is so too), not received`
          + (store.sampleAt(bank, slot) ? `: ${store.sampleAt(bank, slot)!.name} is in no bank now` : ''));
        store.clearSlot(bank, slot);
        return null;
      }
      midi.logLine(`Slot ${slot + 1} is in no program on the sampler`, 'warn');
    }
    const params = reply?.params ?? null;
    const putBack = reply && settings.wholeSample ? await this.wholeMemory(slot, reply, label) : null;
    let r;
    try {
      signal.throwIfAborted();
      r = await receiveDump(midi.link!, slot, {
        ackIntervalMs: settings.ackIntervalMs,
        lookaheadMs: settings.lookaheadMs,
        signal,
        onProgress: (p) => lcd.hold(`${label} ${(p.elapsedMs / 1000).toFixed(0).padStart(2)}S`),
      });
    } catch (e) {
      this.acksUntil = (e as { timing?: { lastAckAt: number } }).timing?.lastAckAt ?? this.acksUntil;
      if (putBack) {
        await this.pointsBack(slot, putBack.was, true);
      }
      throw e;
    }
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
    if (putBack) {
      await this.pointsBack(slot, putBack.was, !r.header || !r.blocks);
    }
    if (!r.header || !r.blocks) {
      throw new Error(`No sample came from slot ${slot + 1}`);
    }
    const name = store.uniqueSampleName(`SLOT ${slot + 1}`);
    let sample: Sample;
    if (params) {
      const got = sampleFromDumpWithParams(r, params, name, putBack?.dumped ?? undefined);
      for (const note of got.notes) {
        midi.logLine(`${name}: ${note}`, 'warn');
      }
      sample = got.sample;
    } else {
      sample = sampleFromDump(r, name);
    }
    const out = store.addSample(sample, bank, slot);
    if (out) {
      midi.logLine(`${out.name}, in slot ${slot + 1} of ${bank.name} before, is in no bank now`);
    }
    return { sample, ok: r.ok };
  }

  /** The slot's parameters, asked for once on the channel that answered last, logged; null without a reply */
  private async slotParams(slot: number, signal: AbortSignal): Promise<ParamsReply | null> {
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
    return r.reply;
  }

  /**
   * Sets START to 0 and END to the most on the sampler, so a dump has all of its memory for the sample, as a disk has
   * it: what is before START, and after END, of a recording that was cut. The slot's parameters are sent back with
   * those changed.
   *
   * @returns the parameters to put back after the dump, and what the sampler has for it (null if not known); null if
   * nothing was changed
   */
  private async wholeMemory(slot: number, reply: ParamsReply, label: string)
    : Promise<{ was: ParamsReply; dumped: Dumped | null } | null> {
    const { settings, midi, lcd } = this.app;
    const { start, end } = reply.params;
    if (start === 0 && end === MAX_SAMPLES) {
      return null;
    }
    if (!reply.checksumOk || reply.slot !== slot) {
      midi.logLine('START and END aren\'t changed for the receive: the parameters didn\'t come through right',
        'warn');
      return null;
    }
    lcd.hold('RECEIVE ALL');
    midi.logLine(`START ${start}, END ${end}: the sampler only sends START to END, setting them to 0 and `
      + `${MAX_SAMPLES} on slot ${slot + 1} for the receive, then back`);
    // not cancelled while they are changed, so they are put back
    const now = await setSampleParams(midi.link!, slot, bytesWithPoints(reply.bytes, 0, MAX_SAMPLES),
      { channel: settings.paramsChannel, id: settings.paramsId });
    lcd.hold(label);
    if (!now) {
      midi.logLine('No reply after setting START and END: not known if the sampler has them', 'warn');
      return { was: reply, dumped: null };
    }
    const has = { start: now.params.start, end: now.params.end };
    if (has.start === start && has.end === end) {
      midi.logLine(`The sampler kept START ${start} and END ${end}: it didn't take the parameters`, 'warn');
      return null;
    }
    midi.logLine(`START ${has.start}, END ${has.end} on the sampler`, has.start === 0 && has.end === MAX_SAMPLES
      ? 'info' : 'warn');
    return { was: reply, dumped: has };
  }

  /**
   * Puts the parameters back as they were before the receive, and asks for them to see that they are. After a dump
   * that failed or was cancelled the sampler may still be sending: it is told to stop first.
   */
  private async pointsBack(slot: number, was: ParamsReply, failed: boolean): Promise<void> {
    const { settings, midi, lcd } = this.app;
    const { start, end } = was.params;
    lcd.hold('PARAMETERS BACK');
    try {
      await this.waitForAcks();
      if (failed) {
        midi.link!.output?.send(ABORT_DUMP);
        await sleep(300);
      }
      let differ = ['no reply'];
      for (let tries = 0; tries < 3 && differ.length; tries++) {
        if (tries > 0) {
          await sleep(1000);
        }
        const now = await setSampleParams(midi.link!, slot, was.bytes,
          { channel: settings.paramsChannel, id: settings.paramsId });
        differ = now ? paramsDiffer(now.params, was.params) : ['no reply'];
      }
      if (differ.length) {
        midi.logLine(`Couldn't see the parameters back on slot ${slot + 1} (${differ.join(', ')}): check START ${start} `
          + `and END ${end} on the sampler`, 'error');
      } else {
        midi.logLine(`START ${start} and END ${end} are back on the sampler`);
      }
    } catch (e) {
      midi.logLine(`Couldn't set START back to ${start} and END to ${end} on slot ${slot + 1}: ${errorText(e)}. `
        + 'Check them on the sampler', 'error');
    }
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

  /**
   * Sends the selected sample to its slot. If the sampler answers a request for the slot's parameters, all of the
   * sample is sent if it fits, as a disk has it, then its parameters: START, END, loop, scan mode, sound and its key
   * ranges in the programs (a sample in no program keeps the slot's key ranges, root and fine tune). Else the part
   * from START to END is sent, and the log says what to set on the sampler.
   */
  async send(): Promise<void> {
    if (this.busy === 'send' || this.busy === 'sendBank') {
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
    const slot = sample.slot;
    if (slot === null) {
      lcd.flash('IT HAS NO SLOT, SET ONE');
      return;
    }
    if (slot >= settings.slotCount) {
      lcd.flash(`SLOT ${slot + 1}: THE SAMPLER HAS ${settings.slotCount}`);
      return;
    }
    if (!this.midiReady()) {
      return;
    }
    this.setBusy('send');
    this.abort = new AbortController();
    try {
      const r = await this.sendSlot(sample, slot, this.abort.signal, `SENDING SLOT ${slot + 1}`);
      lcd.release();
      if (r.cancelled) {
        lcd.flash('STOPPED WAITING');
      } else {
        lcd.flash(r.replies >= r.numBlocks ? `SENT TO SLOT ${slot + 1}` : `SENT, ${r.replies}/${r.numBlocks} ACKS`);
      }
    } catch (e) {
      lcd.release();
      if (isAbort(e)) {
        lcd.flash('SEND CANCELLED');
      } else {
        midi.logLine(`Send failed: ${errorText(e)}`, 'error');
        lcd.flash('SEND FAILED, SEE MIDI');
      }
    } finally {
      this.abort = null;
      this.setBusy(null);
    }
  }

  /**
   * Sends the samples in the current bank to their slots on the sampler, one after the other as SEND does, with
   * their key ranges. Slots without a sample here are left as they are on the sampler.
   * A slot that fails is logged and passed over. Pressing it (or SEND) again stops it.
   */
  async sendBank(): Promise<void> {
    if (this.busy === 'sendBank' || this.busy === 'send') {
      this.cancel();
      return;
    }
    if (this.busy || !this.midiReady()) {
      return;
    }
    const { lcd, settings, midi, store } = this.app;
    const bank = store.bank;
    const count = settings.slotCount;
    const slots = store.samplesIn(bank).filter((s) => s.slot! < count).map((sample) => ({ slot: sample.slot!, sample }));
    if (slots.length === 0) {
      lcd.flash('NO SAMPLES IN THE SLOTS');
      return;
    }
    if (!confirm(`Send the ${slots.length} samples in ${bank.name}'s slots to the sampler (slot `
      + `${slots.map((s) => s.slot + 1).join(', ')})? They replace what is in those slots there.`)) {
      return;
    }
    this.setBusy('sendBank');
    this.abort = new AbortController();
    const failed: number[] = [];
    let sent = 0;
    try {
      const empty = Array.from({ length: count }, (_, i) => i).filter((i) => !slots.some((s) => s.slot === i));
      midi.logLine(`Sending ${bank.name} to slots ${slots.map((s) => s.slot + 1).join(', ')}`
        + (empty.length ? `; slot ${empty.map((i) => i + 1).join(', ')} without a sample here, left as they are` : ''));
      for (const [k, { slot, sample }] of slots.entries()) {
        this.abort.signal.throwIfAborted();
        try {
          const r = await this.sendSlot(sample, slot, this.abort.signal, `SEND BANK ${k + 1}/${slots.length}`);
          if (r.cancelled) {
            throw new DOMException('Cancelled', 'AbortError');
          }
          sent++;
          if (r.replies < r.numBlocks) {
            failed.push(slot + 1);
          }
        } catch (e) {
          if (isAbort(e)) {
            throw e;
          }
          midi.logLine(`Slot ${slot + 1} failed: ${errorText(e)}`, 'error');
          failed.push(slot + 1);
        }
      }
      lcd.release();
      midi.logLine(`Sent ${sent} of ${slots.length} samples of ${bank.name}`
        + (failed.length ? `, slot ${failed.join(', ')} failed or not all acknowledged` : ''),
      failed.length ? 'warn' : 'info');
      lcd.flash(failed.length ? `SENT, ${failed.length} WITH ERRORS` : `SENT ${sent} SLOTS`);
    } catch (e) {
      lcd.release();
      if (isAbort(e)) {
        midi.logLine(`Sending the bank stopped after ${sent} of ${slots.length} samples`, 'warn');
        lcd.flash('SEND BANK CANCELLED');
      } else {
        midi.logLine(`Sending the bank failed: ${errorText(e)}`, 'error');
        lcd.flash('SEND FAILED, SEE MIDI');
      }
    } finally {
      this.abort = null;
      this.setBusy(null);
    }
  }

  /**
   * Sends a sample to a slot, with its parameters and its key ranges if the sampler answers for them, the transfer
   * logged
   *
   * @param label for the LCD while sending
   * @throws Error if it fails, the AbortError if cancelled before sending
   */
  private async sendSlot(sample: Sample, slot: number, signal: AbortSignal, label: string)
    : Promise<{ cancelled: boolean; replies: number; numBlocks: number }> {
    const { lcd, settings, midi } = this.app;
    lcd.hold(`PREPARING ${sample.name}`);
    await this.waitForAcks();
    const options = { slot, filler: { fillerPerBlock: settings.fillerPerBlock } };
    const has = (await requestSampleParams(midi.link!, slot, { channel: settings.paramsChannel,
      id: settings.paramsId, search: false, signal })).reply;
    let dump: Dump;
    let params: S700SampleParams | null = null;
    if (has?.checksumOk && has.slot === slot) {
      const made = await dumpWithParams(sample, options, resampleInBrowser);
      ({ dump, params } = made);
      if (!made.inProgram) {
        // in no program here: the sampler keeps the slot's key ranges, which then play this sample
        Object.assign(params, { programs: has.params.programs, recordPitch: has.params.recordPitch,
          fineTune: has.params.fineTune });
        made.notes.push('In no program here: it keeps the slot\'s key ranges, root and fine tune on the sampler');
      }
      for (const note of made.notes) {
        midi.logLine(`${sample.name}: ${note}`);
      }
    } else {
      midi.logLine(`No parameters of slot ${slot + 1} on channel ${settings.paramsChannel + 1} `
        + `(${hex([settings.paramsId])}h): sending START to END only, without the sound and key ranges`, 'warn');
      const made = await dumpFromSample(sample, options, resampleInBrowser);
      dump = made.dump;
      for (const note of made.notes) {
        midi.logLine(`${sample.name}: ${note}`);
      }
    }
    signal.throwIfAborted();
    const r = await transmitDump(midi.link!, dump, {
      signal,
      onProgress: (p) => lcd.hold(`${label} ${Math.min(99, Math.round(p.elapsedMs / p.wireMs * 100))
        .toString().padStart(2)}%`),
    });
    midi.logLine(`Sent ${sample.name} to slot ${slot + 1}: ${r.bytes} bytes, ${r.numBlocks} blocks, `
      + `${r.replies} replies from the sampler`);
    if (params && r.cancelled) {
      midi.logLine('Stopped: the parameters weren\'t sent', 'warn');
    } else if (params) {
      await this.sendParams(slot, params);
    }
    return r;
  }

  /** Sets a slot's parameters on the sampler after a dump, and asks for them to see that it has them */
  private async sendParams(slot: number, params: S700SampleParams): Promise<void> {
    const { settings, midi, lcd } = this.app;
    lcd.hold(`PARAMETERS SLOT ${slot + 1}`);
    const now = await setSampleParams(midi.link!, slot, sampleParamsBytes(params),
      { channel: settings.paramsChannel, id: settings.paramsId });
    const differ = now ? paramsDiffer(now.params, params) : null;
    if (differ?.length === 0) {
      midi.logLine(`Parameters set on slot ${slot + 1}: START ${params.start}, END ${params.end}, LOOP ${params.loop}, `
        + 'scan, sound and key ranges');
      return;
    }
    midi.logLine(`${differ ? `The sampler doesn't have the parameters sent (${differ.join(', ')})`
      : 'No reply after sending the parameters'}: set START ${params.start}, END ${params.end} and LOOP `
      + `${params.loop} on the sampler`, 'warn');
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

  /**
   * The sample as it plays, with its loop for other programs, and its settings, slot and keygroups for this one,
   * marked if it came from the sampler
   */
  saveWav(sample: Sample): void {
    download(wavFromSample(sample), `${sample.name}.wav`, 'audio/wav');
  }

  /**
   * The sample as an S700/X7000 disk image (.qd), for a Gotek with FlashFloppy or an HxC: as the sampler will have
   * it, with its sound and its keygroups in the programs. What had to be changed is logged in the MIDI view.
   */
  async saveDisk(sample: Sample): Promise<void> {
    const { lcd, midi } = this.app;
    try {
      const { bytes, notes } = await diskFromSample(sample, resampleInBrowser);
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

  /** SM-87's firmware package SAVE PACKAGE and INSTALL put the banks into, as opened (the file's name and bytes) */
  sm87Firmware: {
    name: string;
    bytes: Uint8Array;
    pkg: Sm87Package;
    /** what it holds (read once: it doesn't change), null for nothing; heldError when that doesn't check */
    held: BankContents | null;
    heldError: string | null;
  } | null = null;
  /** what the last package made of the banks holds, for the BANK view */
  sm87Built: string | null = null;
  private sm87Listeners = new Set<() => void>();

  /** @returns a function that stops listening: the firmware opened, a package made, an install's progress */
  onSm87(listener: () => void): () => void {
    this.sm87Listeners.add(listener);
    return () => this.sm87Listeners.delete(listener);
  }

  private sm87Changed(): void {
    this.sm87Listeners.forEach((f) => f());
  }

  /**
   * Opens SM-87's firmware package (.fwsc), a release's or a build's, to put the samples into: it is checked, and
   * what it holds is said in the BANK view
   */
  async openSm87Firmware(file: File): Promise<void> {
    const { lcd, midi } = this.app;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const pkg = new Sm87Package(bytes, file.name);
      let held: BankContents | null = null;
      let heldError: string | null = null;
      try {
        held = pkg.contents();
      } catch (e) {
        heldError = errorText(e);
      }
      this.sm87Firmware = { name: file.name, bytes, pkg, held, heldError };
      this.sm87Built = null;
      lcd.flash(`OPENED ${this.sm87Firmware.pkg.identity}`);
    } catch (e) {
      midi.logLine(`SM-87: ${errorText(e)}`, 'error');
      lcd.flash(e instanceof Sm87BankError && e.code === 'no-bank' ? 'NOT AN SM-87, SEE MIDI'
        : 'CAN\'T OPEN IT, SEE MIDI');
    }
    this.sm87Changed();
  }

  /**
   * SM-87's SAMPLES and DRUMS banks put into the firmware package opened (model/sm87.ts), as they are now: a new
   * package named after it with "-axs7". What had to be changed or left out is logged in the MIDI view, and what it
   * holds is said in the BANK view (sm87Built). Null when it can't be made (said on the LCD).
   */
  private async buildSm87Package(): Promise<{ name: string; bytes: Uint8Array } | null> {
    const { store, lcd, midi } = this.app;
    const firmware = this.sm87Firmware;
    if (!firmware) {
      lcd.flash('OPEN SM-87 FIRMWARE FIRST');
      return null;
    }
    try {
      const contents = await sm87Contents(store.banks, store.samples.values(), resampleInBrowser);
      const pkg = new Sm87Package(firmware.bytes, firmware.name);
      const bank = contents.samples.length || contents.kit ? makeBank(contents.samples, contents.kit) : null;
      pkg.put(bank);
      for (const note of contents.notes) {
        midi.logLine(`SM-87: ${note}`);
      }
      const name = `${firmware.name.replace(/\.fwsc$/i, '')}-axs7.fwsc`;
      const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
      const many = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
      const kit = contents.kit ? `a kit of ${many(contents.kit.sounds.length, 'sound')}` : 'the firmware\'s own kit';
      const notes = contents.notes.length ? ` (${many(contents.notes.length, 'note')} in MIDI)` : '';
      this.sm87Built = `${name}: ${many(contents.samples.length, 'sample')} and ${kit}, `
        + `${kb(bank?.length ?? 0)} of the ${kb(pkg.room)} there is room for${notes}`;
      midi.logLine(`SM-87: ${this.sm87Built}`);
      return { name, bytes: pkg.bytes() };
    } catch (e) {
      midi.logLine(`SM-87: ${errorText(e)}`, 'error');
      this.sm87Built = errorText(e);
      lcd.flash(e instanceof Sm87BankError && e.code === 'too-big' ? 'TOO BIG FOR SM-87, SEE MIDI'
        : 'COULD NOT MAKE IT, SEE MIDI');
      return null;
    } finally {
      this.sm87Changed();
    }
  }

  /** SM-87's banks put into the firmware opened, saved as a package to install with fm1-base's installer */
  async saveSm87(): Promise<void> {
    const built = await this.buildSm87Package();
    if (built) {
      download(built.bytes, built.name, 'application/octet-stream');
      this.app.lcd.flash(`SAVED ${built.name}`);
    }
  }

  /**
   * SM-87's banks put into the firmware opened, as they are now, and played in SM-87's browser emulator on this site
   * (sm87/sm87emu.js, SM-87's): kept where the emulator looks for them, an emulator running (watch: the BANK view's)
   * starts again with them, else it opens in a tab of its own and plays them as it is switched on. Called in the
   * button's click: the tab is opened before the package is made, while the browser allows it.
   */
  async openSm87Emulator(watch: EmuWatch): Promise<void> {
    const { lcd, midi } = this.app;
    if (!this.sm87Firmware) {
      lcd.flash('OPEN SM-87 FIRMWARE FIRST');
      return;
    }
    let made = '';
    try {
      const how = await openInEmulator(watch, async () => {
        const built = await this.buildSm87Package();
        if (!built) {
          return null;
        }
        const k = emuSamples(built.bytes, built.name);
        made = `${built.name} (${emuHolds(k)})`;
        return k;
      });
      if (!how) {
        return;                           // (said by buildSm87Package)
      }
      const said = {
        told: `SM-87: ${made} in the emulator: it starts again with them in its tab; switch it on there`,
        opened: `SM-87: ${made} in the emulator, opened in a tab of its own: switch it on there`,
        blocked: `SM-87: ${made} kept for the emulator, but this browser opens no tab from here: open ${emuUrl()} `
          + 'and switch it on',
      }[how];
      midi.logLine(said, how === 'blocked' ? 'error' : undefined);
      lcd.flash(how === 'blocked' ? 'OPEN THE EMULATOR, SEE MIDI' : 'SWITCH ON THE EMULATOR');
    } catch (e) {
      midi.logLine(`SM-87: the emulator: ${errorText(e)}`, 'error');
      lcd.flash('NOT IN THE EMULATOR, SEE MIDI');
    }
  }

  /**
   * What the firmware package opened holds taken into SM-87's banks, after a confirm, so that a package made of them
   * again has the same (model/sm87.ts sm87Taken): for its samples and kit to go into a new release's package. What the
   * banks held goes to no bank; what couldn't be taken is logged in the MIDI view.
   */
  takeSm87(): void {
    const { store, lcd, midi, renderer } = this.app;
    const firmware = this.sm87Firmware;
    if (!firmware) {
      lcd.flash('OPEN SM-87 FIRMWARE FIRST');
      return;
    }
    const { held, heldError } = firmware;
    if (heldError) {
      midi.logLine(`SM-87: ${heldError}`, 'error');
      lcd.flash("ITS SAMPLES DON'T CHECK, SEE MIDI");
      return;
    }
    if (!held) {
      lcd.flash('IT HOLDS NO SAMPLES');
      return;
    }
    if (!confirm(`Take the samples and kit in ${firmware.name} into DRUMS and SAMPLES? What those banks hold now goes `
      + 'to no bank (it stays in memory).')) {
      return;
    }
    store.addSm87Banks();
    const drumsId = sm87Bank(store.banks, 'drums')!.id;
    const taken = sm87Taken(held, drumsId, sm87Bank(store.banks, 'samples')!.id);
    renderer.adopt(taken.samples); // as they are, nothing to render
    store.takeSm87(taken.samples, taken.pans, taken.levels);
    for (const note of taken.notes) {
      midi.logLine(`SM-87: ${firmware.name}: ${note}`);
    }
    const many = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
    const drums = taken.samples.filter((s) => s.bankId === drumsId).length;
    const kit = held.kit ? `a kit of ${many(drums, 'drum sample')}` : "no kit (the firmware's own)";
    const notes = taken.notes.length ? ` (${many(taken.notes.length, 'note')} in MIDI)` : '';
    this.sm87Built = `Took ${many(held.samples.length, 'sample')} and ${kit} from ${firmware.name}${notes}`;
    midi.logLine(`SM-87: ${this.sm87Built}`);
    lcd.flash(`TOOK ${firmware.pkg.identity}'S SAMPLES`);
    this.sm87Changed();
  }

  /** an install under way or done: its share and what it says, for the BANK view */
  sm87Install: { pct: number; text: string; running: boolean; failed: boolean } | null = null;

  /**
   * SM-87's banks put into the firmware opened, as they are now, and installed on the FM-1 connected by USB over Web
   * MIDI (sm87install.ts), after a confirm. An FM-1 waiting in update mode has that install finished. The bar and
   * what happens are in the BANK view, the steps in the MIDI log.
   */
  async installSm87(): Promise<void> {
    const { lcd, midi } = this.app;
    if (this.busy) {
      lcd.flash(this.busy === 'install' ? 'INSTALLING' : 'BUSY, PRESS STOP FIRST');
      return;
    }
    if (!this.sm87Firmware) {
      lcd.flash('OPEN SM-87 FIRMWARE FIRST');
      return;
    }
    if (!confirm('Install SM-87 with these samples on the FM-1 connected by USB? It replaces its firmware; it keeps '
      + 'its sequences, settings and the samples sent to its pool. Leave it connected, and this page open, until it '
      + 'says DONE.')) {
      return;
    }
    const show = (pct: number, text: string, running: boolean, failed = false) => {
      this.sm87Install = { pct, text, running, failed };
      this.sm87Changed();
    };
    if (!midi.link) {
      await midi.connect();
    }
    const access = midi.link?.access;
    if (!access) {
      show(0, `No MIDI: ${midi.problem ?? midi.error ?? 'not connected'}. Allow MIDI with SysEx for this page (MIDI view).`,
        false, true);
      lcd.flash('NO MIDI, SEE MIDI VIEW');
      return;
    }
    const built = await this.buildSm87Package();
    if (!built) {
      return;
    }
    this.setBusy('install');
    show(0, `INSTALLING ${built.name}`, true);
    try {
      const runs = await installPackage(access, built.bytes, (p) => {
        lcd.flash(p.text);
        show(p.pct, `${p.text}: ${built.name}`, true);
      }, (line) => midi.logLine(`SM-87 install: ${line}`));
      show(100, `INSTALLED ${built.name}: the FM-1 runs ${runs}`, false);
      midi.logLine(`SM-87: installed ${built.name}, the FM-1 runs ${runs}`);
      lcd.flash('INSTALLED');
    } catch (e) {
      const text = errorText(e);
      show(this.sm87Install?.pct ?? 0, text, false, true);
      midi.logLine(`SM-87 install: ${text}`, 'error');
      lcd.flash('INSTALL FAILED, SEE BANK');
    } finally {
      this.setBusy(null);
    }
  }

  /** The whole memory, every bank and sample, as a zip file, with SLOTS */
  saveMemory(): void {
    const { store, lcd } = this.app;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    download(memoryToZip({ samples: [...store.samples.values()], banks: store.banks, bankIndex: store.bankIndex,
      programIndex: store.programIndex, slotCount: this.app.settings.slotCount }), `axs7-memory-${stamp}.zip`,
    'application/zip');
    lcd.flash('MEMORY SAVED');
  }

  /**
   * A memory file, or a bank file from before banks: it replaces the memory. SLOTS is raised to the slots it was saved
   * with, or its samples are in, if it is lower; a lower number in the file leaves it as it is.
   */
  async loadMemory(file: File): Promise<void> {
    const { store, lcd } = this.app;
    try {
      const memory = zipToMemory(new Uint8Array(await file.arrayBuffer()));
      this.app.renderer.adopt(memory.samples); // they come rendered
      if (store.samples.size > 0 && !confirm(`Load ${file.name}? It replaces the samples and banks in memory.`)) {
        return;
      }
      this.app.player.allNotesOff(true);
      store.replaceAll(memory.samples, memory.banks, memory.bankIndex, memory.programIndex);
      for (const note of memory.notes ?? []) {
        this.app.midi.logLine(`${file.name}: ${note}`, 'warn');
      }
      // a memory for a sampler with more slots needs them, its samples are in them; fewer are no matter
      const slots = slotsUsed(memory);
      const raised = slots > this.app.settings.slotCount;
      if (raised) {
        this.app.midi.logLine(`${file.name}: SLOTS set from ${this.app.settings.slotCount} to ${slots}, the sampler `
          + `it was saved for has ${memory.slotCount === slots ? '' : 'samples in '}${slots} slots`, 'warn');
        this.app.setSlotCount(slots);
      }
      lcd.flash(raised ? `LOADED ${memory.samples.length}, SLOTS ${slots}` : `LOADED ${memory.samples.length} SAMPLES`);
    } catch (e) {
      this.app.midi.logLine(`Could not load ${file.name}: ${errorText(e)}`, 'error');
      lcd.flash('NOT A MEMORY FILE');
    }
  }

  clearMemory(): void {
    const { store, lcd, player } = this.app;
    if (confirm('Clear all samples and banks from memory? Save the memory first to keep them.')) {
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
