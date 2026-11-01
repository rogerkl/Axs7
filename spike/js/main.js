import * as akai from './akai.js';
import { encodeWav, readWavInfo } from './wav.js';
import { MidiLink, receiveDump, requestAccess, transmitDump, webMidiProblem } from './midi.js';

const $ = (id) => document.getElementById(id);

/**
 * @typedef {object} Sample
 * @property {string} name
 * @property {string} [note]
 * @property {Float32Array|Float64Array} data -1..1
 * @property {Uint16Array} [codes] the exact 12 bit values, for a received sample
 * @property {number} rate one of the sampler's rates
 * @property {number} loopStart
 * @property {number} loopEnd
 * @property {boolean} alternating
 * @property {number} [sine] frequency, for the test sine
 * @property {boolean} [normalize]
 */

const state = {
  /** @type {MidiLink|null} */
  link: null,
  /** @type {Sample|null} */
  sample: null,
  /** last received message */
  raw: null,
  rawSlot: 0,
  busy: false,
  /** when the last ACK scheduled by a receive goes out, the next transfer waits for it */
  acksUntil: 0,
  /** @type {AbortController|null} */
  abort: null,
  /** @type {AudioContext|null} */
  audio: null,
  /** @type {AudioBufferSourceNode|null} */
  playing: null,
};

// ---------------------------------------------------------------- log

const logEl = $('log');
const logStart = performance.now();
let lastLine = null;

function log(text, level = 'info') {
  if (lastLine && lastLine.text === text && lastLine.level === level) {
    lastLine.count++;
    lastLine.el.textContent = formatLine(lastLine);
    return;
  }
  const line = { text, level, count: 1, time: performance.now(), el: document.createElement('span') };
  if (level !== 'info') {
    line.el.className = level;
  }
  line.el.textContent = formatLine(line);
  const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
  logEl.append(line.el);
  while (logEl.childElementCount > 3000) {
    logEl.firstElementChild.remove();
  }
  if (atBottom) {
    logEl.scrollTop = logEl.scrollHeight;
  }
  lastLine = line;
}

function formatLine(line) {
  const time = ((line.time - logStart) / 1000).toFixed(3).padStart(9);
  return `${time}  ${line.text}${line.count > 1 ? `  (×${line.count})` : ''}\n`;
}

// ---------------------------------------------------------------- results and status

/** @param {Array<[string, (string|number)?, string?]>} rows a row with only a label is a heading */
function showResult(rows) {
  const body = document.createElement('tbody');
  for (const [label, value, cls] of rows) {
    const tr = body.insertRow();
    if (value === undefined) {
      const td = tr.insertCell();
      td.colSpan = 2;
      td.innerHTML = `<strong></strong>`;
      td.firstChild.textContent = label;
      log(`--- ${label}`);
      continue;
    }
    tr.insertCell().textContent = label;
    const td = tr.insertCell();
    td.textContent = String(value);
    if (cls) {
      td.className = cls;
    }
    log(`  ${label}: ${value}`);
  }
  $('result').replaceChildren(body);
}

function progress(value, max, text) {
  $('progress').max = max;
  $('progress').value = Math.min(value, max);
  $('status').textContent = text;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

function updateButtons() {
  const ready = !!(state.link?.input && state.link?.output) && !state.busy;
  $('receive').disabled = !ready;
  $('transmit').disabled = !ready || !state.sample;
  $('roundTrip').disabled = !ready || !state.sample;
  $('cancel').disabled = !state.busy;
  $('input').disabled = !state.link || state.busy;
  $('output').disabled = !state.link || state.busy;
  $('sine').disabled = state.busy;
  $('file').disabled = state.busy;
  $('play').disabled = !state.sample;
  $('stop').disabled = !state.playing;
  $('downloadWav').disabled = !state.sample;
  $('downloadSyx').disabled = !state.raw;
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not available, the choice just isn't remembered
  }
}

// ---------------------------------------------------------------- MIDI ports

