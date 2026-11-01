# Axs7 virtual sampler

A sampler in the browser with multi-sample programs, that sends and receives samples to and from an Akai
X7000/S700 over Web MIDI. Its look is loosely based on the X7000's front panel.

It follows the Java tool [Axs7Sds](../Axs7Sds), which can only transfer single samples. The X7000 can't transfer
its program data, so the programs live here: samples are loaded or received into memory, mapped to key ranges in
programs, and played from the on-screen keyboard, the computer keyboard or a MIDI keyboard (the X7000's own works).

## What it does

- **Memory**: samples from WAV files (the loop in a WAV `smpl` chunk is kept) or other audio files, or received
  from a slot on the sampler. Not limited like the sampler's memory, and kept in the browser between visits
  (samples in IndexedDB, programs in localStorage).
- **Programs**: keygroups, each a sample over a key range with root key, tune and level; a resonant lowpass with
  its own envelope, an amp envelope, velocity sensitivity, 6-32 voices. Parameters are 0-99 like on the sampler,
  and note names follow the sampler: C3 = MIDI 60.
- **Transfers**: receive a sample slot from the sampler, send the selected sample to one. The slot is chosen in
  the app, with SLOT ▲▼ next to RECEIVE and SEND (also in the SAMPLES and MIDI views), nothing needs to be set on
  the sampler: the slot number goes in the dump request and in the header of a sent dump. How many slots the
  sampler has is set with SLOTS in the MIDI view: 6 on a standard X7000, more with a memory expansion. Samples are
  resampled to the nearest of the sampler's rates and limited to its 32752 samples when sent.
- **Banks**: the whole memory saved and loaded as a zip file: `bank.json` with the programs, and each sample as a
  WAV file with its loop.

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

## Structure

- `engine/`: the voice engine in Rust (sample playback with forward and alternating loops, filter, envelopes).
  Compiled to a wasm module without imports or wasm-bindgen, and run in an AudioWorklet.
- `web/src/protocol`: the X7000 sample dump protocol and WAV files.
- `web/src/midi`: Web MIDI ports and the transfers. A browser only delivers a sysex message when it is complete,
  and only sends complete ones, so a received dump arrives in one piece while ACKs are sent blind at a fixed pace,
  scheduled ahead with timestamps, and a dump is sent as one message without waiting for ACKs between blocks.
  Verified on an X7000.
- `web/src/model`: samples, programs and keygroups, IndexedDB storage, banks.
- `web/src/audio`: the AudioWorklet, the engine's main thread side, and the player.
- `web/src/ui`, `web/src/app`: the front panel, views and actions.
- `spike/`: the Web MIDI test page used to verify the transfers on the sampler.

## Tests

    cargo test              # the engine
    cd web && npm test      # protocol, model, banks and transfers

The protocol tests use a dump received from a real X7000 and check sent dumps byte for byte against the Java
version's encoder. The transfer tests run against a simulated sampler that delivers sysex like Chrome does.
