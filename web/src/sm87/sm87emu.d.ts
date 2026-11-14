// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 Roger Klaveness
// SM-87: a firmware package's samples handed to its browser emulator by another page of the same site: sm87emu.js's
// types.

/** the emulator's app id: its keys in the browser */
export declare const EMU_ID: "sm87";
/** the emulator's path on the site */
export declare const EMU_PATH: "/sm-87/emu/";
/** the BroadcastChannel the emulators running say so on */
export declare const CHANNEL: "sm87-emu";
/** the window a page opens the emulator in */
export declare const EMU_WINDOW: "sm87-emu";

/** The samples as the emulator keeps them */
export interface EmuSamples {
  /** the package's file name */
  name: string;
  /** the bank's bytes as the package holds them (Sm87Package.bank) */
  bank: ArrayBuffer;
  /** its samples */
  samples: number;
  /** its kit's sounds, 0 for none (the firmware's own kit plays) */
  kit: number;
}

/** the emulator's address on this site */
export declare function emuUrl(origin?: string): string;
/** A package's samples as the emulator keeps them. Throws Sm87BankError (its message says why), or Error for a
 * package without samples */
export declare function emuSamples(bytes: Uint8Array | ArrayBuffer, name: string): EmuSamples;
/** what they hold: "5 samples, a drum kit of 8 sounds" */
export declare function emuHolds(k: EmuSamples): string;
/** the samples kept for the emulator, or undefined */
export declare function keptSamples(id?: string): Promise<EmuSamples | undefined>;
/** keep them: what the emulator plays from its next start */
export declare function keepSamples(k: EmuSamples, id?: string): Promise<void>;
/** forget them: the emulator's own again */
export declare function forgetSamples(id?: string): Promise<void>;

/** The emulator's side, once switched on: it says it is there, and onSamples() when another page has kept samples
 * for it. alive: an EventTarget whose "message" events say it is there too (the worklet's port). Returns a function
 * that stops it (it says it's gone) */
export declare function emuAnnounce(id: string, onSamples: () => void, alive?: EventTarget): () => void;

export interface EmuWatch {
  /** an emulator switched on, heard from lately */
  running(): boolean;
  /** tell the emulators running that the samples kept for them changed: they start again with them */
  tell(): void;
  close(): void;
}
/** Another page's side: which emulators are running. Open it a while before running() is asked */
export declare function emuWatch(id?: string): EmuWatch;

/** A page's "open in the emulator", called in its click's handler (a window is opened at once): make() gives the
 * samples (null: none to give), kept for the emulator. "told": an emulator running starts again with them; "opened":
 * the emulator opened in its window, which plays them as it is switched on; "blocked": no window may be opened (they
 * are kept, for the emulator opened by hand); null: make() gave none. Throws what make() or keeping them throws */
export declare function openInEmulator(watch: EmuWatch, make: () => Promise<EmuSamples | null> | EmuSamples | null,
  options?: { id?: string; url?: string }): Promise<"told" | "opened" | "blocked" | null>;
