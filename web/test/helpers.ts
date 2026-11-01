import { readFileSync } from 'node:fs';
import { BW16 } from '../src/protocol/akai';

export const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`fixtures/${name}`, import.meta.url)));

/** The test sine of the Java HardwareLoopback: rising amplitude, in doubles to encode like the Java version */
export function testSine(rate = BW16.rate, numSamples = 6000, frequency = 440): Float64Array {
  const data = new Float64Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    data[i] = Math.sin((2 * Math.PI * frequency * i) / rate) * (0.2 + (0.7 * i) / numSamples);
  }
  return data;
}

/**
 * The rules Chrome's MIDIOutput.send() checks a message with (Blink's MessageValidator), for the parts that matter
 * here. Returns why it would throw, or null if it would send.
 */
export function chromeRejects(bytes: Uint8Array): string | null {
  const reserved = (b: number) => b === 0xf4 || b === 0xf5 || b === 0xf9 || b === 0xfd;
  const realTime = (b: number) => b >= 0xf8 && !reserved(b);
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (realTime(b)) {
      i++;
    } else if (!(b & 0x80)) {
      return 'Running status is not allowed';
    } else if (b === 0xf7) {
      return 'Unexpected end of system exclusive message';
    } else if (reserved(b)) {
      return 'Reserved status is not allowed';
    } else if (b === 0xf0) {
      for (i++; ; i++) {
        if (i >= bytes.length) {
          return 'System exclusive message is not ended by end of system exclusive message.';
        }
        const c = bytes[i];
        if (reserved(c)) {
          return 'Reserved status in system exclusive message';
        }
        if (c === 0xf7) {
          i++;
          break;
        }
        if (c & 0x80 && !realTime(c)) {
          return 'System exclusive message contains a status byte';
        }
      }
    } else {
      i += b < 0xf0 ? [3, 3, 3, 3, 2, 2, 3][(b >> 4) - 8] : [0, 2, 3, 2, 0, 0, 1][b - 0xf0];
    }
  }
  return null;
}
