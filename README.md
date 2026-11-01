# Axs7 virtual sampler

A sampler in the browser with multi-sample programs, that sends and receives samples to and from an Akai
X7000/S700 over Web MIDI. Its look is loosely based on the X7000's front panel.

It is a rewrite and enhancement of the Java program [Axs7Sds](https://github.com/rogerkl/Axs7Sds). 
Samples are loaded or received into memory and played from the on-screen keyboard, the computer keyboard or a MIDI keyboard (the X7000's own works).

## What it does

- **Memory**: samples from WAV files (the loop in a WAV `smpl` chunk is kept) or other audio files, or received
  from a slot on the sampler. Not limited like the sampler's memory, and kept in the browser between visits
  (samples in IndexedDB, programs in localStorage).
- **Edits that lose nothing**: a sample keeps its original as loaded, and its edits (RESAMPLE, NORMALIZE, 12 BIT,
  ATTACK, CROSSFADE) are settings. Whenever one of them or a point changes, the sample is rendered again from the
  original, so normalizing after moving START, or going back to the original's rate, loses nothing. What plays,
  what the waveform shows and what is sent is the rendered sample. RESET EDITS goes back to the original. A loaded
  file starts normalized, and at the nearest sampler rate with RATE ON LOAD = SAMPLER.
- **From the sampler**: a received sample is sent back as it came, so it gets no edits (its points, scan,
  direction and sound can still be set). It is marked FROM THE SAMPLER, and stays so in its WAV files (an `axs7`
  chunk, which other programs skip) and banks, so loading it again keeps it unedited.
- **START and END**: the part of a sample that is used, to take a portion out of a long one. Playing starts at
  START, a one shot ends at END, the loop stays between them (moving START or END pushes it along), and only that
  part is sent to the sampler, which has no start point of its own.
- **Waveform**: START and END (tags S, E) and the loop (LS, LE) are dragged on it, and a grabbed point's parameter
  is selected, so the knob or the arrow keys then move it a sample at a time. The mouse wheel zooms around the
  pointer (in to single samples), dragging or shift + wheel pans, a double click zooms in, and buttons zoom to each
  point. The overview under it shows where the view is. It shows playback heads of the voices playing the sample
  (from PLAY, the keyboards or MIDI), what isn't used or kept (dimmed), and the sampler's length limit from START
  (SAMPLER LIMIT).
- **Sampler rates**: the sampler plays samples at 41 rates a semitone apart (39555.4 Hz down to 3924.38 Hz).
  Samples at other rates are marked (`44.1K!`), and so are samples the sampler can't take whole: it takes 32752
  samples, and ends a looped sample at its loop end, so a long sample fits if its loop end is before the limit.
  RESAMPLE TO renders a sample at one of the sampler's rates, like the resample function on a sampler: to make it
  compatible, or at a lower rate so a longer sample fits. OWN keeps the original's rate. The points stay at the
  same times and keygroups keep playing it at the same pitch. RATE ON LOAD sets files to the nearest sampler rate
  when they are loaded (SAMPLER, the default), or keeps their own rate (KEEP). A WAV file at a sampler rate (whole
  Hz in the file, like 39555) gets the exact rate.
- **AS SENT**: the sample as the sampler will have it, to hear it that way: NORMALIZE (the part between START and
  END to full level) and 12 BIT (the values the sampler keeps, rendered last). A sample is sent as it sounds, made
  12 bit if it isn't; a 12 bit one, made so or received from the sampler, is sent as it is, so a received sample
  goes back bit for bit. WAV files and banks keep 12 bit values exact.
- **Attack**: the X7000 has no attack setting, so ATTACK renders one into the sample: what is played first fades in
  from silence, LIN or CURVE, from START (from END when reversed), ending before the loop. LENGTH 0 is off.
- **Crossfade loop**: fades the end of a forward loop into what comes before the loop start, so the jump back to
  the start doesn't click (the Java tool's X-fade). LENGTH in ms, SHAPE linear (for a steady sound) or equal power
  (keeps the level when the two sides differ, like noise), 0 is off. The two regions are shown on the waveform.
  It is rendered before the attack, so it fades into the audio as it was.
- **Scan modes** (SCAN), as on the X7000: ONE shot (stops at key off), LOOP, ALT (alternating), DRUM trigger (plays
  to its end whatever the key does). A drum trigger goes to the sampler as a one shot.
- **Direction** (DIR), the X7000's SCAN DIRECTION: REV plays from END back to START, and a loop mirrored (it plays
  back into the loop and repeats it backwards). The direction isn't part of a sample dump, so a reversed sample is
  sent reversed, to sound the same on the sampler with its direction at F. The sampler's limit, what it drops and
  the crossfade go the other way too.
- **OUT**, a sample's sound, as on the X7000: LEVEL, FILTER (a lowpass without resonance) and RELEASE (for looping
  and alternating samples), each with how much velocity changes it (velocity raises the cutoff, softer notes get a
  shorter release). No attack or filter envelope, like the X7000.
