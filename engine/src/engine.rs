//! The sampler engine: sample memory, the samples' sound parameters and the voices playing them.

use std::collections::BTreeMap;

use crate::params::*;
use crate::voice::{Controls, NoteOn, Voice, NOTE_OFF_VELOCITY};

pub const MAX_VOICES: usize = 32;
/// The longest block the engine renders, AudioWorklets use 128
pub const MAX_FRAMES: usize = 4096;

pub struct SampleData {
    pub data: Vec<f32>,
    pub rate: f32,
}

pub struct Engine {
    sample_rate: f32,
    samples: BTreeMap<u32, SampleData>,
    /// sound parameters by id, a sample's are under its id
    params: BTreeMap<u32, Params>,
    voices: Vec<Voice>,
    polyphony: usize,
    out: Vec<f32>,
    /// where the web side writes sound parameters before calling set_params
    pub params_in: Params,
    bend: f32,
    modulation: f32,
    pressure: f32,
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
            params: BTreeMap::new(),
            voices: vec![Voice::default(); MAX_VOICES],
            polyphony: 16,
            out: vec![0.0; MAX_FRAMES],
            params_in: DEFAULT_PARAMS,
            bend: 0.0,
            modulation: 0.0,
            pressure: 0.0,
            volume: 1.0,
            notes_started: 0,
            positions: Vec::with_capacity(1 + 2 * MAX_VOICES),
        }
    }

    /// Replaces the sample with this id. Voices playing it go on with the new audio if it is as long and at the same
    /// rate (an edit, like a crossfade, can be heard while a note is held), else they stop.
    pub fn set_sample(&mut self, id: u32, data: Vec<f32>, rate: f32) {
        let same_shape = self.samples.get(&id).is_some_and(|old| old.data.len() == data.len() && old.rate == rate);
        if !same_shape {
            self.stop_sample(id);
        }
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

    /// Sets sound parameters, notes playing with them follow the change
    pub fn set_params(&mut self, id: u32, params: Params) {
        self.params.insert(id, params);
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

    /// @param velocity the note off's, 0..1 (NOTE_OFF_VELOCITY without one)
    pub fn note_off(&mut self, key: u32, velocity: f32) {
        for v in self.voices.iter_mut().filter(|v| v.active && !v.released && v.key == key) {
            v.release(velocity);
        }
    }

    /// @param hard stop at once instead of releasing
    pub fn all_notes_off(&mut self, hard: bool) {
        for v in self.voices.iter_mut().filter(|v| v.active) {
            if hard {
                v.active = false;
            } else {
                v.release(NOTE_OFF_VELOCITY);
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

    /// Channel aftertouch, 0..1, for all voices
    pub fn set_pressure(&mut self, amount: f32) {
        self.pressure = amount.clamp(0.0, 1.0);
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
        let controls = Controls { bend: ((self.bend / 12.0) as f64).exp2(), modulation: self.modulation,
            pressure: self.pressure };
        for v in self.voices.iter_mut().filter(|v| v.active) {
            let Some(sample) = self.samples.get(&v.sample) else {
                v.active = false;
                continue;
            };
            let params = self.params.get(&v.params).unwrap_or(&DEFAULT_PARAMS);
            v.render(out, &sample.data, params, &controls, self.sample_rate);
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
    use crate::voice::{velocity_gain, LoopMode};

    const SR: f32 = 48000.0;

    fn sine(frequency: f32, rate: f32, len: usize) -> Vec<f32> {
        (0..len).map(|i| (2.0 * core::f32::consts::PI * frequency * i as f32 / rate).sin()).collect()
    }

    fn note(key: u32, ratio: f64, loop_mode: LoopMode, len: usize) -> NoteOn {
        NoteOn {
            key, velocity: 1.0, params: 0, sample: 1, ratio, start: 0, end: len, loop_start: 0, loop_end: len, loop_mode,
            reverse: false, gain: 1.0,
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
        let level = DEFAULT_PARAMS[LEVEL] * velocity_gain(1.0, DEFAULT_PARAMS[VEL_LEVEL]);
        assert!((peak - level).abs() < 0.02, "{peak} {level}");
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
        engine.note_off(60, NOTE_OFF_VELOCITY);
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
    fn reversed_notes_play_the_sample_backwards() {
        // a rising ramp: backwards the output falls
        let mut engine = Engine::new(SR);
        engine.set_sample(1, (0..48000).map(|i| i as f32 / 48000.0).collect(), SR);
        let mut p = DEFAULT_PARAMS;
        p[LEVEL] = 1.0;
        p[VEL_LEVEL] = 1.0; // at full velocity: all of LEVEL
        engine.set_params(0, p);
        let mut n = note(60, 1.0, LoopMode::Off, 48000);
        n.reverse = true;
        engine.note_on(n);
        let out = render(&mut engine, 0.5);
        assert!(out[1000] > 0.9 && out[20000] < out[1000] && out[20000] > 0.5, "{} {}", out[1000], out[20000]);
        assert!(engine.positions()[2] < 30000, "the head moves down from the end");
    }

    #[test]
    fn notes_go_on_when_the_audio_is_replaced_by_audio_as_long() {
        let mut engine = engine_with_sine(40000);
        engine.note_on(note(60, 1.0, LoopMode::Off, 40000));
        render(&mut engine, 0.05);
        engine.set_sample(1, vec![0.25; 40000], 39555.4);
        let out = render(&mut engine, 0.05);
        assert_eq!(engine.active_voices(), 1, "the same length: it plays on");
        let level = DEFAULT_PARAMS[LEVEL] * velocity_gain(1.0, DEFAULT_PARAMS[VEL_LEVEL]);
        assert!((out[out.len() - 1] - 0.25 * level).abs() < 0.01, "with the new audio");
        engine.set_sample(1, vec![0.25; 20000], 39555.4);
        assert_eq!(engine.active_voices(), 0, "another length: it stops");
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

    /// How much the frequency moves between zero crossings
    fn frequency_spread(d: &[f32]) -> f32 {
        let crossings: Vec<f32> = d.windows(2).enumerate().filter(|(_, w)| w[0] < 0.0 && w[1] >= 0.0)
            .map(|(i, w)| i as f32 + w[0] / (w[0] - w[1])).collect();
        let hz: Vec<f32> = crossings.windows(2).map(|c| SR / (c[1] - c[0])).collect();
        hz.iter().cloned().fold(f32::MIN, f32::max) - hz.iter().cloned().fold(f32::MAX, f32::min)
    }

    fn peak(d: &[f32]) -> f32 {
        d.iter().fold(0.0f32, |m, x| m.max(x.abs()))
    }

    #[test]
    fn sound_changes_apply_to_playing_notes() {
        let mut engine = engine_with_sine(40000);
        let mut p = DEFAULT_PARAMS;
        p[CUTOFF] = 100.0; // far below 440 Hz
        p[VEL_LEVEL] = 1.0; // all of LEVEL at full velocity
        engine.set_params(0, p);
        engine.note_on(note(60, 1.0, LoopMode::Off, 40000));
        let quiet = render(&mut engine, 0.2);
        assert!(peak(&quiet[quiet.len() / 2..]) < 0.05);
        p[CUTOFF] = 20000.0;
        engine.set_params(0, p);
        let open = render(&mut engine, 0.2);
        assert!(peak(&open[open.len() / 2..]) > 0.4);
    }

    #[test]
    fn velocity_moves_the_cutoff_either_way_from_velocity_64() {
        let level_at = |velocity: f32| {
            let mut engine = engine_with_sine(40000);
            let mut p = DEFAULT_PARAMS;
            p[LEVEL] = 1.0;
            p[VEL_LEVEL] = 1.0;
            p[CUTOFF] = 110.0; // two octaves under the 440 Hz tone at velocity 64
            p[VEL_FILTER] = 4.0;
            engine.set_params(0, p);
            let mut n = note(60, 1.0, LoopMode::Off, 40000);
            n.velocity = velocity;
            engine.note_on(n);
            let out = render(&mut engine, 0.2);
            peak(&out[out.len() / 2..]) / velocity_gain(velocity, 1.0)
        };
        let soft = level_at(0.0);
        // (what is left is the 6 poles ringing at the lowest cutoff from the key on)
        assert!(soft < 0.01, "soft: lower still: {soft}");
        let middle = level_at(64.0 / 127.0);
        assert!(middle < 0.001, "at 64: the set cutoff, 72 dB down at the tone: {middle}");
        let hard = level_at(1.0);
        assert!(hard > 0.95, "hard: 4 octaves up, above the tone: {hard}");
    }

    #[test]
    fn a_one_shot_releases_at_key_off_a_drum_trigger_plays_on() {
        for (mode, release, playing) in [(LoopMode::Off, 0.005, 0), (LoopMode::Off, 0.3, 1), (LoopMode::Drum, 0.005, 1)] {
            let mut engine = engine_with_sine(40000); // 1 s
            let mut p = DEFAULT_PARAMS;
            p[RELEASE] = release;
            engine.set_params(0, p);
            engine.note_on(note(60, 1.0, mode, 40000));
            render(&mut engine, 0.1);
            engine.note_off(60, NOTE_OFF_VELOCITY);
            render(&mut engine, 0.05);
            assert_eq!(engine.active_voices(), playing, "{mode:?} with a release of {release} s");
        }
    }

    #[test]
    fn the_note_off_velocity_changes_the_release_with_velocity_to_release() {
        let time_to_silence = |off_velocity: f32| {
            let mut engine = engine_with_sine(4000);
            let mut p = DEFAULT_PARAMS;
            p[RELEASE] = 1.0;
            p[VEL_RELEASE] = 2.0; // two doublings either way
            p[RELEASE_MIN] = 0.1;
            p[RELEASE_MAX] = 3.0;
            engine.set_params(0, p);
            let mut n = note(60, 1.0, LoopMode::Forward, 4000);
            n.loop_start = 1000;
            engine.note_on(n);
            render(&mut engine, 0.05);
            engine.note_off(60, off_velocity);
            let mut blocks = 0;
            while engine.active_voices() > 0 && blocks < 10000 {
                engine.process(128);
                blocks += 1;
            }
            // to -80 dB (the envelope's floor): 4/3 of the time to -60 dB
            blocks as f32 * 128.0 / SR * 0.75
        };
        // as on the X7000: a key coming up slowly gets a longer release, a quick one a shorter
        let middle = time_to_silence(NOTE_OFF_VELOCITY);
        let slow = time_to_silence(32.0 / 127.0);
        let fast = time_to_silence(1.0);
        assert!((middle - 1.0).abs() < 0.05, "at 64 the release as set: {middle}");
        assert!((slow - 2.0).abs() < 0.1, "half way down: a doubling: {slow}");
        assert!((fast - 0.26).abs() < 0.03, "at 127 nearly two halvings: {fast}");
        assert!((time_to_silence(0.0) - 3.0).abs() < 0.1, "at most RELEASE_MAX");
    }

    /// Hz from the lowest to the highest a 440 Hz tone goes with a vibrato of some steps
    fn spread_of(steps: u32) -> f32 {
        let d = crate::voice::vibrato_depth(steps) / 12.0;
        440.0 * (d.exp2() - (-d).exp2())
    }

    #[test]
    fn vibrato_comes_in_a_step_at_a_time() {
        let mut engine = engine_with_sine(400000);
        let mut p = DEFAULT_PARAMS;
        p[LFO_RATE] = 5.0;
        p[LFO_DEPTH] = 7.0; // the deepest, ±0.475 semitones
        p[LFO_DELAY] = 0.1; // a step every 0.1 s
        engine.set_params(0, p);
        engine.note_on(note(60, 1.0, LoopMode::Off, 400000));
        let out = render(&mut engine, 1.4);
        let at = |from: f32, to: f32| frequency_spread(&out[(from * SR) as usize..(to * SR) as usize]);
        assert!(at(0.05, 0.095) < 1.0, "steady before the first step");
        let full = at(0.8, 1.4);
        assert!((full - spread_of(7)).abs() < 1.5, "all 7 steps after 0.7 s: {full} Hz, {}", spread_of(7));
    }

    #[test]
    fn aftertouch_adds_vibrato_as_deep_as_the_sounds_pressure_sens() {
        let spread_with = |pressure_depth: f32, channel: f32| {
            let mut engine = engine_with_sine(400000);
            let mut p = DEFAULT_PARAMS;
            p[PRESSURE_DEPTH] = pressure_depth;
            p[LFO_DELAY] = 2.0; // the LFO's own delay doesn't hold aftertouch back
            engine.set_params(0, p);
            engine.note_on(note(60, 1.0, LoopMode::Off, 400000));
            engine.set_pressure(channel);
            let out = render(&mut engine, 0.6);
            frequency_spread(&out[2400..])
        };
        assert!(spread_with(1.0, 0.0) < 1.0, "no pressure, no vibrato");
        assert!(spread_with(0.0, 1.0) < 1.0, "no pressure sens, no vibrato");
        assert!((spread_with(1.0, 1.0) - spread_of(7)).abs() < 1.5, "the deepest, at once");
        let half = spread_with(0.5, 1.0);
        assert!((half - spread_of(3)).abs() < 1.5, "half the sens: 3 steps of 7, as measured: {half}");
    }

    #[test]
    fn the_modulation_wheel_adds_vibrato() {
        let spread_with = |modulation: f32| {
            let mut engine = engine_with_sine(400000);
            engine.set_modulation(modulation);
            engine.note_on(note(60, 1.0, LoopMode::Off, 400000));
            let out = render(&mut engine, 0.6);
            frequency_spread(&out[2400..])
        };
        assert!(spread_with(0.0) < 1.0);
        assert!((spread_with(1.0) - spread_of(7)).abs() < 1.5, "the deepest, whatever the pressure sens");
        assert!((spread_with(0.5) - spread_of(4)).abs() < 1.5, "a step a sixteenth: 64 of 127 is 4");
    }
}
