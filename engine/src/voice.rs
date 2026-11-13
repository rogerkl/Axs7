//! One playing note, like an X7000 voice: a sample read at a pitch ratio, with vibrato from its own LFO, through
//! a lowpass whose cutoff follows velocity, at a level that can follow velocity. A looping sample fades out over
//! its release time after key off, a one shot too (as measured on the X7000), a drum trigger plays to its end. A reversed voice
//! plays from END back to START, and its loop mirrored: it plays back into the loop and repeats it there.

use crate::envelope::{Adsr, Envelope};
use crate::filter::Butterworth6;
use crate::params::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopMode {
    /// one shot: plays to the end, or until key off and its release
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
/// the shortest release, against clicks
const MIN_RELEASE: f32 = 0.005;
// The X7000's vibrato, as measured (tools/x7000-lab): a sine, its depth in 8 steps, 6.4 cents apart. DEPTH picks a
// step and the LFO comes in a step at a time up to it; the modulation wheel and channel aftertouch add a step for
// each sixteenth of their range, aftertouch scaled by the pressure sens.
/// semitones between the vibrato's steps
const VIBRATO_STEP: f32 = 0.064;
/// semitones the first step has more
const VIBRATO_FIRST: f32 = 0.027;
const VIBRATO_STEPS: u32 = 7;

/// Semitones either way for a number of vibrato steps
pub fn vibrato_depth(steps: u32) -> f32 {
    if steps == 0 {
        0.0
    } else {
        VIBRATO_FIRST + VIBRATO_STEP * steps.min(VIBRATO_STEPS) as f32
    }
}

/// The steps of a controller (0..1): one for each sixteenth of its range
fn controller_steps(value: f32) -> u32 {
    ((value.clamp(0.0, 1.0) * 127.0).round() as u32 / 16).min(VIBRATO_STEPS)
}

/// What the player's hands do to all voices
#[derive(Clone, Copy, Debug)]
pub struct Controls {
    /// pitch bend as a ratio
    pub bend: f64,
    /// the modulation wheel, 0..1, adds vibrato
    pub modulation: f32,
    /// channel aftertouch, 0..1, adds vibrato by the sound's pressure sens (PRESSURE_DEPTH)
    pub pressure: f32,
}

impl Default for Controls {
    fn default() -> Self {
        Controls { bend: 1.0, modulation: 0.0, pressure: 0.0 }
    }
}

// The level with velocity, measured on the X7000 (tools/x7000-lab): in dB, a mix of a level that doesn't follow
// velocity and one that rises in a straight line in dB with it, by how much velocity to level there is. At full
// velocity with the most, the level is LEVEL's.
/// dB under LEVEL with no velocity to level
const VEL_LEVEL_NONE_DB: f32 = -7.7;
/// dB under LEVEL at MIDI velocity 1 with the most velocity to level, rising to 0 at 127
const VEL_LEVEL_SOFTEST_DB: f32 = -40.3;
/// The MIDI velocity at which velocity doesn't move the cutoff, nor the note off velocity the release
const VEL_PIVOT: f32 = 64.0;
/// A note off without a velocity: the middle one, which leaves the release as it is
pub const NOTE_OFF_VELOCITY: f32 = VEL_PIVOT / 127.0;

/// Gain for a velocity (0..1) with an amount of velocity to level (0..1)
pub fn velocity_gain(velocity: f32, amount: f32) -> f32 {
    let midi = (velocity * 127.0).clamp(1.0, 127.0);
    let line = VEL_LEVEL_SOFTEST_DB * (1.0 - (midi - 1.0) / 126.0);
    let db = (1.0 - amount) * VEL_LEVEL_NONE_DB + amount * line;
    10f32.powf(db / 20.0)
}

/// The release for a note off velocity (0..1): RELEASE at 64, VEL_RELEASE doublings longer at 0, shorter at 128
pub fn velocity_release(off_velocity: f32, p: &Params) -> f32 {
    let deflection = (VEL_PIVOT - off_velocity * 127.0) / 64.0;
    (p[RELEASE] * (p[VEL_RELEASE] * deflection).exp2()).clamp(p[RELEASE_MIN], p[RELEASE_MAX].max(p[RELEASE_MIN]))
}

/// The cutoff for a velocity (0..1): CUTOFF at velocity 64, VEL_FILTER octaves lower at 0 and higher at 128
pub fn velocity_cutoff(velocity: f32, p: &Params) -> f32 {
    let deflection = (velocity * 127.0 - VEL_PIVOT) / 64.0;
    (p[CUTOFF] * (p[VEL_FILTER] * deflection).exp2()).clamp(p[CUTOFF_MIN], p[CUTOFF_MAX].max(p[CUTOFF_MIN]))
}

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
    /// the note off's velocity, 0..1
    off_velocity: f32,
    amp: Envelope,
    filter: Butterworth6,
    lfo_phase: f32,
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
            off_velocity: NOTE_OFF_VELOCITY,
            amp: Envelope::new(),
            filter: Butterworth6::new(),
            lfo_phase: 0.0,
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
        // a loop needs two samples to go back and forth between
        self.loop_mode = if !note.loop_mode.looping() || loop_end >= loop_start + 2 {
            note.loop_mode
        } else {
            LoopMode::Off
        };
        if note.reverse && end > 0 {
            // positions counted back from the end, the loop mirrored. The loop start may be before START, as on the
            // X7000: the loop is played as it is, START only ends a reversed sample without loop.
            let first = if self.loop_mode.looping() { start.min(loop_start) } else { start };
            self.mirror = Some(end - 1);
            self.len = end - first;
            self.pos = 0.0;
            self.loop_start = end - loop_end;
            self.loop_end = end - loop_start;
        } else {
            self.mirror = None;
            self.len = end;
            self.pos = start as f64;
            self.loop_end = loop_end;
            self.loop_start = loop_start;
        }
        self.gain = note.gain;
        self.velocity = note.velocity.clamp(0.0, 1.0);
        self.off_velocity = NOTE_OFF_VELOCITY;
        self.filter.reset();
        self.lfo_phase = 0.0;
        self.age = 0;
        self.control = 0;
        self.amp.trigger();
    }

    /// Key off, with the note off's velocity (0..1). A drum trigger plays on to its end.
    pub fn release(&mut self, off_velocity: f32) {
        if self.loop_mode != LoopMode::Drum {
            self.released = true;
            // a caller without one (NaN from a missing argument in JS) gets the middle
            self.off_velocity = if off_velocity.is_finite() { off_velocity.clamp(0.0, 1.0) } else { NOTE_OFF_VELOCITY };
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
        // for one shots too: the X7000's manual has it for looping sounds, but it releases a one shot just the same.
        // The note off's velocity changes it.
        let release = velocity_release(self.off_velocity, p).max(MIN_RELEASE);
        self.amp.set(&Adsr { attack: ATTACK, decay: 0.001, sustain: 1.0, release }, sample_rate);
        let level = p[LEVEL] * self.gain * velocity_gain(self.velocity, p[VEL_LEVEL].clamp(0.0, 1.0));
        self.filter.set(velocity_cutoff(self.velocity, p), sample_rate);
        let period = self.period();
        // a word past the loop's first period: brought back, the position stays a word in from LOOP, so the word
        // before it (the Hermite's first) is the loop's own, not the one before LOOP
        let wrap_at = (self.loop_start + period + 1) as f64;
        let read = |voice: &Voice, i: i64| voice.index(i).map_or(0.0, |j| data[voice.sample_at(j)]);
        for o in out.iter_mut() {
            if self.control == 0 {
                // the LFO's own depth comes in a step at a time, the wheel's and aftertouch's at once
                let t = self.age as f32 / sample_rate;
                let full = p[LFO_DEPTH].clamp(0.0, VIBRATO_STEPS as f32) as u32;
                let lfo = if p[LFO_DELAY] > 0.0 { ((t / p[LFO_DELAY]) as u32).min(full) } else { full };
                let pressure = (controller_steps(controls.pressure) as f32 * p[PRESSURE_DEPTH].clamp(0.0, 1.0)) as u32;
                let depth = vibrato_depth(lfo) + vibrato_depth(controller_steps(controls.modulation))
                    + vibrato_depth(pressure);
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

    fn db(gain: f32) -> f32 {
        20.0 * gain.log10()
    }

    #[test]
    fn velocity_gain_as_measured_on_the_x7000() {
        // dB under LEVEL at MIDI velocities 1, 64 and 127 with VEL>LEVEL 0, 50 and 99 (tools/x7000-lab, vellevel)
        for (amount, measured) in [(0, [-7.7, -7.7, -7.7]), (50, [-24.6, -14.2, -4.0]), (99, [-40.3, -20.1, 0.0])] {
            for (velocity, want) in [1.0, 64.0, 127.0].into_iter().zip(measured) {
                let got = db(velocity_gain(velocity / 127.0, amount as f32 / 99.0));
                assert!((got - want).abs() < 0.6, "VEL>LEVEL {amount} velocity {velocity}: {got} dB, measured {want}");
            }
        }
    }

    #[test]
    fn velocity_cutoff_turns_at_64_within_the_range() {
        let mut p = DEFAULT_PARAMS;
        p[CUTOFF] = 1000.0;
        p[VEL_FILTER] = 2.0;
        p[CUTOFF_MIN] = 300.0;
        p[CUTOFF_MAX] = 3000.0;
        assert!((velocity_cutoff(64.0 / 127.0, &p) - 1000.0).abs() < 0.01);
        assert!((velocity_cutoff(96.0 / 127.0, &p) - 2000.0).abs() < 1.0, "half way up: an octave");
        assert_eq!(velocity_cutoff(1.0, &p), 3000.0, "the top");
        assert_eq!(velocity_cutoff(0.0, &p), 300.0, "the bottom");
    }

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
    fn start_may_be_inside_the_loop_as_on_the_x7000() {
        let s = |i| Some(i);
        // samples 0-9, START 6, alternating loop 2-10 (to END): 6 to 9 once, then back and forth between 9 and 2
        let mut n = note(10, 2, 10, LoopMode::Alternating);
        n.start = 6;
        let mut v = Voice::default();
        v.start(&n, 10, 1.0, 0);
        assert_eq!(v.position(), Some(6));
        assert_eq!(reads(&v, 6, 16), vec![s(6), s(7), s(8), s(9), s(8), s(7), s(6), s(5), s(4), s(3)]);
        // reversed: from END back past START, to the loop start, then the loop backwards
        let r = reversed(10, 6, 10, 2, 8, LoopMode::Forward);
        assert_eq!(reads(&r, 0, 12), vec![s(9), s(8), s(7), s(6), s(5), s(4), s(3), s(2), s(7), s(6), s(5), s(4)]);
        // without a loop, START ends it
        let one_shot = reversed(10, 6, 10, 2, 8, LoopMode::Off);
        assert_eq!(reads(&one_shot, 0, 5), vec![s(9), s(8), s(7), s(6), None]);
    }

    #[test]
    fn a_drum_trigger_ignores_key_off() {
        let mut drum = voice(100, 0, 0, LoopMode::Drum);
        drum.release(NOTE_OFF_VELOCITY);
        assert!(!drum.released);
        let mut one_shot = voice(100, 0, 0, LoopMode::Off);
        one_shot.release(NOTE_OFF_VELOCITY);
        assert!(one_shot.released);
    }
}
