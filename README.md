# Axs7 virtual sampler

A sampler in the browser with multi-sample programs, that sends and receives samples to and from an Akai
X7000/S700 over Web MIDI. Its look is loosely based on the X7000's front panel.

It is a rewrite and enhancement of the Java program [Axs7Sds](https://github.com/rogerkl/Axs7Sds). 
Samples are loaded or received into memory and played from the on-screen keyboard, the computer keyboard or a MIDI keyboard (the X7000's own works).

## What it does

- **Memory**: samples from WAV files (the loop in a WAV `smpl` chunk is kept) or other audio files, or received
  from a slot on the sampler. Not limited like the sampler's memory, and kept in the browser between visits
  (samples in IndexedDB, banks in localStorage).
- **WAV files**: SAVE WAV saves a sample as it sounds, with its loop in the `smpl` chunk for other programs, and in
  an `axs7` chunk (other programs skip it) its START, END, loop, scan mode, direction and sound, its slot and its
  keygroups in the current bank. Loading such a file brings all of it back as it was, without the edits a loaded
  file gets (normalizing, resampling).
- **Loading into a bank**, as the sampler loads a disk: a loaded file goes in a slot of the current bank, LOAD SLOT
  (SAMPLE view): FILE the slot it was saved from (a WAV file saved here knows it; a disk doesn't, as far as the
  library's disks tell) or else the first free one, a slot number (more files at once go in the slots after it),
  or OFF. Its keygroups go in the programs LOAD PROG says: ALL (the sampler's Pall), one program (only if the file
  has the sample in it: a sample in P1 and P3 loaded with P2 changes no program), or NONE (P**). As on the
  sampler the key ranges are the slot's: the programs not loaded keep the slot's, now for the new sample. The MIDI
  view logs where each file went.
- **Edits that lose nothing**: a sample keeps its original as loaded, and its edits (RESAMPLE, NORMALIZE, 12 BIT,
  ATTACK, CROSSFADE) are settings. Whenever one of them or a point changes, the sample is rendered again from the
  original, so normalizing after moving START, or going back to the original's rate, loses nothing. What plays,
  what the waveform shows and what is sent is the rendered sample. RESET EDITS goes back to the original. A loaded
  file starts normalized, and at the nearest sampler rate with RATE ON LOAD = SAMPLER. APPLY EDITS writes the edits
  when wanted: the sample as it sounds becomes its original, and only START (or a loop start before it) to END of
  it is kept, as for a large file of which only a part is wanted. The original as loaded is let go (it asks first).
- **From the sampler**: a received sample is sent back as it came, so it gets no edits (its points, scan,
  direction and sound can still be set). It is marked FROM THE SAMPLER, and stays so in its WAV files (an `axs7`
  chunk, which other programs skip) and memory files, so loading it again keeps it unedited.
- **START and END**: the part of a sample that is used, to take a portion out of a long one. Playing starts at
  START, a one shot ends at END, the loop ends at END at the latest (moving END pushes it back). As on the X7000,
  START may be inside the loop, after the loop start: a sample can play its end once and then loop back to a loop
  start long before it (START past the loop end pushes the loop end along). A sample goes to the sampler with its
  START, END and loop when the sampler takes its parameters (see Sample parameters); else only the part that plays
  is sent, START to END or from the loop start when it is before START, and the MIDI log says what to set START to
  on the sampler, as a dump has no START.
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
  goes back bit for bit. WAV files and memory files keep 12 bit values exact.
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
  and alternating samples), each with how much velocity changes it (velocity raises the cutoff, harder notes get a
  shorter release: with VEL RELEASE at 99 a hard note has none, a soft one all of it, as an X7000 does). No attack
  or filter envelope, like the X7000.
- **LFO**, a sample's vibrato: SPEED, DEPTH, DELAY. The modulation wheel adds vibrato too, and so does MIDI
  aftertouch (channel or polyphonic), as deep as the sample's PRESSURE (the X7000's pressure sens), at once without
  the delay. AFTERTOUCH IN shows what the keyboard sends (the X7000's own keyboard has no aftertouch).
- **Programs** (PROGRAM): keygroups, each a sample over a key range with root, semitones and fine tune, and PITCH
  FIXED for the X7000's constant pitch (every key at the root's pitch). The sound is the sample's, so every program
  playing a sample sounds the same, as on the X7000. 6-32 voices (the X7000 has 6). Parameters are 0-99 like on
  the sampler, and note names follow it: C3 = MIDI 60.
- **Banks** (BANK): a bank is what the sampler holds at once, its 32 programs P1-P32 and which sample is in each of
  its slots; there can be any number of banks, the samples in memory are shared by them. RECEIVE puts the slot's
  sample in the current bank's slot, with the key ranges the sampler sends in the bank's programs by number, and
  the sample that was in the slot leaves the bank's programs, so the bank is as the sampler is (without the
  sampler's parameters, the slot's keygroups get the new sample). SEND puts the sample in the slot and sends its
  key ranges from the bank's programs. PROG ◀▶ and MIDI program change pick P1-P32, BANK ▶ and MIDI bank select
  (controller 0) the bank; the same program number in another bank. CLEAR PROGRAM empties a program. A slot's
  sample can also be picked by hand in the BANK view: the slot's key ranges are then the picked sample's, as when
  the sampler loads a sample without programs (NONE empties the slot, the key ranges stay with the sample that was
  there). SEND of a sample in no program does the same, as the sampler keeps the slot's key ranges. Programs from before banks go into banks 32 at a time.
  RECEIVE BANK (BANK view) receives every slot (SLOTS) into the bank, and SEND BANK sends the bank's samples to
  their slots (it asks first; slots without a sample here are left as they are on the sampler), each slot as
  RECEIVE and SEND do it, with its parameters. A slot whose sample is in no program on the sampler isn't
  received, and is emptied in the bank (an empty slot is so: the X7000 has a test tone there, in no program,
  usually START 0 and END 360 but not always after switching on); RECEIVE of the one slot still gets it.
  A slot that fails is logged and passed over; pressing the button again, or RECEIVE or SEND, stops. Setting START
  and END on the sampler for the receive and back works on an X7000. With RECEIVE ALL each slot is a full dump,
  about 30 s, so 16 slots take some
  8 minutes.
