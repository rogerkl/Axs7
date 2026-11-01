//! One playing note, like an X7000 voice: a sample read at a pitch ratio, with vibrato from its own LFO, through
//! a lowpass whose cutoff rises with velocity, at a level that can follow velocity. A looping sample fades out over
//! its release time after key off, a one shot stops at key off, a drum trigger plays to its end. A reversed voice
//! plays from END back to START, and its loop mirrored: it plays back into the loop and repeats it there.

use crate::envelope::{Adsr, Envelope};
use crate::filter::Lowpass;
use crate::params::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopMode {
    /// one shot: plays to the end, or until key off
    Off,
    Forward,
    Alternating,
    /// one shot that plays to the end whatever the key does
    Drum,
}

impl LoopMode {
    pub fn from_u32(value: u32) -> LoopMode {
        match value {
            1 => LoopMode::Forward,
            2 => LoopMode::Alternating,
            3 => LoopMode::Drum,
            _ => LoopMode::Off,
        }
    }

    fn looping(self) -> bool {
        matches!(self, LoopMode::Forward | LoopMode::Alternating)
    }
}

#[derive(Clone, Copy, Debug)]
pub struct NoteOn {
    pub key: u32,
    /// 0..1
    pub velocity: f32,
    /// the id of the sound parameters to play with, the sample's
    pub params: u32,
    pub sample: u32,
    /// pitch ratio, 2 plays an octave up
    pub ratio: f64,
    /// where playing starts
    pub start: usize,
    /// where a sample without loop ends, after its last sample
    pub end: usize,
    pub loop_start: usize,
    /// after the last sample in the loop
    pub loop_end: usize,
    pub loop_mode: LoopMode,
    /// play from the end back to the start, the X7000's SCAN DIRECTION R
    pub reverse: bool,
    /// linear
    pub gain: f32,
}

/// Samples between vibrato updates
const CONTROL_PERIOD: u32 = 16;
/// short enough to sound instant, long enough not to click
const ATTACK: f32 = 0.002;
const ONE_SHOT_RELEASE: f32 = 0.005;
/// the vibrato fades in over this after its delay
const LFO_FADE: f32 = 0.15;
/// semitones of vibrato the modulation wheel adds at full
const MOD_DEPTH: f32 = 0.5;

/// What the player's hands do to all voices
#[derive(Clone, Copy, Debug)]
pub struct Controls {
    /// pitch bend as a ratio
    pub bend: f64,
    /// the modulation wheel, 0..1, adds vibrato
    pub modulation: f32,
    /// channel aftertouch, 0..1, adds vibrato as deep as the sound's PRESSURE_DEPTH
    pub pressure: f32,
}

impl Default for Controls {
    fn default() -> Self {
        Controls { bend: 1.0, modulation: 0.0, pressure: 0.0 }
    }
}
const FLAT_Q: f32 = core::f32::consts::FRAC_1_SQRT_2;

#[derive(Clone, Debug)]
pub struct Voice {
    pub active: bool,
    pub key: u32,
    pub params: u32,
    pub sample: u32,
    pub started: u64,
    pub released: bool,
    pos: f64,
    step: f64,
    /// step with pitch bend and vibrato
    current_step: f64,
    loop_mode: LoopMode,
    /// The voice works in its own positions: for a forward voice they are the sample's, a reversed one counts from
    /// the end, position p reads sample mirror - p
    mirror: Option<usize>,
    loop_start: usize,
    loop_end: usize,
    len: usize,
    gain: f32,
    velocity: f32,
    amp: Envelope,
    filter: Lowpass,
    lfo_phase: f32,
    /// polyphonic aftertouch on this voice's key, 0..1
    pub key_pressure: f32,
    /// samples since key on
    age: u32,
    control: u32,
}

