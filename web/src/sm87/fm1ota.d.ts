// fm1-base's web/fm1ota.js (MPL-2.0, copied as it is): the FM-1's USB-MIDI update over Web MIDI. Its types, for
// what Axs7 uses of it.

/** who a device says it is: "FM-1_8700" (a firmware), "ota-FM-1_870" (its update loader) */
export interface Fm1Identity {
  text: string;
  model: string;
  version: number;
  open?: boolean;
}

export interface Fm1Device {
  link: { close(): void };
  id: Fm1Identity;
  name: string;
}

/**
 * an update's steps: "start" (a: the device), "verify" (a: requests, b: bytes), "loader", "mode" (a: "fast" or
 * "classic"), "write" (a: requests, b: bytes, pct: the fast install's share done), "reboot", "done" (a: the identity)
 */
export type Fm1Step = (step: string, a?: number | string, b?: number, pct?: number) => void;

/** an update's failure: its code (notfound, model, stopped, noloader, lost, noreturn, mismatch, badreq, foreign, open) */
export interface Fm1Error extends Error {
  code?: string;
  detail?: string;
}

/** seven bits a byte, least significant first, as the update protocol packs its frames */
export declare function pack7(data: ArrayLike<number>): number[];
export declare function unpack7(s: ArrayLike<number>): number[];
export declare const HS_FULL: number[];

export declare class Updater {
  constructor(access: MIDIAccess, log?: (line: string) => void);
  /** never the fast install */
  classic: boolean;
  /** ms before each answer of the classic protocol */
  pause: number;
  /** ports found by a HELLO */
  readonly answered: Set<string>;
  allow(name: string): void;
  find(filter?: ((id: Fm1Identity) => boolean) | null, only?: string): Promise<Fm1Device | null>;
  /** running firmware -> loader -> new firmware: the identity it then reports */
  install(image: Uint8Array, product: string, onStep?: Fm1Step, sha256?: string): Promise<string>;
  /** a device already in update mode: true when the write finished (and, with the product, it came back as it) */
  resume(image: Uint8Array, onStep?: Fm1Step, product?: string): Promise<boolean>;
}