async function connect() {
  try {
    const access = await requestAccess();
    state.link = new MidiLink(access, log);
    access.addEventListener('statechange', (e) => {
      log(`port ${e.port.type} "${e.port.name}": ${e.port.state}, ${e.port.connection}`);
      fillPorts();
    });
    $('connect').disabled = true;
    $('midiStatus').textContent = 'Connected, sysex allowed';
    log('MIDI access granted with sysex');
    fillPorts();
  } catch (e) {
    $('midiStatus').textContent = `No MIDI access: ${e.message}`;
    log(`MIDI access refused: ${e.name}: ${e.message}`, 'error');
  }
}

function fillPorts() {
  const access = state.link.access;
  for (const [id, ports, key] of [['input', access.inputs, 'midiIn'], ['output', access.outputs, 'midiOut']]) {
    const select = $(id);
    const current = select.value;
    const options = [...ports.values()].map((p) => new Option(p.name + (p.manufacturer ? ` (${p.manufacturer})` : ''),
      p.id));
    select.replaceChildren(new Option('– none –', ''), ...options);
    const remembered = [...ports.values()].find((p) => p.name === storageGet(key));
    if (current && ports.has(current)) {
      select.value = current;
    } else if (remembered) {
      select.value = remembered.id;
    } else if (options.length === 1) {
      select.value = options[0].value;
    }
  }
  applyPorts();
}

async function applyPorts() {
  const link = state.link;
  try {
    if ((link.input?.id ?? '') !== $('input').value) {
      await link.setInput($('input').value);
      if (link.input) {
        storageSet('midiIn', link.input.name);
        log(`input: ${link.input.name}`);
      }
    }
    if ((link.output?.id ?? '') !== $('output').value) {
      await link.setOutput($('output').value);
      if (link.output) {
        storageSet('midiOut', link.output.name);
        log(`output: ${link.output.name}`);
      }
    }
  } catch (e) {
    log(`Could not open the port: ${e.name}: ${e.message}. Is another program using it?`, 'error');
  }
  updateButtons();
}

// ---------------------------------------------------------------- sample in memory

/** @param {Sample} sample */
function setSample(sample) {
  stop();
  state.sample = sample;
  $('sampleName').textContent = sample.name + (sample.note ? ` — ${sample.note}` : '');
  $('rate').textContent = `${sample.rate.toFixed(2)} Hz (${akai.nearestBandwidth(sample.rate).name})`;
  $('numSamples').textContent = `${sample.data.length} (${(sample.data.length / sample.rate).toFixed(2)} s)`;
  $('loopStart').value = sample.loopStart;
  $('loopEnd').value = sample.loopEnd;
  $('loopStart').max = sample.data.length;
  $('loopEnd').max = sample.data.length;
  $('loopMode').value = sample.alternating ? 'alternating' : 'forward';
  if (sample.normalize !== undefined) {
    $('normalize').checked = sample.normalize;
  }
  drawWave();
  updateTransmitInfo();
  updateButtons();
}

function readLoopFields() {
  const s = state.sample;
  if (!s) {
    return;
  }
  const int = (el) => Math.trunc(Number(el.value) || 0);
  s.loopEnd = Math.max(0, Math.min(int($('loopEnd')), s.data.length));
  s.loopStart = Math.max(0, Math.min(int($('loopStart')), s.loopEnd));
  s.alternating = $('loopMode').value === 'alternating';
  $('loopStart').value = s.loopStart;
  $('loopEnd').value = s.loopEnd;
  drawWave();
  updateTransmitInfo();
}

function makeSine() {
  const rate = akai.BW16.rate;
  const data = akai.testSine(rate);
  setSample({
    name: 'Test sine', note: '440 Hz, 6000 samples, rising level, as in HardwareLoopback', data, rate,
    loopStart: 0, loopEnd: data.length - 100, alternating: false, sine: 440, normalize: false,
  });
}