- **Transfers**: receive a sample slot from the sampler, send the selected sample to one. The slot is chosen in
  the app, with SLOT ▲▼ next to RECEIVE and SEND (also in the SAMPLE and MIDI views), nothing needs to be set on
  the sampler: the slot number goes in the dump request and in the header of a sent dump. How many slots the
  sampler has is set with SLOTS in the MIDI view: 6 on a standard X7000, more with a memory expansion (tested
  receiving and sending slot 7 on an X7000 with 16). Samples are
  resampled to the nearest of the sampler's rates and limited to its 32752 samples when sent.
  The sampler sends a sample from its START point to its END: what is before START isn't sent, even a loop point
  there (with START after the loop point, the sample plays fine on the sampler, but only START to END comes over).
  So with RECEIVE ALL ON (MIDI view, the default) RECEIVE sets START to 0 and END to the most on the sampler for
  the dump and back after it, see below. The MIDI view logs each received dump's header.
- **Sample parameters**: RECEIVE and SEND first ask the sampler for the slot's parameters, with the S700's Akai
  exclusive messages (a request, RSPRM, answered with the parameters, SPRM; tried on an X7000). They are what a
  sample dump doesn't carry: START and END, the scan mode, the rate (taken from the parameters: a dump an X7000 sent
  once had no usable period in its header), the sound (OUT and LFO), and the sample's key range in each of the 32 programs. A received sample comes
  with them as a disk's does, its keygroups in the programs it is in on the sampler, and the MIDI log shows them. If
  the sampler doesn't answer, the sample comes as the dump has it. REQUEST PARAMETERS in the MIDI view only asks
  and logs the reply, on SYSEX CHAN first, then on every other channel, and keeps the channel that answers for
  RECEIVE and SEND. An X7000 answered on channel 1 with identifier 41h (the document's "65", decimal).
  - With RECEIVE ALL ON, RECEIVE sends the slot's parameters back with START at 0 and END at 32752, receives all of
    the slot's memory (what is before START, and after END of a recording that was cut, as a disk has it), then
    sends the parameters back as they were and asks for them again to see that they are; also when the dump fails
    or is cancelled (the sampler is told to stop sending first). The sample has START, END and the loop where they
    are on the sampler. If the sampler doesn't take the parameters, only START to END comes over and the log says
    so (and that the loop is lost if it was before START).
  - SEND, if the sampler answers, sends all of the sample (as SAVE QD saves it: from START to END only if all of it
    doesn't fit), then its parameters: START, END, loop, scan mode, direction, rate, sound, and its key ranges in
    the programs (a sample in no program keeps the slot's key ranges, root and fine tune on the sampler). It asks
    for them again and logs anything the sampler doesn't have as sent. A sample received with all of its memory
    goes back the same, memory and parameters. If the sampler doesn't answer, START to END is sent as before.
  - Setting START and END for RECEIVE ALL, and back, works on an X7000; SEND with parameters is not yet tried
    there.
- **QuickDisk images**: S700/X7000 disk images (`.qd`, as the HxC floppy emulator and FlashFloppy on a Gotek use
  them) load with LOAD FILE, several at once. A disk holds one sample with its parameters, as the S700's sample
  parameter message has them: the sample comes with its points, scan mode, rate and sound (OUT and LFO), marked as
  from the sampler, and with its keygroups in the programs it was in on the sampler, by number (root at its
  recording pitch, transpose, fine tune, constant pitch). A disk with a damaged block loads with a warning, and an
  older copy left on a disk is passed over. SAVE QD (SAMPLE view) saves a sample as a disk image, laid out on the
  track as the S700 writes a disk (the 96 regular disks of a real library come out cell for cell): at the nearest
  sampler rate, 12 bit, with its START, END, loop, sound and keygroups. On the sampler the root and fine tune
  (in 1/16 semitones) are the sample's, so the first keygroup's are saved and the others' roots go in their
  transpose; what had to change is logged in the MIDI view. A reversed sample is stored as it plays, flagged as
  reversed. Saved images are tested by loading them here; not yet on the sampler.
- **S612 disks** load too: the audio at the S612's 31250 Hz (its factory library plays as Cs 0.4 semitones sharp at
  the 32 kHz usually given), loaded as a file is (normalized, at the nearest sampler rate with RATE ON LOAD =
  SAMPLER). The S612 has no programs: as on the X7000, each goes in a program of its own, keys C1-C6. Its start,
  end and loop aren't read yet (its 32 bytes of settings don't decode with confidence), so it loads as a one shot
  of all of its memory.
- **Memory files** (SAVE and LOAD, also in the BANK view): the whole memory saved and loaded as a zip file:
  `memory.json` with the banks and each sample's settings and edits, each sample as a WAV file with its loop (as it
  sounds), and the original of an edited sample in `originals/`, so editing goes on from it after loading. Bank
  files from before banks (`bank.json`) load too, their programs 32 to a bank.

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
- `web/src/protocol`: the X7000 sample dump protocol, the S700's sample parameter messages (`sprm.ts`), WAV files,
  and QuickDisk images (`qd.ts`: the track, MFM and CRC; `s700disk.ts`: the S700 disk format; `s612disk.ts`: the
  S612's).
- `web/src/midi`: Web MIDI ports and the transfers. A browser only delivers a sysex message when it is complete,
  and only sends complete ones, so a received dump arrives in one piece while ACKs are sent blind at a fixed pace,
  scheduled ahead with timestamps, and a dump is sent as one message without waiting for ACKs between blocks.
  Verified on an X7000.
- `web/src/model`: samples, banks, programs and keygroups, rendering a sample from its original and edits, IndexedDB
  storage, memory files, and the S700's sample parameters as a sample (`s700.ts`). `web/src/app/renderer.ts` renders a sample again when its edits or points change.
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