impl Default for Voice {
    fn default() -> Self {
        Voice {
            active: false,
            key: 0,
            params: 0,
            sample: 0,
            started: 0,
            released: false,
            pos: 0.0,
            step: 1.0,
            current_step: 1.0,
            loop_mode: LoopMode::Off,
            mirror: None,
            loop_start: 0,
            loop_end: 0,
            len: 0,
            gain: 1.0,
            velocity: 1.0,
            amp: Envelope::new(),
            filter: Lowpass::new(),
            lfo_phase: 0.0,
            key_pressure: 0.0,
            age: 0,
            control: 0,
        }
    }
}

fn hermite(xm1: f32, x0: f32, x1: f32, x2: f32, t: f32) -> f32 {
    let c1 = 0.5 * (x1 - xm1);
    let c2 = xm1 - 2.5 * x0 + 2.0 * x1 - 0.5 * x2;
    let c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    ((c3 * t + c2) * t + c1) * t + x0
}

impl Voice {
    /// @param step how far to move in the sample for each output sample at no pitch bend
    pub fn start(&mut self, note: &NoteOn, len: usize, step: f64, started: u64) {
        self.active = true;
        self.released = false;
        self.key = note.key;
        self.params = note.params;
        self.sample = note.sample;
        self.started = started;
        self.step = step;
        self.current_step = step;
        let end = note.end.min(len);
        let start = note.start.min(end.saturating_sub(1));
        let loop_end = note.loop_end.min(end);
        let loop_start = note.loop_start.min(loop_end);
        if note.reverse && end > 0 {
            // positions counted back from the end, the loop mirrored
            self.mirror = Some(end - 1);
            self.len = end - start;
            self.pos = 0.0;
            self.loop_start = end - loop_end;
            self.loop_end = (end - loop_start).min(self.len);
        } else {
            self.mirror = None;
            self.len = end;
            self.pos = start as f64;
            self.loop_end = loop_end;
            self.loop_start = loop_start;
        }
        // a loop needs two samples to go back and forth between
        self.loop_mode = if !note.loop_mode.looping() || self.loop_end >= self.loop_start + 2 {
            note.loop_mode
        } else {
            LoopMode::Off
        };
        self.gain = note.gain;
        self.velocity = note.velocity.clamp(0.0, 1.0);
        self.filter.reset();
        self.lfo_phase = 0.0;
        self.key_pressure = 0.0;
        self.age = 0;
        self.control = 0;
        self.amp.trigger();
    }

    /// Key off. A drum trigger plays on to its end.
    pub fn release(&mut self) {
        if self.loop_mode != LoopMode::Drum {
            self.released = true;
            self.amp.release();
        }
    }

    pub fn amp_level(&self) -> f32 {
        self.amp.level()
    }

    /// The sample the voice is reading, folded into the loop, for showing a playback head
    pub fn position(&self) -> Option<usize> {
        self.index(self.pos.floor() as i64).map(|j| self.sample_at(j))
    }

    /// The sample read at one of the voice's own positions
    fn sample_at(&self, position: usize) -> usize {
        self.mirror.map_or(position, |m| m - position)
    }

    fn period(&self) -> usize {
        match self.loop_mode {
            LoopMode::Off | LoopMode::Drum => 0,
            LoopMode::Forward => self.loop_end - self.loop_start,
            LoopMode::Alternating => 2 * (self.loop_end - 1 - self.loop_start),
        }
    }

    /// Maps a position that keeps counting up through the loop to the sample it reads, None after the end of a
    /// sample without loop. An alternating loop turns at its last sample and at its first.
    pub(crate) fn index(&self, v: i64) -> Option<usize> {
        if v < 0 {
            return Some(0);
        }
        let v = v as usize;
        match self.loop_mode {
            LoopMode::Forward if v >= self.loop_end => {
                Some(self.loop_start + (v - self.loop_start) % (self.loop_end - self.loop_start))
            }
            LoopMode::Alternating if v >= self.loop_end => {
                let span = self.loop_end - 1 - self.loop_start;
                let k = (v - self.loop_start) % (2 * span);
                Some(if k <= span { self.loop_start + k } else { self.loop_start + 2 * span - k })
            }
            _ if v < self.len => Some(v),
            _ => None,
        }
    }