/** @param {File} file */
async function loadFile(file) {
  try {
    const buffer = await file.arrayBuffer();
    const info = readWavInfo(buffer);
    const fileRate = info.sampleRate ?? akai.BW16.rate;
    const bw = akai.nearestBandwidth(fileRate);
    const resample = !akai.matchesBandwidth(bw, fileRate);
    // decodeAudioData resamples to the context's rate
    const context = new OfflineAudioContext(1, 1, resample ? bw.rate : fileRate);
    const audio = await context.decodeAudioData(buffer.slice(0));
    const length = Math.min(audio.length, akai.MAX_SAMPLES);
    const data = new Float32Array(length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const channel = audio.getChannelData(c);
      for (let i = 0; i < length; i++) {
        data[i] += channel[i] / audio.numberOfChannels;
      }
    }
    const ratio = resample ? bw.rate / fileRate : 1;
    let loop;
    if (info.loops === null) {
      loop = { loopStart: 0, loopEnd: Math.max(0, length - 100), alternating: false };
    } else if (info.loops.length === 0) {
      loop = { loopStart: length, loopEnd: length, alternating: false }; // one shot
    } else {
      const l = info.loops[0];
      const loopEnd = Math.min(Math.round(l.end * ratio), length);
      loop = { loopStart: Math.min(Math.round(l.start * ratio), loopEnd), loopEnd, alternating: l.alternating };
    }
    const notes = [
      info.sampleRate === null ? 'not a wav file, resampled to 39555.4 Hz'
        : resample ? `resampled from ${fileRate} Hz` : `${fileRate} Hz`,
      audio.numberOfChannels > 1 ? `${audio.numberOfChannels} channels mixed to mono` : null,
      audio.length > length ? `truncated from ${audio.length} samples` : null,
      info.loops === null ? 'no loop in the file' : info.loops.length === 0 ? 'one shot' : 'loop from the file',
    ];
    setSample({ name: file.name, note: notes.filter(Boolean).join(', '), data, rate: bw.rate, ...loop,
      normalize: true });
    log(`Loaded ${file.name}: ${notes.filter(Boolean).join(', ')}`);
  } catch (e) {
    log(`Could not load ${file.name}: ${e.message}`, 'error');
  }
}

function drawWave() {
  const canvas = $('wave');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();
  ctx.fillStyle = color('--border');
  ctx.fillRect(0, Math.floor(h / 2), w, 1);
  const s = state.sample;
  if (!s || s.data.length === 0) {
    return;
  }
  const n = s.data.length;
  const x = (i) => (i / n) * w;
  if (!akai.isOneShot(s.loopStart, s.loopEnd)) {
    ctx.fillStyle = color('--accent-soft');
    ctx.fillRect(x(s.loopStart), 0, x(s.loopEnd) - x(s.loopStart), h);
  }
  ctx.fillStyle = color('--wave');
  for (let px = 0; px < w; px++) {
    const a = Math.floor((px * n) / w);
    const b = Math.max(a + 1, Math.floor(((px + 1) * n) / w));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = a; i < b && i < n; i++) {
      lo = Math.min(lo, s.data[i]);
      hi = Math.max(hi, s.data[i]);
    }
    if (lo <= hi) {
      const y1 = ((1 - hi) * h) / 2;
      const y2 = ((1 - lo) * h) / 2;
      ctx.fillRect(px, y1, 1, Math.max(1, y2 - y1));
    }
  }
  // the sampler doesn't keep anything after the loop end
  ctx.fillStyle = color('--dim');
  ctx.fillRect(x(s.loopEnd), 0, w - x(s.loopEnd), h);
  ctx.fillStyle = color('--accent');
  ctx.fillRect(x(s.loopStart), 0, dpr, h);
  ctx.fillRect(Math.max(0, x(s.loopEnd) - dpr), 0, dpr, h);
}

function play() {
  stop();
  const s = state.sample;
  state.audio ??= new AudioContext();
  state.audio.resume();
  const length = s.loopEnd > 0 ? s.loopEnd : s.data.length; // the sampler ends the sample at the loop end
  const buffer = state.audio.createBuffer(1, length, s.rate);
  buffer.copyToChannel(Float32Array.from(s.data.subarray(0, length)), 0);
  const source = new AudioBufferSourceNode(state.audio, { buffer });
  if (!akai.isOneShot(s.loopStart, s.loopEnd)) {
    source.loop = true;
    source.loopStart = s.loopStart / s.rate;
    source.loopEnd = s.loopEnd / s.rate;
    if (s.alternating) {
      log('The preview plays the alternating loop forward', 'warn');
    }
  }
  source.connect(state.audio.destination);
  source.onended = () => {
    if (state.playing === source) {
      state.playing = null;
      updateButtons();
    }
  };
  source.start();
  state.playing = source;
  updateButtons();
}

