// Installing a firmware package (.fwsc) on an FM-1 connected by USB, over Web MIDI: fm1-base's update (its
// installer page's fm1ota.js and fm1pkg.js, copied in ../sm87), as its installer page runs it. The FM-1 reads the
// package from here: the running firmware checks it and goes into its update loader, the loader writes it and
// restarts into the new firmware. An FM-1 found waiting in update mode (an install cut off) is finished. Only the
// firmware's part of the flash is written: the FM-1 keeps its sequences, settings and the samples in its pool.

import { Updater } from '../sm87/fm1ota.js';
import type { Fm1Error, Fm1Step } from '../sm87/fm1ota.js';
import { checkUfw, logicalImage, productOf, ufwEntries } from '../sm87/fm1pkg.js';

export interface InstallProgress {
  /** fm1ota.js's step: start, verify, loader, mode, write, reboot, done */
  step: string;
  /** 0-100, never back; 100 once the FM-1 runs the package */
  pct: number;
  /** for the LCD */
  text: string;
}

/** An install that failed: its code (fm1ota.js's, or badpkg) and what to do */
export class InstallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

const STEP_TEXT: Record<string, string> = { start: 'STARTING', verify: 'VERIFYING', loader: 'TO UPDATE MODE',
  write: 'WRITING', reboot: 'RESTARTING', done: 'DONE' };

// fm1-base's installer page's words (web/installer.html), for INSTALL here
const FAIL_TEXT: Record<string, string> = {
  notfound: 'FM-1 not found. Check the USB cable (a data cable), close other apps and browser tabs that use MIDI '
    + '(another firmware\'s installer or editor), and press INSTALL again.',
  model: 'The connected device is not an FM-1.',
  stopped: 'Stopped. Replug the USB cable and press INSTALL again.',
  lost: 'The USB connection was lost. Replug it and press INSTALL again.',
  noloader: 'The FM-1 in update mode was not found. Replug the USB cable and press INSTALL again (it stays in update '
    + 'mode until it is finished).',
  noreturn: 'The FM-1 did not come back. Power-cycle it.',
  mismatch: 'Written, but the FM-1 reports another version: ',
  foreign: 'The FM-1 is waiting in the update mode of M-VAVE\'s own firmware, which may lay the image out differently, '
    + 'so nothing was written. Finish that update with M-VAVE\'s updater first. The FM-1 reports: ',
};

const isLoader = (id: { model: string }) => /^ota-/i.test(id.model);

/**
 * Installs a package on the FM-1, or finishes an install it is waiting in update mode for.
 *
 * @param tune for tests: the updater before it starts (its pause between answers)
 * @returns the identity the FM-1 then runs (the package's)
 * @throws InstallError
 */
export async function installPackage(access: MIDIAccess, fwsc: Uint8Array, onProgress: (p: InstallProgress) => void,
  log: (line: string) => void, tune?: (u: Updater) => void): Promise<string> {
  const product = productOf(fwsc);
  const image = logicalImage(fwsc);
  try {
    checkUfw(image);
  } catch (e) {
    throw new InstallError('badpkg', `The package is damaged: ${e instanceof Error ? e.message : e}`);
  }
  // the bar: the bytes the FM-1 reads for this package (the installer page's spans). Step 1, the running firmware:
  // the header, the loader's head twice, its body. Step 2, the loader: the header, the chip key's check, flash.bin,
  // then the app area again as it writes it; the fast install says its share instead. 99 until the FM-1 is back.
  const ent = ufwEntries(image);
  const fl = ent[0];
  const ldr = ent[100];
  const check = 0x400 + 0x400 + (ldr ? ldr.len - 0x20 : 0);
  const write = fl && fl.len > 0x4000 && fl.len <= 0x100000 ? 0x400 + 0x20 + fl.len + (fl.len - 0x4000)
    : image.length;
  const total = check + write;
  let pct = 0;
  const report = (step: string, p: number) => {
    pct = Math.max(pct, Math.min(step === 'done' ? 100 : 99, Math.floor(p)));
    const text = STEP_TEXT[step];
    if (text) {
      onProgress({ step, pct, text: step === 'verify' || step === 'write' ? `${text} ${pct}%` : text });
    }
  };
  const step: Fm1Step = (k, a, b, share) => {
    if (k !== 'write' || share == null) {
      log(`${k} ${a ?? ''}`.trim());
    }
    if (k === 'verify') {
      report(k, (Math.min(b ?? 0, check) / total) * 100);
    } else if (k === 'write') {
      report(k, ((check + (share == null ? b ?? 0 : (share / 100) * write)) / total) * 100);
    } else if (k === 'done') {
      report(k, 100);
    } else {
      report(k, pct);
    }
  };
  const up = new Updater(access, log);
  tune?.(up);
  try {
    const waiting = await up.find(isLoader);
    if (waiting) {
      waiting.link.close();
      log(`the FM-1 is waiting in update mode (${waiting.id.text}): finishing that install`);
      if (!(await up.resume(image, step, product))) {
        throw Object.assign(new Error('the write did not finish'), { code: 'stopped' });
      }
      return product;
    }
    return await up.install(image, product, step);
  } catch (e) {
    const err = e as Fm1Error;
    if (err.code && FAIL_TEXT[err.code]) {
      throw new InstallError(err.code, FAIL_TEXT[err.code] + (err.code === 'mismatch' || err.code === 'foreign'
        ? err.detail ?? '' : ''));
    }
    throw new InstallError(err.code ?? 'error', err.message ?? String(e));
  }
}
