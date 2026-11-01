# X7000 Web MIDI test

A single page that tests whether Akai X7000/S700 sample dumps work over Web MIDI, before building the virtual
sampler on top of it. Plain ES modules, no build step, no dependencies.

## Running

    ./spike/serve.sh        # or: npm start, from spike/

It serves `spike/` on all interfaces (0.0.0.0) port 8000, from any directory. Open http://localhost:8000 in
Chrome or Edge; from WSL, the Windows browser reaches it on the same address through WSL's localhost forwarding.

Use `localhost`, not the WSL IP: Web MIDI only exists on a secure origin (localhost or https). From the WSL IP
the page loads, but says the browser has no Web MIDI. If localhost forwarding stops working (it can after
sleep/hibernate), `wsl --shutdown` and starting WSL again usually fixes it. As a last resort, Chrome can treat
the WSL address as secure: add `http://<wsl ip>:8000` in `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.

Close the Java app or any DAW first, a MIDI port on Windows can usually only be open in one program.

## What it does differently from the Java version

- **Receive**: the browser only hands over a sysex when its F7 has arrived, so the whole dump comes in one piece
  at the end. The ACKs are sent blind at a fixed pace like the Java version, but with `send(ACK, timestamp)`
  scheduled up to the lookahead ahead, so the browser keeps the pace even if the page's timers are slow.
- **Transmit**: the browser rejects a sysex without F7 and data without a status byte, so the Java way (header,
  then each block after an ACK, then F7) is impossible. The whole dump goes out in **one** `send()`, without
  waiting for ACKs. Optional filler bytes (F8 timing clock or FE active sensing, 0.32 ms each) between blocks give
  the sampler a pause, if it needs one. The ACKs that come back are counted and timed.

## Test order

1. **Receive** a sample that's on the sampler, with the default 50 ms ACK interval. A full sample takes ~27 s.
   Expected: `OK`, and a note about the invalid sample period (the X7000 sends garbage there).
2. **Round trip test** with the test sine and no filler. This is the key test: it sends the sine to the slot,
   receives it back and compares. Expected: 6000 of 6000 samples identical, pitch 440 Hz.
   In the transmit part, *Time between replies* tells how fast the sampler takes the blocks (a block takes 39 ms
   on the cable).
3. If 2 fails (the sampler hangs or the data comes back wrong): switch the sampler off and on, then retry with
   30 filler bytes between blocks (~10 ms pause), then more. Also try some after the header.
4. A real sample: *Load audio file…*, transmit, play it on the sampler.

Please send back the log (*Copy log*), and for a receive that goes wrong the raw message (*Download raw .syx*).

## Tests

    node --test test/

Unit tests for the protocol, with a dump received from a real X7000 (`test/fixtures/x7000-received.syx`,
rebuilt from the Java version's receive log) and dumps made by the Java encoder to compare byte for byte. The
MIDI tests run the transfers against a simulated sampler that delivers sysex like Chrome does.
