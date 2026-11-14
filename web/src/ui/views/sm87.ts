// SM-87 in the BANK view: its two banks made (DRUMS, its programs the HR-16's drums, and SAMPLES), its firmware
// package opened, and the banks built into it (model/sm87.ts): saved as a new package, installed on the FM-1 over
// Web MIDI (app/sm87install.ts), or played in SM-87's browser emulator on this site (sm87/sm87emu.js).

import type { App } from '../../app/app';
import { SM87_DRUMS, SM87_ROOM_TODAY, sm87Bank, sm87Size } from '../../model/sm87';
import type { Bank } from '../../model/types';
import { h, pickFiles } from '../dom';
import { emuWatch } from '../../sm87/sm87emu.js';

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

/**
 * What SM-87's banks take of the room its firmware leaves (the package opened, else today's firmware's), as they are
 * edited: a bar, and the KB used, free or over. For the BANK view, and PROGRAM in one of SM-87's banks.
 */
export function sm87Meter(app: App): { el: HTMLElement; dispose(): void } {
  const { store, actions } = app;
  const fill = h('div', { class: 'sm87-fill' });
  const bar = h('div', { class: 'sm87-bar', role: 'meter', 'aria-label': 'SM-87 memory used',
    'aria-valuemin': 0 }, fill);
  const text = h('span', { class: 'info' });
  const parts = h('span', { class: 'info' });
  let timer: ReturnType<typeof setTimeout> | undefined;

  function render(): void {
    const size = sm87Size(store.banks, store.samples.values());
    const fw = actions.sm87Firmware;
    const room = fw?.pkg.room ?? SM87_ROOM_TODAY;
    const over = size.total > room;
    fill.style.width = `${Math.min(100, (100 * size.total) / room).toFixed(1)}%`;
    bar.classList.toggle('over', over);
    bar.setAttribute('aria-valuemax', String(room));
    bar.setAttribute('aria-valuenow', String(size.total));
    text.classList.toggle('warn', over);
    text.textContent = `SM-87 MEMORY: ${kb(size.total)} OF ${fw ? '' : 'ABOUT '}${kb(room)}, `
      + (over ? `${kb(size.total - room)} TOO MUCH` : `${kb(room - size.total)} FREE`);
    parts.textContent = `SAMPLES ${kb(size.samples)} · DRUMS ${kb(size.drums)}`
      + (fw ? '' : ' · OPEN FIRMWARE (BANK) for its exact room');
  }

  /** a burst of changes (a point dragged) counts once it settles */
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(render, 50);
  };
  render();
  const off = [...(['samples', 'sample', 'audio', 'keygroups', 'programs'] as const).map((e) => store.on(e, later)),
    actions.onSm87(render)];
  return {
    el: h('div', { class: 'sm87-meter' }, bar, h('div', { class: 'row' }, text, parts)),
    dispose: () => {
      clearTimeout(timer);
      off.forEach((f) => f());
    },
  };
}