    /// Adds the voice's output to `out`
    pub fn render(&mut self, out: &mut [f32], data: &[f32], p: &Params, controls: &Controls, sample_rate: f32) {
        // the X7000's release is for looping sounds, a one shot stops at key off
        let release = if self.loop_mode.looping() {
            let vr = p[VEL_RELEASE].clamp(0.0, 1.0);
            p[RELEASE] * (1.0 - vr + vr * self.velocity)
        } else {
            ONE_SHOT_RELEASE
        };
        self.amp.set(&Adsr { attack: ATTACK, decay: 0.001, sustain: 1.0, release }, sample_rate);
        let vl = p[VEL_LEVEL].clamp(0.0, 1.0);
        let level = p[LEVEL] * self.gain * (1.0 - vl + vl * self.velocity * self.velocity);
        // the cutoff rises with velocity
        self.filter.set(p[CUTOFF] * (p[VEL_FILTER] * self.velocity).exp2(), FLAT_Q, sample_rate);
        let period = self.period();
        let wrap_at = (self.loop_start + period) as f64;
        let read = |voice: &Voice, i: i64| voice.index(i).map_or(0.0, |j| data[voice.sample_at(j)]);
        for o in out.iter_mut() {
            if self.control == 0 {
                let t = self.age as f32 / sample_rate;
                let fade = ((t - p[LFO_DELAY]) / LFO_FADE).clamp(0.0, 1.0);
                // the LFO's own depth after its delay, the wheel and aftertouch at once
                let pressure = controls.pressure.max(self.key_pressure);
                let depth = p[LFO_DEPTH] * fade + controls.modulation * MOD_DEPTH + pressure * p[PRESSURE_DEPTH];
                let vibrato = depth * (2.0 * core::f32::consts::PI * self.lfo_phase).sin();
                self.current_step = self.step * controls.bend * ((vibrato / 12.0) as f64).exp2();
                self.lfo_phase = (self.lfo_phase + CONTROL_PERIOD as f32 * p[LFO_RATE] / sample_rate).fract();
                self.control = CONTROL_PERIOD;
            }
            self.control -= 1;
            self.age = self.age.saturating_add(1);
            let i = self.pos.floor() as i64;
            let Some(j) = self.index(i) else {
                self.active = false; // end of a sample without loop
                return;
            };
            let t = (self.pos - i as f64) as f32;
            let y = hermite(read(self, i - 1), data[self.sample_at(j)], read(self, i + 1), read(self, i + 2), t);
            let amp = self.amp.tick();
            *o += self.filter.process(y) * amp * level;
            if self.amp.is_idle() {
                self.active = false;
                return;
            }
            self.pos += self.current_step;
            if period > 0 && self.pos >= wrap_at {
                // keep the position in the loop's first period, so long notes don't lose precision
                self.pos -= period as f64;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(len: usize, loop_start: usize, loop_end: usize, loop_mode: LoopMode) -> NoteOn {
        NoteOn {
            key: 60, velocity: 1.0, params: 0, sample: 0, ratio: 1.0, start: 0, end: len, loop_start, loop_end,
            loop_mode, reverse: false, gain: 1.0,
        }
    }

    fn voice(len: usize, loop_start: usize, loop_end: usize, loop_mode: LoopMode) -> Voice {
        let mut v = Voice::default();
        v.start(&note(len, loop_start, loop_end, loop_mode), len, 1.0, 0);
        v
    }

    fn indices(v: &Voice, from: i64, to: i64) -> Vec<Option<usize>> {
        (from..to).map(|i| v.index(i)).collect()
    }

    #[test]
    fn forward_loop_wraps_to_the_start() {
        let v = voice(10, 4, 7, LoopMode::Forward);
        let s = |i| Some(i);
        assert_eq!(indices(&v, 2, 12), vec![s(2), s(3), s(4), s(5), s(6), s(4), s(5), s(6), s(4), s(5)]);
    }

    #[test]
    fn alternating_loop_turns_at_both_ends() {
        let v = voice(10, 4, 8, LoopMode::Alternating);
        let s = |i| Some(i);
        assert_eq!(indices(&v, 5, 16), vec![s(5), s(6), s(7), s(6), s(5), s(4), s(5), s(6), s(7), s(6), s(5)]);
    }

    #[test]
    fn without_loop_the_sample_ends() {
        for mode in [LoopMode::Off, LoopMode::Drum] {
            let v = voice(5, 0, 5, mode);
            assert_eq!(indices(&v, -1, 7), vec![Some(0), Some(0), Some(1), Some(2), Some(3), Some(4), None, None]);
        }
    }

    #[test]
    fn plays_from_the_start_point_and_ends_at_the_end_point() {
        let mut v = Voice::default();
        let mut n = note(10, 0, 0, LoopMode::Off);
        n.start = 3;
        n.end = 7;
        v.start(&n, 10, 1.0, 0);
        assert_eq!(v.position(), Some(3));
        assert_eq!(indices(&v, 5, 9), vec![Some(5), Some(6), None, None]);
    }

    #[test]
    fn too_short_or_outside_loop_plays_one_shot() {
        assert_eq!(voice(10, 5, 6, LoopMode::Forward).index(10), None);
        assert_eq!(voice(10, 12, 20, LoopMode::Alternating).index(10), None);
        let clamped = voice(10, 4, 20, LoopMode::Forward);
        assert_eq!(clamped.index(10), Some(4), "loop end clamped to the sample length");
    }

    /// The samples a voice reads, by its own positions
    fn reads(v: &Voice, from: i64, to: i64) -> Vec<Option<usize>> {
        (from..to).map(|i| v.index(i).map(|j| v.sample_at(j))).collect()
    }

    fn reversed(len: usize, start: usize, end: usize, loop_start: usize, loop_end: usize, mode: LoopMode) -> Voice {
        let mut n = note(len, loop_start, loop_end, mode);
        n.start = start;
        n.end = end;
        n.reverse = true;
        let mut v = Voice::default();
        v.start(&n, len, 1.0, 0);
        v
    }

    #[test]
    fn reversed_plays_from_end_back_to_start() {
        let v = reversed(10, 2, 8, 0, 0, LoopMode::Off);
        assert_eq!(v.position(), Some(7));
        let s = |i| Some(i);
        assert_eq!(reads(&v, 0, 8), vec![s(7), s(6), s(5), s(4), s(3), s(2), None, None]);
    }

    #[test]
    fn reversed_loop_plays_back_into_the_loop_and_repeats_it_backwards() {
        // samples 0-9, loop 3-6 (3, 4, 5): backwards from 9 into the loop, then 5, 4, 3 over and over
        let v = reversed(10, 0, 10, 3, 6, LoopMode::Forward);
        let s = |i| Some(i);
        assert_eq!(reads(&v, 0, 13), vec![s(9), s(8), s(7), s(6), s(5), s(4), s(3), s(5), s(4), s(3), s(5), s(4), s(3)]);
        let alt = reversed(10, 0, 10, 3, 7, LoopMode::Alternating);
        assert_eq!(reads(&alt, 3, 13), vec![s(6), s(5), s(4), s(3), s(4), s(5), s(6), s(5), s(4), s(3)]);
    }

    #[test]
    fn a_drum_trigger_ignores_key_off() {
        let mut drum = voice(100, 0, 0, LoopMode::Drum);
        drum.release();
        assert!(!drum.released);
        let mut one_shot = voice(100, 0, 0, LoopMode::Off);
        one_shot.release();
        assert!(one_shot.released);
    }
}
