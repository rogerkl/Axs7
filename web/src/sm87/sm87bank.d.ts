// SM-87: samples put into a firmware package (.fwsc) in the browser: sm87bank.js's types.

export declare const SLOTS: 16;
export declare const MAX_WORDS: 32752;
export declare const NPARAM: 155;
export declare const BANK_VERSION: number;
/** a kit's sounds, at most */
export declare const KIT_SOUNDS: 64;
/** its pads */
export declare const PADS: 16;
/** a pad without a sound */
export declare const NO_SOUND: 0xff;
/** the sampler's rate codes (RECBW) */
export declare const RATE_LO: 36;
export declare const RATE_HI: 76;

export type Sm87BankErrorCode =
  | "not-package"   // not a firmware package, or a damaged one
  | "no-bank"       // a firmware that takes no samples this way (SM-87 before the sample bank, another firmware)
  | "format"        // a firmware that reads another format of bank
  | "damaged-bank"  // samples in the package that don't check
  | "stray"         // something above the firmware that isn't samples
  | "too-big"       // more samples than the firmware leaves room for
  | "bad-sample";   // a sample or kit makeBank can't take

export declare class Sm87BankError extends Error {
  readonly code: Sm87BankErrorCode;
  constructor(code: Sm87BankErrorCode, message: string);
}

/** A sample as the bank keeps it */
export interface BankSample {
  /** 0-15 */
  slot: number;
  /** printable ASCII, up to 23 characters (bankName) */
  name: string;
  /** 12-bit offset binary, 0-4095 (2048 silence); 1 to MAX_WORDS of them */
  words: ArrayLike<number>;
  /** the 155 SPRM values (documentation/akai-s700-x7000/02-sample-parameters.md, k 128 included) */
  params: ArrayLike<number>;
  /** 0-99 (default 0) */
  pressure?: number;
}

/** A drum kit's sound: played whole, once, at its rate; the pads tune it */
export interface KitSound {
  /** ASCII, up to 6 characters. An HR-16 dump finds a kit's sounds by their names' starts: KICK, SNARE, TOM,
   * CLHAT, OPHAT, RIDE, CRASH, CLAP (CYMBL for either cymbal) */
  name: string;
  /** 12-bit offset binary, 0-4095; 1 to MAX_WORDS of them */
  words: ArrayLike<number>;
  /** its rate code, RATE_LO-RATE_HI */
  rate: number;
  /** velocity's say in its level, 0-99 (default 60) */
  vel?: number;
}

/** A pad as a kit sets it up */
export interface KitPad {
  /** ASCII, up to 6 characters; empty: "PAD nn" */
  name: string;
  /** the kit's sounds 0.., then the sampler's 16 slots after them; NO_SOUND for none (default) */
  sound?: number;
  /** semitones, -24..24 (default 0) */
  tune?: number;
  /** 0-99 (default 85) */
  level?: number;
  /** -3 (left) .. 3 (default 0) */
  pan?: number;
  /** its MIDI note, in and out on the drum channel (default 36) */
  note?: number;
  /** 0, or a group 1-9: a hit cuts the others of its group (the hats) (default 0) */
  group?: number;
  /** its voices at once: 1 (a hit cuts the last; default) or 2 (the cymbals) */
  poly?: number;
}

/** A drum kit: it replaces the one the firmware was built with, sounds and pads */
export interface Kit {
  /** up to KIT_SOUNDS */
  sounds: KitSound[];
  /** up to PADS, in the pads' order (the white keys from the lowest): hr16Pads makes them */
  pads: KitPad[];
}

/** A sample read from a package */
export interface HeldSample extends BankSample {
  words: Uint16Array;
  params: Uint8Array;
  pressure: number;
}
export interface HeldKit {
  sounds: (KitSound & { words: Uint16Array; vel: number })[];
  pads: Required<KitPad>[];
}
/** What a package holds */
export interface BankContents {
  samples: HeldSample[];
  /** null: the firmware's own kit plays */
  kit: HeldKit | null;
  /** the bank's bytes, its footer with them */
  size: number;
}

/** One of the HR-16's 16 drums and the pad SM-87 plays it on */
export interface Hr16Drum {
  /** its name on the HR-16: KICK, SNARE, CLS HAT, MID HAT, OPN HAT, CLAPS, PERC3, PERC4, TOM1-TOM4, RIDE, CRASH,
   * PERC1, PERC2 */
  drum: string;
  /** SM-87's pad, 0-15 (an HR-16 dump's hits of it go there) */
  pad: number;
  /** the pad's name in a kit (up to 6) */
  name: string;
  /** its MIDI note (General MIDI's) */
  note: number;
  /** the hats' group */
  group?: number;
  /** 2 for the cymbals */
  poly?: number;
}
/** the HR-16's drums in its own order (its dumps', its manual's) */
export declare const HR16_DRUMS: readonly Hr16Drum[];

/** What one of the HR-16's drums plays in a kit: a sound (the kit's, or a slot after them), its tuning, level, pan */
export interface Hr16DrumSound {
  sound: number;
  tune?: number;
  level?: number;
  pan?: number;
}

export declare function crc16(b: Uint8Array): number;
export declare function crc32(b: Uint8Array): number;
export declare function bankName(s: string): string;
export declare function packedSize(words: number): number;
export declare function packWords(words: ArrayLike<number>): Uint8Array;
export declare function unpackWords(packed: Uint8Array, words: number): Uint16Array;
/** A kit's 16 pads from the HR-16's drums, in HR16_DRUMS' order (null: a drum without a sound): each pad named, on
 * its note and in its group as HR16_DRUMS has it */
export declare function hr16Pads(byDrum: readonly (Hr16DrumSound | null)[]): Required<KitPad>[];
/** The bank's bytes: up to 16 samples, one a slot, and a kit or null (the firmware's own plays). Throws
 * Sm87BankError "bad-sample" */
export declare function makeBank(samples: Iterable<BankSample>, kit?: Kit | null): Uint8Array;
/** The bank ending at the end of top: null without one. Throws Sm87BankError "damaged-bank" */
export declare function readBank(top: Uint8Array): BankContents | null;

/** A firmware package opened. The constructor throws Sm87BankError "not-package", "no-bank" or "format" */
export declare class Sm87Package {
  constructor(bytes: Uint8Array | ArrayBuffer, name?: string);
  /** the package's identity, e.g. FM-1_8700 */
  readonly identity: string;
  /** the chip key it is ciphered with */
  readonly key: number;
  /** where the firmware's image ends in its slot, bytes */
  readonly imageEnd: number;
  /** the slot, bytes (581,564) */
  readonly slotSize: number;
  /** the bytes the firmware leaves for samples and a kit */
  readonly room: number;
  /** what it holds, null for none. Throws Sm87BankError "damaged-bank" */
  contents(): BankContents | null;
  /** its samples, null for none */
  samples(): HeldSample[] | null;
  /** its kit, null for none (the firmware's own plays) */
  kit(): HeldKit | null;
  /** a bank (makeBank) into the slot; null or empty for none. Throws Sm87BankError "stray", "too-big",
   * "damaged-bank" */
  put(bank: Uint8Array | null): void;
  /** the package's bytes as it is now: to install, or to save as a .fwsc */
  bytes(): Uint8Array;
}