function stop() {
  const source = state.playing;
  state.playing = null;
  source?.stop();
  updateButtons();
}

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadWav() {
  const s = state.sample;
  const loops = akai.isOneShot(s.loopStart, s.loopEnd) ? []
    : [{ start: s.loopStart, end: s.loopEnd, alternating: s.alternating }];
  const name = s.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'sample';
  download(encodeWav(s.data, s.rate, loops), `${name}.wav`, 'audio/wav');
}

// ---------------------------------------------------------------- transfers

const int = (id) => Math.max(0, Math.trunc(Number($(id).value) || 0));

function prepareDump() {
  const s = state.sample;
  const header = {
    slot: Number($('slot').value), sampleRate: s.rate, numSamples: s.data.length, loopStart: s.loopStart,
    loopEnd: s.loopEnd, alternating: s.alternating,
  };
  const normalize = $('normalize').checked;
  const max = akai.peak(s.data);
  const codes = s.codes && !normalize ? s.codes : akai.encodeSamples(s.data, normalize && max > 0 ? 1 / max : 1);
  const dump = akai.buildDump(header, codes, {
    fillerAfterHeader: int('fillerHeader'), fillerPerBlock: int('fillerBlock'), fillerByte: Number($('fillerByte').value),
  });
  return { dump, codes: codes.slice(0, dump.header.numSamples) };
}

function updateTransmitInfo() {
  if (!state.sample) {
    $('transmitInfo').textContent = 'Load or generate a sample first.';
    return;
  }
  const { dump } = prepareDump();
  const pauseMs = (count) => (akai.wireSeconds(count) * 1000).toFixed(1);
  const parts = [`${dump.numBlocks} blocks, ${dump.bytes.length} bytes in one message, `
    + `${akai.wireSeconds(dump.bytes.length).toFixed(1)} s on the cable`];
  if (int('fillerHeader') > 0) {
    parts.push(`${pauseMs(int('fillerHeader'))} ms pause after the header`);
  }
  if (int('fillerBlock') > 0) {
    parts.push(`${pauseMs(int('fillerBlock'))} ms pause between blocks`);
  }
  $('transmitInfo').textContent = parts.join(', ') + '.';
}

async function run(name, task) {
  if (state.busy) {
    return;
  }
  state.busy = true;
  state.abort = new AbortController();
  updateButtons();
  try {
    await waitForScheduledAcks(state.abort.signal);
    await task(state.abort.signal);
  } catch (e) {
    if (e.timing) {
      state.acksUntil = Math.max(state.acksUntil, e.timing.lastAckAt);
    }
    if (e.name === 'AbortError') {
      log(`${name} cancelled`, 'warn');
      progress(0, 1, 'Cancelled');
    } else {
      log(`${name} failed: ${e.message}`, 'error');
      progress(0, 1, 'Failed');
      showResult([[name], ['Error', e.message, 'bad'], ...(e.timing ? timingRows(e.timing) : [])]);
    }
  } finally {
    state.busy = false;
    state.abort = null;
    updateButtons();
  }
}

async function transmit(signal) {
  const slot = Number($('slot').value);
  const { dump, codes } = prepareDump();
  log(`Transmit to slot ${slot + 1}: ${dump.numBlocks} blocks, ${dump.bytes.length} bytes in one send(), `
    + `${akai.wireSeconds(dump.bytes.length).toFixed(1)} s on the cable`);
  log(`header: ${akai.hex(dump.bytes.subarray(0, akai.HEADER_LENGTH))}`);
  const result = await transmitDump(state.link, dump, {
    signal,
    onProgress: (p) => progress(p.elapsedMs, p.wireMs,
      `Sending… ${seconds(p.elapsedMs)} of about ${seconds(p.wireMs)}, ${p.replies} replies from the sampler`),
  });
  progress(1, 1, result.cancelled ? 'Stopped waiting for replies' : 'Sent');
  return { result, codes, dump };
}

