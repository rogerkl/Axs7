// QuickDisk images (.qd), as the HxC floppy emulator and FlashFloppy (on a Gotek) use them for the 2.8" QuickDisk
// drives of the Akai S612, S700 and X7000.
//
// An image is one track of MFM cells, the whole spiral of a disk side: a 512 byte header, a track table at 512 and the
// cells from the offset in it, 8 to a byte, first cell in the lowest bit, at 4.917 µs each. FlashFloppy only checks
// for "QD" at byte 3 of the header ("HXCQDDRV" or "\0\0\0QD").
//
// On the track, a block of data starts with a run of 1 bits, then the SYN bytes 16h and a marker A5h. Data bits are
// MFM: a clock cell and a data cell each, bytes least significant bit first. A CRC-16 (polynomial 8005h, reflected,
// from 0: CRC-16/ARC) over the bytes from the marker on, itself included, comes out 0.

export const QD_SYNC_BYTES = 7;
export const QD_SYNC = 0x16;
export const QD_MARKER = 0xa5;
const TRACK_TABLE = 0x200;

/** True if the bytes look like a QuickDisk image */
export function isQdImage(bytes: Uint8Array): boolean {
  return bytes.length > TRACK_TABLE + 16 && bytes[3] === 0x51 && bytes[4] === 0x44; // "QD"
}

/**
 * The track's cells, one per byte (0 or 1), in the order they pass the head
 *
 * @throws Error if it isn't a QuickDisk image
 */
export function qdCells(bytes: Uint8Array): Uint8Array {
  if (!isQdImage(bytes)) {
    throw new Error('Not a QuickDisk image');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getUint32(TRACK_TABLE, true);
  const length = Math.min(view.getUint32(TRACK_TABLE + 4, true), bytes.length - offset);
  if (offset < TRACK_TABLE + 16 || length <= 0) {
    throw new Error('The QuickDisk image has no track');
  }
  const cells = new Uint8Array(length * 8);
  for (let i = 0; i < length; i++) {
    const b = bytes[offset + i];
    for (let k = 0; k < 8; k++) {
      cells[i * 8 + k] = (b >> k) & 1;
    }
  }
  return cells;
}

/** The cells MFM gives bytes, after a cell `previous` (the data cell before them) */
export function mfmCells(bytes: ArrayLike<number>, previous = 0): Uint8Array {
  const cells = new Uint8Array(bytes.length * 16);
  let last = previous;
  for (let i = 0; i < bytes.length; i++) {
    for (let k = 0; k < 8; k++) {
      const bit = (bytes[i] >> k) & 1;
      // a clock cell between two 0 bits, none next to a 1
      cells[i * 16 + 2 * k] = bit === 0 && last === 0 ? 1 : 0;
      cells[i * 16 + 2 * k + 1] = bit;
      last = bit;
    }
  }
  return cells;
}

/** The bytes in the cells from `at` on, as many as there are up to `count` */
export function mfmBytes(cells: Uint8Array, at: number, count: number): Uint8Array {
  const n = Math.max(0, Math.min(count, Math.floor((cells.length - at) / 16)));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let k = 0; k < 8; k++) {
      v |= cells[at + i * 16 + 2 * k + 1] << k;
    }
    out[i] = v;
  }
  return out;
}

/**
 * The cells of the sync bytes and the marker that start every block. The first clock cell depends on the bit before
 * the block, so the pattern starts at the first data cell.
 */
const SYNC_CELLS = mfmCells([...new Array<number>(QD_SYNC_BYTES).fill(QD_SYNC), QD_MARKER]).subarray(1);

/** @returns where each block starts on the track: the first cell of its first sync byte */
export function findBlocks(cells: Uint8Array): number[] {
  const found: number[] = [];
  // a window of the last 32 cells, matched against the start of the pattern before comparing all of it
  let head = 0;
  for (let k = 0; k < 32; k++) {
    head = ((head << 1) | SYNC_CELLS[k]) >>> 0;
  }
  let window = 0;
  for (let p = 0; p + SYNC_CELLS.length - 32 < cells.length; p++) {
    window = ((window << 1) | cells[p]) >>> 0;
    const at = p - 31;
    if (at >= 1 && window === head) {
      let match = true;
      for (let k = 0; k < SYNC_CELLS.length && match; k++) {
        match = cells[at + k] === SYNC_CELLS[k];
      }
      if (match) {
        found.push(at - 1);
      }
    }
  }
  return found;
}

/** CRC-16/ARC: polynomial 8005h reflected, from 0 */
export function crc16(bytes: ArrayLike<number>, from = 0, to = bytes.length): number {
  let crc = 0;
  for (let i = from; i < to; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc;
}
