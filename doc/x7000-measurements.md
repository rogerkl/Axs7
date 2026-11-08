# How the X7000 sounds: measurements

What the sampler's OUT and LFO settings do, measured on an X7000 (with the 16 slot memory board) in November 2026,
and how the app's engine follows it. The measurements were made with `tools/x7000-lab`: test samples sent by sample
dump, their settings changed by the S700's parameter message (SPRM) between notes, the output recorded through an
audio interface and analysed. The same notes played through the app's engine give nearly the same results
(`simulate`, see the lab's README).

The test samples were noise and a 989 Hz sine at the sampler's top rate (39555 Hz, rate code 76), looped, alone in
program 32. Levels are relative: the interface's gain is arbitrary.

## Level

- **LEVEL** is linear in dB: 0.345 dB a step, 0 dB at 99, **-34.2 dB at 0** (not silent).
- **VEL>LEVEL** mixes, in dB, a level that ignores velocity with one that rises in a straight line with it:
  `dB = (1 - a) × -7.7 + a × -40.3 × (1 - (velocity - 1) / 126)`, `a = VEL>LEVEL / 99`. So at VEL>LEVEL 0 a note is
  7.7 dB under the loudest the sampler plays (full velocity at VEL>LEVEL 99), at 99 it spans 40 dB from velocity 1
  to 127. Measured and model agree within 1 dB.
- Notes start at once: full level within the first millisecond, at any velocity.

## Filter

- A **6-pole Butterworth lowpass** (36 dB an octave, no resonance): 3 dB down at the cutoff, 37 at twice it, 73 at
  four times. It is a switched capacitor filter: its clock (50 × the cutoff) shows in the output at low settings,
  a line at 15.7 kHz at FILTER 0.
- **FILTER** sets the cutoff exponentially: `306 Hz × 2^(FILTER / 17.3)`, 306 Hz at 0, 1 kHz at 30, 3.4 kHz at 60,
  16.2 kHz at 99 (open). Within ±0.9 semitone of the measured, which zigzags a little from step to step.
- It doesn't follow the key: FILTER 60 is 3.5 kHz played from C1 to B2.
- **VEL>FILTER** moves the cutoff from **velocity 64** either way: `FILTER + VEL>FILTER × (velocity - 64) / 64`, in
  FILTER steps, within 0-99. At velocity 64 it is the cutoff set; at VEL>FILTER 99 the velocities span the whole
  range.

## Release

- Exponential (a straight line in dB). The time to fall 60 dB doubles every 10 steps: 17 ms at 0, 0.14 s at 30,
  0.57 s at 50, 2.3 s at 70, 4.6 s at 80. It comes in steps: 22.8 s over a whole number that halves every 10 and
  falls in a straight line between, at least 2, so 5.7 s at 82-84, 7.6 s at 86-88 and **11.4 s from 90 to 99**.
- **VEL>RELEASE follows the note off's velocity**, how fast the key comes up, not the note on's:
  `RELEASE + VEL>RELEASE × (64 - off velocity) / 64`, in RELEASE steps, within 0-99. A note off at 64 (or a note on
  at velocity 0, which counts as 64) leaves the release as set; 0 makes it longer, 127 shorter.
- The release applies to **one shots** too (the manual has it for looping sounds only). A drum trigger plays to its
  end whatever the key and RELEASE do. A one shot held past its end stops there.

## Vibrato (LFO)

- A **sine**, starting at key on from the middle going up.
- **SPEED** is linear in Hz: `1.65 + 0.0634 × SPEED`, 1.7 Hz at 1 to 7.9 Hz at 99. **0 stops the LFO.** For a
  sample played two octaves under its rate it ran 4 % faster (the sampler's processor less busy, probably).
- **DEPTH** comes in **8 steps**, 6.4 cents apart: none up to 12, then ±9, 15, 22, 28, 34, 41 and **±47 cents**
  from 89. The step is `floor(8 × DEPTH / 101)`.
- **DELAY** brings the vibrato in a step at a time from key on: a step every `2.35 / (100 - DELAY)` seconds, 24 ms
  at 0, 0.12 s at 80, 0.47 s at 95, 2.35 s at 99. So a deeper vibrato takes longer to come in.
- **Channel aftertouch** adds vibrato at once (no delay), a step for each sixteenth of the pressure at **PRESSURE**
  (the pressure sens, on the LFO page) 99: `floor(floor(aftertouch / 16) × PRESSURE / 99)` steps, 3 at most at 50.
  PRESSURE isn't in the sample's parameters (SPRM), so it can't be sent or read over MIDI.
- The **modulation wheel** (controller 1) adds a step for each sixteenth of its travel, ±47 cents at full, whatever
  PRESSURE is.
- **Polyphonic aftertouch does nothing.**
- With DEPTH and aftertouch together the vibrato is about their sum; at the top it is off by up to ±5 cents
  (DEPTH 30 with aftertouch 96 gave ±51 cents, with 127 ±68).

## The engine

`engine/src/filter.rs` (Butterworth6), `engine/src/voice.rs` (velocity_gain, velocity_cutoff, velocity_release,
vibrato_depth) and `web/src/model/params.ts` (the 0-99 tables) follow the above. Not modelled: the filter's clock
and aliasing at low cutoffs, the 0.7 dB the filter takes off below its cutoff, the LFO's speed with the playing rate,
the steps within a vibrato cycle (the sampler's pitch moves in steps of a few cents), and the combined depth at the
top.

## Voices

The X7000 seems to give a note the first free voice. One voice of the measured unit (voice 5) is faulty, so the
notes were spaced to keep to one or two voices. Two voices' releases differed by 2.5 % (11.1 and 11.4 s).
