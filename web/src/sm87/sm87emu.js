// SPDX-License-Identifier: MPL-2.0
// Copyright (C) 2026 Roger Klaveness
// SM-87's browser emulator and another page of the same site (Axs7): a firmware package's samples and drum kit handed
// to the emulator, which plays them in place of its own, as an FM-1 does once that package is installed. The
// emulator's own Load .fwsc takes them the same way (app/web/emu/app.js). Same origin only (on rogerkl.github.io both
// are): nothing is asked, nothing leaves the browser.
//   - Kept where the emulator looks for them as it is switched on: IndexedDB "fm1-emu" (fm1-base's data part's
//     database), store "state", key "<id>:bank" (id: the emulator's app id, EMU_ID): { name, bank, samples, kit },
//     bank the bank's bytes as the package holds them (Sm87Package.bank), samples and kit (its sounds) what it holds.
//   - An emulator switched on says so on the BroadcastChannel CHANNEL:
//       emulator -> all  { t: "here", id, emu }   switched on, every 2 s, and when asked
//                        { t: "gone", id, emu }   its page going
//       page -> all      { t: "who" }             the emulators running, answer
//                        { t: "samples", id }     the samples kept for id changed: an emulator running starts again
//                                                 with them (its page reloads: it is switched on again by hand)
// SM-87 has the one copy (web/sm87emu.js); Axs7 keeps a copy, and its tests check it is this one.
import { Sm87Package } from "./sm87bank.js";

export const EMU_ID = "sm87";             // SM-87's fm1.toml name, as the emulator's build makes its id
export const EMU_PATH = "/sm-87/emu/";    // the emulator on the site
export const CHANNEL = "sm87-emu";
export const EMU_WINDOW = "sm87-emu";     // the window a page opens it in
const DB = "fm1-emu", STORE = "state";
const LAPSE_MS = 6000, EVERY_MS = 2000;   // an emulator not heard from this long is gone; how often it says it's there

/** the emulator's address on this site */
export const emuUrl = (origin = location.origin) => new URL(EMU_PATH, origin).href;

/** a package's samples as the emulator keeps them (Sm87BankError: its message says why; Error: none in it) */
export function emuSamples(bytes, name) {
  const pkg = new Sm87Package(bytes, name), bank = pkg.bank();
  if (!bank) throw new Error(`${name} has no samples in it`);
  const c = pkg.contents();
  return { name, bank: bank.buffer, samples: c.samples.length, kit: c.kit ? c.kit.sounds.length : 0 };
}

const many = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
/** what they hold: "5 samples, a drum kit of 8 sounds" */
export const emuHolds = (k) => `${many(k.samples, "sample")}${k.kit ? `, a drum kit of ${many(k.kit, "sound")}` : ""}`;

function db() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function op(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode), q = fn(t.objectStore(STORE));
    t.oncomplete = () => { d.close(); resolve(q && q.result); };
    t.onerror = t.onabort = () => { d.close(); reject(t.error); };
  });
}
const key = (id) => `${id}:bank`;
/** the samples kept for the emulator, or undefined */
export const keptSamples = (id = EMU_ID) => op("readonly", (s) => s.get(key(id)));
/** keep them (emuSamples'): what the emulator plays from its next start */
export const keepSamples = (k, id = EMU_ID) => op("readwrite", (s) => s.put(k, key(id)));
/** forget them: the emulator's own again */
export const forgetSamples = (id = EMU_ID) => op("readwrite", (s) => s.delete(key(id)));

/** The emulator's side, once switched on: it says it is there (alive: an EventTarget whose "message" events say so
 * too, the worklet's port: its frames keep coming in a background tab, whose timers the browser may hold back), and
 * onSamples() when another page has kept samples for it. Returns a function that stops it (gone, as its page going) */
export function emuAnnounce(id, onSamples, alive) {
  if (typeof BroadcastChannel === "undefined") return () => {};
  const ch = new BroadcastChannel(CHANNEL), emu = Math.random().toString(36).slice(2, 10);
  let said = 0;
  const here = () => { said = Date.now(); ch.postMessage({ t: "here", id, emu }); };
  const every = () => { if (Date.now() - said >= EVERY_MS) here(); };
  const gone = () => ch.postMessage({ t: "gone", id, emu });
  ch.onmessage = (e) => {
    const m = e.data || {};
    if (m.t === "who") here();
    else if (m.t === "samples" && m.id === id) onSamples();
  };
  const timer = setInterval(every, EVERY_MS);
  if (alive) alive.addEventListener("message", every);
  if (typeof addEventListener === "function") addEventListener("pagehide", gone);
  here();
  return () => {
    gone();
    clearInterval(timer);
    if (alive) alive.removeEventListener("message", every);
    if (typeof removeEventListener === "function") removeEventListener("pagehide", gone);
    ch.close();
  };
}

/** Another page's side: { running() (an emulator of id switched on, heard lately), tell() (the samples kept changed),
 * close() }. Open it a while before running() is asked: the emulators answer as it opens */
export function emuWatch(id = EMU_ID) {
  if (typeof BroadcastChannel === "undefined") return { running: () => false, tell() {}, close() {} };
  const ch = new BroadcastChannel(CHANNEL), heard = new Map();
  ch.onmessage = (e) => {
    const m = e.data || {};
    if (m.id !== id || !m.emu) return;
    if (m.t === "here") heard.set(m.emu, Date.now());
    else if (m.t === "gone") heard.delete(m.emu);
  };
  ch.postMessage({ t: "who" });
  return {
    running: () => [...heard.values()].some((at) => Date.now() - at < LAPSE_MS),
    tell: () => ch.postMessage({ t: "samples", id }),
    close: () => ch.close(),
  };
}

/** A page's "open in the emulator", called in its click's handler (a window is opened at once, while the browser
 * still allows it): make() gives the samples (emuSamples'; null: none to give, said by the page; the window closed
 * again), kept for the emulator. An emulator running (watch) is told and starts again with them: "told". Else the
 * emulator is opened in its window (EMU_WINDOW: the one opened before, again), and plays them as it is switched on:
 * "opened"; "blocked" when no window may be opened (they are kept: the emulator opened by hand plays them). Null when
 * make() gave none. Throws what make() or keeping them throws */
export async function openInEmulator(watch, make, { id = EMU_ID, url = emuUrl() } = {}) {
  const running = watch.running();
  const win = running ? null : window.open("", EMU_WINDOW);
  const blank = () => {                   // (a window just opened: nothing in it yet)
    try { return !!win && win.location.href === "about:blank"; } catch { return false; }
  };
  if (blank()) {
    win.document.title = "SM-87";
    win.document.body.textContent = "Making the samples for SM-87's emulator…";
  }
  let k;
  try {
    k = await make();
    if (k) await keepSamples(k, id);
  } catch (e) {
    if (blank()) win.close();
    throw e;
  }
  if (!k) {
    if (blank()) win.close();
    return null;
  }
  if (running) {
    watch.tell();
    return "told";
  }
  if (!win) return "blocked";
  win.location.href = url;
  win.focus();
  return "opened";
}
