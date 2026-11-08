# X7000 lab

Measures how the sampler sounds: test samples go to it by sample dump, their settings change between notes with
the S700's parameter message (SPRM), and its output is recorded and analysed. The results, and how the engine
follows them, are in `doc/x7000-measurements.md`.

## Setup

- A MIDI interface to the sampler's MIDI in and out (an ESI M4U XT here, port 1), attached to WSL with usbipd: raw
  MIDI on `/dev/snd/midiC*D0` works over USB/IP.
- An audio interface for the sampler's output (a Focusrite Scarlett 2i2 here, input 1) **on Windows, not attached
  to WSL**: USB/IP drops most of an audio interface's packets. Windows' ffmpeg records it through WSL interop
  (DirectShow, 16 bit at 48 kHz). `LAB_AUDIO` names another device.
- The web app's packages installed (`npm --prefix web install`): the scripts are built with its esbuild, and use its
  protocol code.

The scripts use slots 2 and 3, alone in program 32 (the sampler is switched to it): whatever is there is replaced.
Recordings go to `LAB_DATA` (default `../axs7-lab` beside the repo).

## Scripts

    node tools/x7000-lab/run.mjs probe [slots]           # every slot's parameters, read only
    node tools/x7000-lab/run.mjs params <slot> [--save name] [--diff name]   # a slot's bytes, to find a setting
    node tools/x7000-lab/run.mjs tone [note] [velocity]  # one note and its level, for the input gain
    node tools/x7000-lab/run.mjs measure <experiment>... [--resend]
    node tools/x7000-lab/run.mjs analyze <experiment>... [--as <analysis>] [--peek <tag>]
    node tools/x7000-lab/run.mjs simulate <experiment>...  # the same notes through web/public/engine.wasm
    LAB_DATA=../axs7-lab/simulated node tools/x7000-lab/run.mjs analyze <experiment>...

The experiments (`experiments.ts`): pilot, filter, velfilter, level, vellevel, release, release2, velrelease,
velrelease2, lfospeed, lfodepth, lfodelay, lfodelay2, lfofine, pressure, sens (aftertouch at another PRESSURE, set on
the panel: it isn't in SPRM), scan. Each is a series of notes after a sync note that the analysis finds the others
by. The analysis flags a note that starts while the one before still sounds: the sampler takes the first free voice,
and voices differ a little.

Files: `midi.ts` (raw MIDI), `record.ts` (Windows ffmpeg), `sampler.ts` (dumps, SPRM, notes), `experiments.ts`,
`measure.ts`, `dsp.ts` (FFT, envelopes), `analyze.ts`, `simulate.ts`, `probe.ts`, `params.ts`, `tone.ts`.