export function sm87Section(app: App): { el: HTMLElement; dispose(): void } {
  const { store, actions, lcd } = app;
  const emu = emuWatch();                 // the emulators running, heard before OPEN IN EMULATOR is pressed
  const banksRow = h('div', { class: 'row' });
  const firmwareRow = h('div', { class: 'row' });
  const built = h('p', { class: 'info' });
  const installBar = h('progress', { class: 'sm87-install', max: 100, value: 0, 'aria-label': 'SM-87 install' });
  const installText = h('span', { class: 'info' });
  const installRow = h('div', { class: 'row' }, installBar, installText);

  /** what a bank holds for SM-87, in a few words */
  function summary(drums: Bank | null, samples: Bank | null): string {
    const parts: string[] = [];
    if (samples) {
      const n = store.samplesIn(samples).length;
      parts.push(`${samples.name}: ${n} SAMPLE${n === 1 ? '' : 'S'}`);
    }
    if (drums) {
      const n = store.programsOf(drums).slice(0, SM87_DRUMS).filter((p) => p.keygroups.length).length;
      parts.push(`${drums.name}: ${n} OF ${SM87_DRUMS} DRUMS${n ? '' : ', THE FIRMWARE\'S OWN KIT'}`);
    }
    return parts.join(' · ');
  }

  /** what the firmware package opened holds */
  function holds(): string {
    const fw = actions.sm87Firmware;
    if (!fw) {
      return 'No firmware open: SM-87\'s package (.fwsc), a release\'s or a build\'s.';
    }
    const { pkg, held: c, heldError } = fw;
    const many = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;
    const has = heldError ? `samples that don't check (${heldError})` : !c ? 'no samples, the firmware\'s own kit'
      : `${many(c.samples.length, 'sample')} and ${c.kit ? `a kit of ${many(c.kit.sounds.length, 'sound')}`
        : 'the firmware\'s own kit'} (${kb(c.size)}), replaced by the banks'`;
    return `${fw.name}: ${pkg.identity}, ${kb(pkg.room)} for samples and a kit. It holds ${has}.`;
  }

  function render(): void {
    const installing = actions.sm87Install?.running ?? false;
    const held = !!actions.sm87Firmware?.held;
    const drums = sm87Bank(store.banks, 'drums');
    const samples = sm87Bank(store.banks, 'samples');
    const go = (bank: Bank) => h('button', { class: 'soft', title: `Select ${bank.name}`,
      onClick: () => store.selectBank(store.banks.indexOf(bank)) }, `GO TO ${bank.name}`);
    banksRow.replaceChildren(
      ...(drums && samples ? [] : [h('button', { class: 'soft', onClick: () => {
        const added = store.addSm87Banks();
        lcd.flash(added.length ? `ADDED ${added.map((b) => b.name).join(' AND ')}` : 'THEY ARE THERE');
      } }, 'INIT SM-87 BANKS')]),
      ...(drums ? [go(drums)] : []), ...(samples ? [go(samples)] : []),
      h('span', { class: 'info' }, summary(drums, samples)));
    firmwareRow.replaceChildren(
      h('button', { class: 'soft', onClick: async () => {
        const [file] = await pickFiles('.fwsc', false);
        if (file) {
          await actions.openSm87Firmware(file);
        }
      } }, 'OPEN FIRMWARE'),
      h('button', { class: 'soft', disabled: !held || installing,
        title: 'What the firmware opened holds, into DRUMS and SAMPLES: to put it into another release',
        onClick: () => actions.takeSm87() }, 'TAKE ITS SAMPLES'),
      h('button', { class: 'soft', disabled: !actions.sm87Firmware || !(drums || samples) || installing,
        title: 'Both banks into the firmware opened, saved as a new package', onClick: () => actions.saveSm87() },
      'SAVE PACKAGE'),
      h('button', { class: 'soft', disabled: !actions.sm87Firmware || !(drums || samples) || installing,
        title: 'Both banks into the firmware opened, played in SM-87\'s emulator on this site (in a tab of its own)',
        onClick: () => actions.openSm87Emulator(emu) }, 'OPEN IN EMULATOR'),
      h('button', { class: 'soft', disabled: !actions.sm87Firmware || !(drums || samples) || installing,
        title: 'Both banks into the firmware opened, installed on the FM-1 connected by USB',
        onClick: () => actions.installSm87() }, 'INSTALL ON FM-1'),
      h('span', { class: 'info' }, holds()));
    built.textContent = actions.sm87Built ?? '';
    const inst = actions.sm87Install;
    installRow.hidden = !inst;
    if (inst) {
      installBar.value = inst.pct;
      installBar.classList.toggle('failed', inst.failed);
      installText.textContent = inst.text;
      installText.classList.toggle('warn', inst.failed);
    }
  }

  render();
  const meter = sm87Meter(app);
  const off = [...(['samples', 'keygroups', 'programs'] as const).map((e) => store.on(e, render)),
    actions.onSm87(render)];
  return {
    el: h('div', { class: 'sm87' },
      h('h3', { class: 'section-title' }, 'SM-87'),
      h('p', { class: 'info' }, 'SM-87 is a firmware for the M-VAVE FM-1: an MMT-8 style sequencer, an S700/X7000 '
        + 'style sampler and an HR-16 style drum machine. It takes samples built into its firmware package. INIT SM-87 '
        + 'BANKS makes two banks for them. SAMPLES is a bank as any: its samples go in SM-87\'s slots with their '
        + 'programs. DRUMS has the HR-16\'s 16 drums as P1-P16: each plays its first keygroup\'s sample, once, start '
        + 'to end, and they replace the firmware\'s own drum kit (with no drum, the firmware\'s plays). In DRUMS, '
        + 'PROGRAM edits them as drums: one keygroup each, tuned in semitones, with a level and a pan. OPEN FIRMWARE '
        + 'takes the package, a release\'s '
        + 'or your own build\'s; TAKE ITS SAMPLES brings what it holds into DRUMS and SAMPLES, to put them into a new '
        + 'release. SAVE PACKAGE puts both banks into it as they are and saves a new package (to install '
        + 'with fm1-base\'s installer); OPEN IN EMULATOR plays that package in SM-87\'s emulator in a tab of its own '
        + '(one running starts again with it), to try before installing; INSTALL ON FM-1 puts them in and installs it '
        + 'on the FM-1 connected by USB, as that installer does. The FM-1 keeps its sequences, settings and the '
        + 'samples sent to its pool. The built-in samples are in that package only: put them into a new release\'s '
        + 'again.'),
      banksRow, meter.el, firmwareRow, installRow, built),
    dispose: () => {
      off.forEach((f) => f());
      meter.dispose();
      emu.close();
    },
  };
}