function transmitRows(r) {
  const rows = [
    ['Sent', `${r.bytes} bytes, ${r.numBlocks} blocks, in one message`],
    ['Time on the cable', seconds(r.wireMs)],
    ['Replies from the sampler', `${r.replies}, the Java version gets one ACK per block (${r.numBlocks})`,
      r.replies >= r.numBlocks ? 'ok' : 'bad'],
    ...r.kinds.map(([kind, count]) => ['Reply', `${kind}  × ${count}`, 'mono']),
  ];
  if (r.replies > 0) {
    rows.push(['First / last reply', `${seconds(r.firstMs)} / ${seconds(r.lastMs)} after the send`]);
  }
  if (r.gaps) {
    rows.push(['Time between replies', `min ${r.gaps.min.toFixed(1)}, average ${r.gaps.avg.toFixed(1)}, `
      + `max ${r.gaps.max.toFixed(1)} ms (a block takes 39 ms on the cable)`]);
  }
  if (r.cancelled) {
    rows.push(['Note', 'Stopped waiting for replies (cancelled), the data was already sent', 'bad']);
  }
  return rows;
}

async function receive(signal) {
  const slot = Number($('slot').value);
  const result = await receiveDump(state.link, slot, {
    ackIntervalMs: Math.max(1, int('ackInterval')),
    lookaheadMs: Math.max(100, int('lookahead')),
    signal,
    onProgress: (p) => progress(p.elapsedMs, p.maxMs, `Waiting for the dump… ${seconds(p.elapsedMs)}, `
      + `${p.acks} ACKs sent (a full sample takes about ${seconds(p.maxMs)})`),
  });
  progress(1, 1, result.ok ? 'Received' : 'Received with problems');
  state.acksUntil = Math.max(state.acksUntil, result.timing.lastAckAt);
  state.raw = result.raw;
  state.rawSlot = slot;
  if (result.header && result.blocks > 0) {
    setSample({
      name: `Received from slot ${slot + 1}`, note: `${result.blocks} blocks`, data: result.data,
      codes: result.codes, rate: result.header.sampleRate, loopStart: result.loopStart, loopEnd: result.loopEnd,
      alternating: result.header.alternating, normalize: false,
    });
  }
  updateButtons();
  return result;
}

function timingRows(t) {
  return [
    ['Time', `${t.seconds.toFixed(1)} s from the request`],
    ['ACKs', `${t.acksSent} sent before the dump arrived, ${t.acksAfterEnd} more were already scheduled`
      + (t.lateRefills ? `, the ACK timer ran late ${t.lateRefills} times` : '')],
  ];
}

function receiveRows(r) {
  const rows = [
    ['Result', r.ok ? 'OK' : 'Problems', r.ok ? 'ok' : 'bad'],
    ...r.problems.map((p) => ['Problem', p, 'bad']),
    ...r.notes.map((n) => ['Note', n]),
    ...timingRows(r.timing),
    ['Message', `${r.length} bytes`],
  ];
  if (r.header) {
    const h = r.header;
    rows.push(
      ['Header', akai.hex(r.headerBytes), 'mono'],
      ['Blocks', `${r.blocks} of ${r.expectedBlocks}, ${r.checksumErrors} with checksum errors`],
      ['Sample period', `${h.period} ns${h.periodValid ? '' : ' (invalid)'}, ${h.sampleRate.toFixed(2)} Hz`],
      ['Total words', h.totalWords],
      ['Loop', `${h.loopStart}–${h.loopEnd}, ${h.alternating ? 'alternating' : 'forward'}`
        + (akai.isOneShot(h.loopStart, h.loopEnd) ? ' (one shot)' : '')],
    );
  }
  return rows;
}

/**
 * A receive leaves up to the lookahead's worth of ACKs scheduled after the dump has arrived, the browser can't
 * call them back. Wait for them so they don't mix with the next transfer.
 */
async function waitForScheduledAcks(signal) {
  const wait = state.acksUntil + 50 - performance.now();
  if (wait > 0) {
    progress(0, 1, `Waiting ${seconds(wait)} for the ACKs scheduled by the last receive`);
    await sleep(wait, signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Cancelled', 'AbortError'));
    });
  });
}

