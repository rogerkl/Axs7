//! One playing note: a sample read at a pitch ratio, through a lowpass with its own envelope and an amp envelope.

use crate::envelope::{Adsr, Envelope};
use crate::filter::Lowpass;
use crate::params::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LoopMode {
    Off,
    Forward,
    Alternating,
}

impl LoopMode {
    pub fn from_u32(value: u32) -> LoopMode {
        match value {
            1 => LoopMode::Forward,
            2 => LoopMode::Alternating,
            _ => LoopMode::Off,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct NoteOn {
    pub key: u32,
    /// 0..1
    pub velocity: f32,
    pub program: u32,
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
    /// keygroup level, linear
    pub gain: f32,
}

/// Samples between filter cutoff updates
const CONTROL_PERIOD: u32 = 16;

#[derive(Clone, Debug)]
pub struct Voice {
    pub active: bool,
    pub key: u32,
    pub program: u32,
    pub sample: u32,
    pub started: u64,
    pub released: bool,
    pos: f64,
    step: f64,
    loop_mode: LoopMode,
    loop_start: usize,
    loop_end: usize,
    len: usize,
    gain: f32,
    velocity: f32,
    amp: Envelope,
    fenv: Envelope,
    filter: Lowpass,
    control: u32,
}

impl Default for Voice {
    fn default() -> Self {
        Voice {
            active: false,
            key: 0,
            program: 0,
            sample: 0,
            started: 0,
            released: false,
            pos: 0.0,
            step: 1.0,
            loop_mode: LoopMode::Off,
            loop_start: 0,
            loop_end: 0,
            len: 0,
            gain: 1.0,
            velocity: 1.0,
            amp: Envelope::new(),
            fenv: Envelope::new(),
            filter: Lowpass::new(),
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

fn adsr(p: &Params, first: usize) -> Adsr {
    Adsr { attack: p[first], decay: p[first + 1], sustain: p[first + 2], release: p[first + 3] }
}

impl Voice {
    /// @param step how far to move in the sample for each output sample at no pitch bend
    pub fn start(&mut self, note: &NoteOn, len: usize, step: f64, started: u64) {
        self.active = true;
        self.released = false;
        self.key = note.key;
        self.program = note.program;
        self.sample = note.sample;
        self.started = started;
        self.step = step;
        self.len = note.end.min(len);
        self.pos = note.start.min(self.len.saturating_sub(1)) as f64;
        self.loop_end = note.loop_end.min(self.len);
        self.loop_start = note.loop_start.min(self.loop_end);
        // a loop needs two samples to go back and forth between
        self.loop_mode = if self.loop_end >= self.loop_start + 2 { note.loop_mode } else { LoopMode::Off };
        self.gain = note.gain;
        self.velocity = note.velocity.clamp(0.0, 1.0);
        self.filter.reset();
        self.control = 0;
        self.amp.trigger();
        self.fenv.trigger();
    }

    pub fn release(&mut self) {
        self.released = true;
        self.amp.release();
        self.fenv.release();
    }

    pub fn amp_level(&self) -> f32 {
        self.amp.level()
    }

    /// The sample the voice is reading, folded into the loop, for showing a playback head
    pub fn position(&self) -> Option<usize> {
        self.index(self.pos.floor() as i64)
    }

    fn period(&self) -> usize {
        match self.loop_mode {
            LoopMode::Off => 0,
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
    ///
    /// @param pitch pitch bend and vibrato as a ratio
    pub fn render(&mut self, out: &mut [f32], data: &[f32], p: &Params, pitch: f64, sample_rate: f32) {
        self.amp.set(&adsr(p, AMP_ATTACK), sample_rate);
        self.fenv.set(&adsr(p, FILTER_ATTACK), sample_rate);
        let vs = p[VELOCITY].clamp(0.0, 1.0);
        let level = p[LEVEL] * self.gain * (1.0 - vs + vs * self.velocity * self.velocity);
        let step = self.step * pitch;
        let period = self.period();
        let wrap_at = (self.loop_start + period) as f64;
        let read = |voice: &Voice, i: i64| voice.index(i).map_or(0.0, |j| data[j]);
        for o in out.iter_mut() {
            if self.control == 0 {
                let cutoff = p[CUTOFF] * (p[ENV_AMOUNT] * self.fenv.level()).exp2();
                self.filter.set(cutoff, p[RESONANCE], sample_rate);
                self.control = CONTROL_PERIOD;
            }
            self.control -= 1;
            let i = self.pos.floor() as i64;
            let Some(j) = self.index(i) else {
                self.active = false; // end of a sample without loop
                return;
            };
            let t = (self.pos - i as f64) as f32;
            let y = hermite(read(self, i - 1), data[j], read(self, i + 1), read(self, i + 2), t);
            let filtered = self.filter.process(y);
            self.fenv.tick();
            let amp = self.amp.tick();
            *o += filtered * amp * level;
            if self.amp.is_idle() {
                self.active = false;
                return;
            }
            self.pos += step;
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

    fn voice(len: usize, loop_start: usize, loop_end: usize, loop_mode: LoopMode) -> Voice {
        let mut v = Voice::default();
        let note = NoteOn {
            key: 60, velocity: 1.0, program: 0, sample: 0, ratio: 1.0, start: 0, end: len, loop_start, loop_end,
            loop_mode, gain: 1.0,
        };
        v.start(&note, len, 1.0, 0);
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
        let v = voice(5, 0, 5, LoopMode::Off);
        assert_eq!(indices(&v, -1, 7), vec![Some(0), Some(0), Some(1), Some(2), Some(3), Some(4), None, None]);
    }

    #[test]
    fn plays_from_the_start_point_and_ends_at_the_end_point() {
        let mut v = Voice::default();
        let note = NoteOn {
            key: 60, velocity: 1.0, program: 0, sample: 0, ratio: 1.0, start: 3, end: 7, loop_start: 0, loop_end: 0,
            loop_mode: LoopMode::Off, gain: 1.0,
        };
        v.start(&note, 10, 1.0, 0);
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
}
