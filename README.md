# Axs7 virtual sampler

A sampler in the browser with multi-sample programs, that sends and receives samples to and from an Akai S700 or
X7000 over Web MIDI. The two are the same sampler, the S700 as a rack and the X7000 with a keyboard, so both are called
*the sampler* here. Its look is loosely based on the sampler's front panel.

It is a rewrite and enhancement of the Java program [Axs7Sds](https://github.com/rogerkl/Axs7Sds).

**Use it at https://rogerkl.github.io/Axs7/** (Chrome or Edge). **How to use it is in the
[wiki](https://github.com/rogerkl/Axs7/wiki).**

- Receive and send samples to and from any slot of the sampler, with their settings (START, END, loop, scan
  mode, sound) and their key ranges in the sampler's programs, one slot or a whole bank at a time.
- Load WAV and other audio files, and the sampler's and the S612's QuickDisk images (`.qd`, as a Gotek or HxC floppy
  emulator uses them). Save samples as WAV files or disk images, and everything as a memory file.
- Edit without losing anything: points on a zoomable waveform, resampling to the sampler's rates, normalizing, 12 bit,
  a rendered attack and a crossfade loop.
- Programs of keygroups in banks of 32 programs, and the sampler's sound settings (OUT and LFO), played from the
  screen, the computer keyboard or a MIDI keyboard, also the X7000's own.
- Samples and a drum kit built into SM-87, a firmware for the M-VAVE FM-1 with an S700/X7000 style sampler and an
  HR-16 style drum machine: a SAMPLES bank and a DRUMS bank of the HR-16's 16 drums, put into its firmware package
  and installed on the FM-1 over USB, with a meter of the room they take.

## Technical notes

- **Transfers** use the sampler's sample dump messages. A browser only delivers a sysex message when it is complete,
  and only sends complete ones, so a received dump arrives in one piece while ACKs are sent blind at a fixed pace
  (ACK MS), scheduled ahead with timestamps, and a sent dump goes as one message without waiting for ACKs between
  blocks. Verified on an X7000.
- **Sample parameters** use the sampler's Akai exclusive messages, from Akai's "MIDI system exclusive data format for
  S700": a request (RSPRM) answered with the parameters (SPRM). Tested on an X7000, it answers on channel 1 with
  identifier 41h (the document's "65", decimal), and takes SPRM to set them. They
  carry what a dump doesn't: START and END, the loop, scan mode, direction, rate, sound and the key range in each of
  the 32 programs. The rate is taken from them, as one dump from the sampler had no usable period in its header.
- **The sampler only dumps START to END.** With RECEIVE ALL, RECEIVE sets START to 0 and END to 32752 with SPRM, receives
  the whole slot, then sets them back and reads them again to check. The header of such a dump counts END - START
  words. The kept word after START in the parameters is END - START - 1, as the sampler sends it.
- **An empty slot** on the sampler has a test tone in no program (usually START 0, END 360, but not always after
  switching on), so RECEIVE BANK passes over any slot in no program.
- **Sampler rates**: 41 rates a semitone apart, each a whole number of ns per sample: 25281 ns (39555.4 Hz) down to
  254817 ns (3924.38 Hz). The parameters' rate code is close to 26400 Hz × 2^((code - 69) / 12), codes 36 to 76. At
  most 32752 samples, 12 bit.
- **QuickDisk images**: a disk of the sampler holds one sample with its parameters, laid out as the sample parameter
  message has them. Saved images are laid out on the track as the sampler writes a disk: the 96 regular disks of a real library
  come out cell for cell. S612 disks hold their audio at 31250 Hz; their 32 bytes of settings aren't decoded yet.
- **Edits** are a recipe rendered from the sample's original whenever an edit or a point changes, so nothing is lost
  until APPLY EDITS writes them into a new original.
- **Banks, slots and key ranges** follow the sampler: a sample's key ranges in the 32 programs are the sample's (they
  are in its parameters there), so a bank's program is the keygroups of the samples in its slots. A sample is in one
  slot of one bank or in none, and one put in a slot leaves the sample there in no bank, with its keygroups kept.
- **Storage**: samples in IndexedDB; banks, settings, and each sample's bank, slot and keygroups in localStorage, so
  a keygroup changed doesn't write the audio again. A memory file is a zip with `memory.json` (the banks, SLOTS, and
  each sample's settings, edits, bank, slot and keygroups), each sample as a WAV file, and the originals of edited samples
  in `originals/`. Memory kept or saved before samples had their bank and slot (the banks had the slots and the
  keygroups) is moved over when it loads. WAV files saved here carry their settings, slot and key ranges as JSON in
  an `axs7` chunk, which other programs skip.
- **SM-87** (`src/model/sm87.ts`): INIT SM-87 BANKS (BANK view) makes two banks, marked as SM-87's. The SAMPLES
  bank's samples go in SM-87's slots as the sampler keeps them (as a disk has them, up to END). The DRUMS bank's
  P1-P16 are the HR-16's drums; PROGRAM edits them as drums: one keygroup each, no FINE, a LEVEL and a PAN. A drum
  is its first keygroup's sample from START to END, played once, tuned as C3 plays it here in whole semitones, at the
  drum's LEVEL (until set, the sample's; on the same curve, so it plays here so too); they make a kit that replaces
  the firmware's. OPEN FIRMWARE takes SM-87's package (.fwsc); SAVE PACKAGE
  puts both banks into it as they are (the firmware's checksums made again) and saves it, INSTALL ON FM-1 puts them
  in and installs it on the FM-1 over Web MIDI, as fm1-base's installer page does (`src/app/sm87install.ts`): the
  running firmware checks the package and starts its update loader, which writes it, and an FM-1 found waiting in
  update mode has that install finished. Only the firmware's part of the flash is written. TAKE ITS SAMPLES brings
  what a package holds back into the two banks (`sm87Taken`): its samples as a disk brings them, its kit's sounds as
  drum samples with the drums' keygroups, tuning and pans, so a release's built-in samples go into the next release's
  package the same, byte for byte. `src/sm87/sm87bank.js` is
  SM-87's `web/sm87bank.js`, and `fm1ota.js`, `fm1ports.js` and `fm1pkg.js` beside it are fm1-base's `web/` files
  (MPL-2.0, under their own licence), copied as they are: a test checks each copy is the same when SM-87's repository
  is beside this one. The rules are SM-87's `documentation/sample-bank.md`.

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
- `web/src/protocol`: the sampler's sample dump protocol and sample parameter messages (`sprm.ts`), WAV files, and
  QuickDisk images (`qd.ts`: the track, MFM and CRC; `s700disk.ts`: the sampler's disk format; `s612disk.ts`: the
  S612's).
- `web/src/midi`: Web MIDI ports and the transfers (see Technical notes).
- `web/src/model`: samples, banks, programs and keygroups, rendering a sample from its original and edits, IndexedDB
  storage, memory files, and the sampler's sample parameters as a sample (`s700.ts`). `web/src/app/renderer.ts` renders a sample again when its edits or points change.
- `web/src/audio`: the AudioWorklet, the engine's main thread side, and the player.
- `web/src/ui`, `web/src/app`: the front panel, views and actions.
- `spike/`: the Web MIDI test page used to verify the transfers on the sampler.

## Tests

    cargo test              # the engine and sample editing
    cd web && npm test      # builds the engine, then protocol, model, memory files, transfers and the Rust DSP from TypeScript

The protocol tests use a dump received from a real X7000 and check sent dumps byte for byte against the Java
version's encoder. The transfer tests run against a simulated sampler that delivers sysex like Chrome does.
The QuickDisk tests use a disk written by an S700 and one written by an S612, with their audio replaced by a test
signal (`web/test/fixtures/make-fixtures.ts` makes them from sound libraries, which aren't in the repository). With
the El Profesor de Danza S700 library in `sounds/qd_examples/`, they also read all 99 of its disks and save each one again.

## License

MIT, see [LICENSE](LICENSE).
