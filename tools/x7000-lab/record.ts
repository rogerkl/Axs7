// Recording the sampler's output: the Scarlett is used from Windows (USB/IP to WSL drops most of an audio
// interface's isochronous packets), with Windows' ffmpeg through WSL interop. DirectShow gives 16 bit at most.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

export const RATE = 48000;
export const DEVICE = process.env.LAB_AUDIO ?? 'Analogue 1 + 2 (Focusrite USB Audio)';
/** where Windows' ffmpeg writes, as WSL sees it */
const DIR = process.env.LAB_TMP ?? '/mnt/c/Users/klarog/AppData/Local/Temp/axs7-lab';

export interface Recording {
  /** stops it, the WAV file's path */
  stop(): Promise<string>;
}

function windowsPath(path: string): string {
  return spawnSync('wslpath', ['-w', path], { encoding: 'utf8' }).stdout.trim();
}

/** Starts recording, resolves once ffmpeg has the device open and is writing */
export async function startRecording(name: string): Promise<Recording> {
  fs.mkdirSync(DIR, { recursive: true });
  const file = `${DIR}/${name}.wav`;
  fs.rmSync(file, { force: true });
  const ff = spawn('ffmpeg.exe', ['-hide_banner', '-nostats', '-f', 'dshow', '-sample_rate', String(RATE),
    '-sample_size', '16', '-channels', '2', '-audio_buffer_size', '10', '-i', `audio=${DEVICE}`, '-c:a', 'pcm_s16le',
    '-y', windowsPath(file)], { stdio: ['pipe', 'ignore', 'pipe'], cwd: '/tmp' });
  let err = '';
  const exited = new Promise<number>((resolve) => ff.on('exit', (code) => resolve(code ?? -1)));
  await new Promise<void>((resolve, reject) => {
    ff.stderr.on('data', (d: Buffer) => {
      err += d.toString();
      if (/Press \[q\]|Output #0/.test(err)) {
        resolve();
      }
    });
    exited.then((code) => reject(new Error(`ffmpeg.exe stopped (${code}): ${err.slice(-500)}`)));
  });
  // the device delivers from now on; a little more so nothing is missed
  await new Promise((r) => setTimeout(r, 300));
  return {
    async stop() {
      ff.stdin.write('q');
      ff.stdin.end();
      const code = await exited;
      if (!fs.existsSync(file)) {
        throw new Error(`No recording (${code}): ${err.slice(-500)}`);
      }
      return file;
    },
  };
}

/** The first channel of a 16 bit WAV file, -1..1 */
export function readWav(path: string): { rate: number; data: Float32Array; channels: number } {
  const b = fs.readFileSync(path);
  let p = 12;
  let rate = RATE;
  let channels = 2;
  while (p < b.length - 8) {
    const id = b.toString('ascii', p, p + 4);
    const len = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      channels = b.readUInt16LE(p + 10);
      rate = b.readUInt32LE(p + 12);
    } else if (id === 'data') {
      const frames = Math.floor(Math.min(len, b.length - p - 8) / (2 * channels));
      const data = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        data[i] = b.readInt16LE(p + 8 + i * 2 * channels) / 32768;
      }
      return { rate, data, channels };
    }
    p += 8 + len + (len & 1);
  }
  throw new Error(`No data in ${path}`);
}