async function roundTrip(signal) {
  const sent = state.sample;
  const { result: tx, codes, dump } = await transmit(signal);
  const rows = [['Transmit'], ...transmitRows(tx)];
  showResult(rows);
  progress(0, 1, 'Waiting a second before receiving');
  await sleep(1000, signal);
  const rx = await receive(signal);
  rows.push(['Receive'], ...receiveRows(rx), ['Compared']);
  if (rx.header && rx.codes.length > 0) {
    const sentHeader = akai.decodeHeader(dump.bytes);
    const c = akai.compareCodes(codes, rx.codes);
    rows.push(
      ['Data', `${c.identical} of ${c.compared} samples identical at offset ${c.offset}, max difference `
        + `${c.maxDiff} (12 bit steps)`, c.identical === c.compared && c.compared === codes.length ? 'ok' : 'bad'],
      ['Period', `sent ${sentHeader.period} ns, received ${rx.header.period} ns`],
      ['Total words', `sent ${sentHeader.totalWords}, received ${rx.header.totalWords}`],
      ['Loop', `sent ${sentHeader.loopStart}–${sentHeader.loopEnd} ${sentHeader.alternating ? 'alt' : 'fwd'}, `
        + `received ${rx.header.loopStart}–${rx.header.loopEnd} ${rx.header.alternating ? 'alt' : 'fwd'}`],
    );
    if (sent.sine) {
      // only the part that was the sine, the silence the header's extra words add gives a false zero crossing
      const played = akai.sineFrequency(rx.data.subarray(c.offset > 0 ? c.offset : 0,
        Math.min(rx.data.length, codes.length + c.offset)), rx.header.sampleRate);
      rows.push(['Pitch', `the received sine plays at ${played.toFixed(2)} Hz `
        + `(${akai.cents(played, sent.sine).toFixed(1)} cents from ${sent.sine} Hz)`]);
    }
  } else {
    rows.push(['Data', 'Nothing to compare', 'bad']);
  }
  showResult(rows);
}

// ---------------------------------------------------------------- wiring

function init() {
  const problem = webMidiProblem();
  if (problem) {
    $('support').textContent = problem;
    $('support').hidden = false;
    $('connect').disabled = true;
    log(problem, 'error');
  }
  $('connect').addEventListener('click', connect);
  $('input').addEventListener('change', applyPorts);
  $('output').addEventListener('change', applyPorts);
  $('sine').addEventListener('click', makeSine);
  $('file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) {
      loadFile(file);
    }
  });
  for (const id of ['loopStart', 'loopEnd', 'loopMode']) {
    $(id).addEventListener('change', readLoopFields);
  }
  for (const id of ['fillerHeader', 'fillerBlock', 'fillerByte', 'normalize', 'slot']) {
    $(id).addEventListener('change', updateTransmitInfo);
  }
  $('play').addEventListener('click', play);
  $('stop').addEventListener('click', stop);
  $('downloadWav').addEventListener('click', downloadWav);
  $('downloadSyx').addEventListener('click', () => download(state.raw,
    `x7000-slot${state.rawSlot + 1}-received.syx`, 'application/octet-stream'));
  $('transmit').addEventListener('click', () => run('Transmit', async (signal) => {
    showResult([['Transmit'], ...transmitRows((await transmit(signal)).result)]);
  }));
  $('receive').addEventListener('click', () => run('Receive', async (signal) => {
    showResult([['Receive'], ...receiveRows(await receive(signal))]);
  }));
  $('roundTrip').addEventListener('click', () => run('Round trip', roundTrip));
  $('cancel').addEventListener('click', () => state.abort?.abort());
  $('copyLog').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(logEl.textContent);
      log('Log copied to the clipboard');
    } catch (e) {
      log(`Could not copy: ${e.message}`, 'error');
    }
  });
  $('clearLog').addEventListener('click', () => {
    logEl.replaceChildren();
    lastLine = null;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.busy) {
      log('The tab was hidden during a transfer, timers slow down in hidden tabs', 'warn');
    }
  });
  new ResizeObserver(drawWave).observe($('wave'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawWave);
  log(`${navigator.userAgent}`);
  updateTransmitInfo();
  updateButtons();
}

init();