- **LFO**, a sample's vibrato: SPEED, DEPTH, DELAY. The modulation wheel adds vibrato too, and so does MIDI
  aftertouch (channel or polyphonic), as deep as the sample's PRESSURE (the X7000's pressure sens), at once without
  the delay. AFTERTOUCH IN shows what the keyboard sends (the X7000's own keyboard has no aftertouch).
- **Programs** (PROGRAM): keygroups, each a sample over a key range with root, semitones and fine tune, and PITCH
  FIXED for the X7000's constant pitch (every key at the root's pitch). The sound is the sample's, so every program
  playing a sample sounds the same, as on the X7000. 6-32 voices (the X7000 has 6). Parameters are 0-99 like on
  the sampler, and note names follow it: C3 = MIDI 60.
- **Transfers**: receive a sample slot from the sampler, send the selected sample to one. The slot is chosen in
  the app, with SLOT ▲▼ next to RECEIVE and SEND (also in the SAMPLE and MIDI views), nothing needs to be set on
  the sampler: the slot number goes in the dump request and in the header of a sent dump. How many slots the
  sampler has is set with SLOTS in the MIDI view: 6 on a standard X7000, more with a memory expansion (tested
  receiving and sending slot 7 on an X7000 with 16). Samples are
  resampled to the nearest of the sampler's rates and limited to its 32752 samples when sent.
- **Banks**: the whole memory saved and loaded as a zip file: `bank.json` with the programs and each sample's
  settings and edits, each sample as a WAV file with its loop (as it sounds), and the original of an edited sample
  in `originals/`, so editing goes on from it after loading.

Editing works like on the sampler: select a parameter, then turn the data knob. Parameters also change with the
mouse wheel, by dragging up and down, or with the arrow keys (shift for bigger steps). Double click a value to
type it, notes can be typed as names like `F#2`. A keygroup's LOW, HIGH and ROOT can also be set by playing the
note while they are selected, from the screen, the computer keys or a MIDI keyboard. A note played for LOW moves
on to HIGH, so a range is two notes. The computer keys `A W S E D F T G Y H U J K O L P` play, `Z` and
`X` change octave.

## Running

Needs Rust with the wasm target (`rustup target add wasm32-unknown-unknown`) and Node.js.

    cd web
    npm install
    npm run dev

Open http://localhost:5173 in Chrome or Edge. The dev server listens on all interfaces, so from WSL the Windows
browser reaches it on the same address. Use `localhost`: Web MIDI only exists on a secure origin, so from the WSL
IP the page loads without MIDI. Close the Java tool or a DAW using the MIDI ports first.

`npm run build` makes a static build in `web/dist` that can be served from anywhere.

## Publishing

Publishing a release on GitHub builds the app, runs the tests and publishes it to GitHub Pages, at
https://rogerkl.github.io/Axs7/ (`.github/workflows/pages.yml`). It can also be run by hand from the Actions tab.
Set up once in the repository settings: Pages, Source = GitHub Actions; and Environments, `github-pages`, a Tag
rule for the release tags (like `v*`) under Deployment branches and tags, as only the default branch may deploy
there at first and a release runs on its tag.

## Structure

- `engine/`: the voice engine in Rust (sample playback with forward and alternating loops, filter, envelopes).
  Compiled to a wasm module without imports or wasm-bindgen, and run in an AudioWorklet. Sample editing in Rust
  (`dsp.rs`, the crossfade loop and the attack) runs in a second instance of the same module on the main thread
  (`web/src/audio/dsp.ts`).
- `web/src/protocol`: the X7000 sample dump protocol and WAV files.
- `web/src/midi`: Web MIDI ports and the transfers. A browser only delivers a sysex message when it is complete,
  and only sends complete ones, so a received dump arrives in one piece while ACKs are sent blind at a fixed pace,
  scheduled ahead with timestamps, and a dump is sent as one message without waiting for ACKs between blocks.
  Verified on an X7000.
- `web/src/model`: samples, programs and keygroups, rendering a sample from its original and edits, IndexedDB
  storage, banks. `web/src/app/renderer.ts` renders a sample again when its edits or points change.
- `web/src/audio`: the AudioWorklet, the engine's main thread side, and the player.
- `web/src/ui`, `web/src/app`: the front panel, views and actions.
- `spike/`: the Web MIDI test page used to verify the transfers on the sampler.

## Tests

    cargo test              # the engine and sample editing
    cd web && npm test      # builds the engine, then protocol, model, banks, transfers and the Rust DSP from TypeScript

The protocol tests use a dump received from a real X7000 and check sent dumps byte for byte against the Java
version's encoder. The transfer tests run against a simulated sampler that delivers sysex like Chrome does.

## License

MIT, see [LICENSE](LICENSE).
