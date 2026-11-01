//! The sampler engine: sample memory, program parameters and the voices playing them.

use std::collections::BTreeMap;

use crate::params::*;
use crate::voice::{NoteOn, Voice};

pub const MAX_VOICES: usize = 32;
/// The longest block the engine renders, AudioWorklets use 128
pub const MAX_FRAMES: usize = 4096;
const VIBRATO_HZ: f32 = 5.5;
/// semitones of vibrato at full modulation
const VIBRATO_DEPTH: f32 = 0.5;

pub struct SampleData {
    pub data: Vec<f32>,
    pub rate: f32,
}

pub struct Engine {
    sample_rate: f32,
    samples: BTreeMap<u32, SampleData>,
    programs: BTreeMap<u32, Params>,
    voices: Vec<Voice>,
    polyphony: usize,
    out: Vec<f32>,
    /// where the web side writes program parameters before calling set_program
    pub params_in: Params,
    bend: f32,
    modulation: f32,
    lfo_phase: f32,
    volume: f32,
    notes_started: u64,
    /// count, then sample id and position of each playing voice
    positions: Vec<u32>,
}

impl Engine {
    pub fn new(sample_rate: f32) -> Engine {
        Engine {
            sample_rate,
            samples: BTreeMap::new(),
            programs: BTreeMap::new(),
            voices: vec![Voice::default(); MAX_VOICES],
            polyphony: 16,
            out: vec![0.0; MAX_FRAMES],
            params_in: DEFAULT_PARAMS,
            bend: 0.0,
            modulation: 0.0,
            lfo_phase: 0.0,
            volume: 1.0,
            notes_started: 0,
            positions: Vec::with_capacity(1 + 2 * MAX_VOICES),
        }
    }

    /// Replaces the sample with this id, voices playing the old one stop
    pub fn set_sample(&mut self, id: u32, data: Vec<f32>, rate: f32) {
        self.stop_sample(id);
        self.samples.insert(id, SampleData { data, rate });
    }

    pub fn remove_sample(&mut self, id: u32) {
        self.stop_sample(id);
        self.samples.remove(&id);
    }

    fn stop_sample(&mut self, id: u32) {
        for v in self.voices.iter_mut().filter(|v| v.active && v.sample == id) {
            v.active = false;
        }
    }

    pub fn sample_count(&self) -> usize {
        self.samples.len()
    }

    /// Sets a program's parameters, notes playing it follow the change
    pub fn set_program(&mut self, id: u32, params: Params) {
        self.programs.insert(id, params);
    }

    pub fn note_on(&mut self, note: NoteOn) {
        let Some(sample) = self.samples.get(&note.sample) else {
            return;
        };
        let len = sample.data.len();
        let step = note.ratio * sample.rate as f64 / self.sample_rate as f64;
        let index = self.free_voice();
        self.notes_started += 1;
        self.voices[index].start(&note, len, step, self.notes_started);
    }

    /// A free voice, or the one to steal: the quietest released one, else the oldest
    fn free_voice(&self) -> usize {
        let voices = &self.voices[..self.polyphony];
        if let Some(i) = voices.iter().position(|v| !v.active) {
            return i;
        }
        let quietest_released = voices.iter().enumerate().filter(|(_, v)| v.released)
            .min_by(|(_, a), (_, b)| a.amp_level().total_cmp(&b.amp_level()));
        if let Some((i, _)) = quietest_released {
            return i;
        }
        voices.iter().enumerate().min_by_key(|(_, v)| v.started).map_or(0, |(i, _)| i)
    }

    pub fn note_off(&mut self, key: u32) {
        for v in self.voices.iter_mut().filter(|v| v.active && !v.released && v.key == key) {
            v.release();
        }
    }

    /// @param hard stop at once instead of releasing
    pub fn all_notes_off(&mut self, hard: bool) {
        for v in self.voices.iter_mut().filter(|v| v.active) {
            if hard {
                v.active = false;
            } else {
                v.release();
            }
        }
    }

    pub fn set_polyphony(&mut self, voices: usize) {
        self.polyphony = voices.clamp(1, MAX_VOICES);
        for v in self.voices[self.polyphony..].iter_mut() {
            v.active = false;
        }
    }

    /// @param semitones
    pub fn set_bend(&mut self, semitones: f32) {
        self.bend = semitones;
    }

