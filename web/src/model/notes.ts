// Note names as the sampler has them: C3 is MIDI note 60.

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const OFFSET = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as const;

export function noteName(note: number): string {
  return NAMES[((note % 12) + 12) % 12] + (Math.floor(note / 12) - 2);
}

export function isBlackKey(note: number): boolean {
  return NAMES[((note % 12) + 12) % 12].length > 1;
}

/** @returns the MIDI note for a name like C3, F#1, Bb-1 or a number, null if it isn't one */
export function parseNote(text: string): number | null {
  const t = text.trim();
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    return n <= 127 ? n : null;
  }
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(t);
  if (!m) {
    return null;
  }
  const base = OFFSET[m[1].toUpperCase() as keyof typeof OFFSET];
  const note = (Number(m[3]) + 2) * 12 + base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return note >= 0 && note <= 127 ? note : null;
}