    /// @param amount 0..1, vibrato depth
    pub fn set_modulation(&mut self, amount: f32) {
        self.modulation = amount.clamp(0.0, 1.0);
    }

    pub fn set_volume(&mut self, volume: f32) {
        self.volume = volume.max(0.0);
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }

    /// Where the playing voices are: the count, then the sample id and the sample read of each
    pub fn positions(&mut self) -> &[u32] {
        self.positions.clear();
        self.positions.push(0);
        for v in self.voices.iter().filter(|v| v.active) {
            if let Some(index) = v.position() {
                self.positions.push(v.sample);
                self.positions.push(index as u32);
            }
        }
        self.positions[0] = (self.positions.len() as u32 - 1) / 2;
        &self.positions
    }

    /// Renders the next `frames` samples (mono)
    pub fn process(&mut self, frames: usize) -> &[f32] {
        let frames = frames.min(MAX_FRAMES);
        let out = &mut self.out[..frames];
        out.fill(0.0);
        let vibrato = self.modulation * VIBRATO_DEPTH * (2.0 * core::f32::consts::PI * self.lfo_phase).sin();
        self.lfo_phase = (self.lfo_phase + frames as f32 * VIBRATO_HZ / self.sample_rate).fract();
        let pitch = (((self.bend + vibrato) / 12.0) as f64).exp2();
        for v in self.voices.iter_mut().filter(|v| v.active) {
            let Some(sample) = self.samples.get(&v.sample) else {
                v.active = false;
                continue;
            };
            let params = self.programs.get(&v.program).unwrap_or(&DEFAULT_PARAMS);
            v.render(out, &sample.data, params, pitch, self.sample_rate);
        }
        for o in out.iter_mut() {
            *o = (*o * self.volume).clamp(-1.0, 1.0);
        }
        &self.out[..frames]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::LoopMode;

    const SR: f32 = 48000.0;

    fn sine(frequency: f32, rate: f32, len: usize) -> Vec<f32> {
        (0..len).map(|i| (2.0 * core::f32::consts::PI * frequency * i as f32 / rate).sin()).collect()
    }

    fn note(key: u32, ratio: f64, loop_mode: LoopMode, len: usize) -> NoteOn {
        NoteOn {
            key, velocity: 1.0, program: 0, sample: 1, ratio, start: 0, end: len, loop_start: 0, loop_end: len, loop_mode,
            gain: 1.0,
        }
    }

    fn render(engine: &mut Engine, seconds: f32) -> Vec<f32> {
        let mut all = Vec::new();
        for _ in 0..(seconds * SR / 128.0) as usize {
            all.extend_from_slice(engine.process(128));
        }
        all
    }

    fn frequency(data: &[f32], rate: f32) -> f32 {
        let crossings: Vec<f32> = data.windows(2).enumerate().filter(|(_, w)| w[0] < 0.0 && w[1] >= 0.0)
            .map(|(i, w)| i as f32 + w[0] / (w[0] - w[1])).collect();
        (crossings.len() - 1) as f32 / (crossings[crossings.len() - 1] - crossings[0]) * rate
    }

    fn engine_with_sine(len: usize) -> Engine {
        let mut engine = Engine::new(SR);
        // a sampler rate, so the engine has to convert
        engine.set_sample(1, sine(440.0, 39555.4, len), 39555.4);
        engine
    }

    #[test]
    fn plays_at_pitch_converting_the_sample_rate() {
        let mut engine = engine_with_sine(40000);
        engine.note_on(note(60, 1.0, LoopMode::Off, 40000));
        let out = render(&mut engine, 0.5);
        assert!((frequency(&out[2400..], SR) - 440.0).abs() < 0.5);

        engine.all_notes_off(true);
        engine.note_on(note(72, 2.0, LoopMode::Off, 40000));
        let out = render(&mut engine, 0.4);
        assert!((frequency(&out[2400..], SR) - 880.0).abs() < 1.0);
    }

    #[test]
    fn pitch_bend_and_level() {
        let mut engine = engine_with_sine(40000);
        engine.set_bend(12.0);
        engine.note_on(note(60, 1.0, LoopMode::Off, 40000));
        let out = render(&mut engine, 0.4);
        assert!((frequency(&out[2400..], SR) - 880.0).abs() < 1.0);
        let peak = out[2400..].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!((peak - DEFAULT_PARAMS[LEVEL]).abs() < 0.02, "{peak}");
    }

    #[test]
    fn one_shot_ends_and_frees_the_voice() {
        let mut engine = engine_with_sine(4000); // 0.1 s
        engine.note_on(note(60, 1.0, LoopMode::Off, 4000));
        render(&mut engine, 0.05);
        assert_eq!(engine.active_voices(), 1);
        render(&mut engine, 0.1);
        assert_eq!(engine.active_voices(), 0);
    }

    #[test]
    fn looped_note_sustains_until_released() {
        let mut engine = engine_with_sine(4000);
        let mut n = note(60, 1.0, LoopMode::Forward, 4000);
        n.loop_start = 1000;
        n.loop_end = 1899; // about 10 periods
        engine.note_on(n);
        let out = render(&mut engine, 2.0);
        assert_eq!(engine.active_voices(), 1);
        assert!(out[out.len() - 2400..].iter().any(|x| x.abs() > 0.3), "still sounding after 2 s");
        engine.note_off(60);
        render(&mut engine, 0.5); // default release 0.3 s
        assert_eq!(engine.active_voices(), 0);
    }

    #[test]
    fn alternating_loop_keeps_playing() {
        let mut engine = engine_with_sine(4000);
        let mut n = note(60, 1.0, LoopMode::Alternating, 4000);
        n.loop_start = 2000;
        engine.note_on(n);
        let out = render(&mut engine, 1.0);
        assert!(out.iter().all(|x| x.is_finite()));
        assert!(out[out.len() - 2400..].iter().any(|x| x.abs() > 0.3));
    }

    #[test]
    fn positions_of_playing_voices_follow_the_loop() {
        let mut engine = engine_with_sine(4000);
        assert_eq!(engine.positions(), &[0]);
        let mut n = note(60, 1.0, LoopMode::Forward, 4000);
        n.loop_start = 1000;
        n.loop_end = 2000;
        engine.note_on(n);
        render(&mut engine, 0.01);
        let first = engine.positions().to_vec();
        assert_eq!(first[..2], [1, 1], "one voice, sample 1");
        // 39555.4 Hz sample at 48 kHz output: about 0.82 samples per output sample
        assert!((first[2] as f32 - 0.01 * 39555.4).abs() < 130.0, "{first:?}");
        for _ in 0..20 {
            render(&mut engine, 0.05);
            let p = engine.positions()[2];
            assert!((1000..2000).contains(&(p as usize)) || p < 1000, "inside the loop once it gets there: {p}");
        }
        assert!((1000..2000).contains(&(engine.positions()[2] as usize)));
        engine.all_notes_off(true);
        assert_eq!(engine.positions(), &[0]);
    }

    #[test]
    fn polyphony_steals_the_oldest() {
        let mut engine = engine_with_sine(40000);
        engine.set_polyphony(2);
        for key in [60, 62, 64] {
            engine.note_on(note(key, 1.0, LoopMode::Off, 40000));
        }
        assert_eq!(engine.active_voices(), 2);
        let keys: Vec<u32> = engine.voices.iter().filter(|v| v.active).map(|v| v.key).collect();
        assert!(keys.contains(&62) && keys.contains(&64), "{keys:?}");
    }

    #[test]
    fn unknown_or_removed_samples() {
        let mut engine = engine_with_sine(40000);
        let mut n = note(60, 1.0, LoopMode::Off, 40000);
        n.sample = 99;
        engine.note_on(n);
        assert_eq!(engine.active_voices(), 0);
        engine.note_on(note(60, 1.0, LoopMode::Off, 40000));
        engine.remove_sample(1);
        assert_eq!(engine.active_voices(), 0);
        assert!(engine.process(128).iter().all(|&x| x == 0.0));
    }

    #[test]
    fn filter_envelope_and_program_changes_apply_to_playing_notes() {
        let mut engine = engine_with_sine(40000);
        let mut p = DEFAULT_PARAMS;
        p[CUTOFF] = 100.0; // far below 440 Hz
        engine.set_program(0, p);
        engine.note_on(note(60, 1.0, LoopMode::Off, 40000));
        let quiet = render(&mut engine, 0.2);
        let peak = |d: &[f32]| d[d.len() / 2..].iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak(&quiet) < 0.05);
        p[CUTOFF] = 20000.0;
        engine.set_program(0, p);
        let open = render(&mut engine, 0.2);
        assert!(peak(&open) > 0.4);
    }
}
