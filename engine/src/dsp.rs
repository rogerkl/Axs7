//! Sample editing functions, run on the main thread (the web side instantiates the module a second time for them).

use core::f32::consts::FRAC_PI_2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FadeShape {
    /// for material that is alike on both sides of the seam (a steady tone)
    Linear,
    /// keeps the loudness for material that isn't (noise, a moving sound)
    EqualPower,
}

impl FadeShape {
    pub fn from_u32(value: u32) -> FadeShape {
        if value == 1 {
            FadeShape::EqualPower
        } else {
            FadeShape::Linear
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttackShape {
    Linear,
    /// starts slower, like an exponential attack
    Curve,
}

impl AttackShape {
    pub fn from_u32(value: u32) -> AttackShape {
        if value == 1 {
            AttackShape::Curve
        } else {
            AttackShape::Linear
        }
    }
}

/// Renders an attack into a sample, which the X7000 has no setting for: the `length` samples played first fade in
/// from silence. Playing forward they start at `at`, backwards they end at `at` (the last sample of the part played).
///
/// @returns the length used, shortened to fit the sample
pub fn fade_in(data: &mut [f32], at: usize, length: usize, shape: AttackShape, backwards: bool) -> usize {
    let length = if backwards { length.min(at + 1) } else { length.min(data.len().saturating_sub(at)) };
    for i in 0..length {
        let t = i as f32 / length as f32;
        let gain = match shape {
            AttackShape::Linear => t,
            AttackShape::Curve => t * t,
        };
        data[if backwards { at - i } else { at + i }] *= gain;
    }
    length
}

/// The longest crossfade a forward loop has room for: it takes the samples before the loop start, and fades
/// within the loop.
pub fn max_crossfade(len: usize, loop_start: usize, loop_end: usize) -> usize {
    if loop_end > len || loop_end <= loop_start {
        return 0;
    }
    loop_start.min(loop_end - loop_start)
}

/// Crossfades the end of a forward loop into what comes before its start, so the jump back to the start is
/// seamless: over the last `length` samples of the loop the sound fades over to the `length` samples before the loop
/// start, and at the loop end it continues into the loop start the way the sample does there.
///
/// @returns the length used, shortened to what the loop has room for
pub fn crossfade_loop(data: &mut [f32], loop_start: usize, loop_end: usize, length: usize, shape: FadeShape) -> usize {
    let length = length.min(max_crossfade(data.len(), loop_start, loop_end));
    for i in 0..length {
        let t = (i + 1) as f32 / length as f32;
        let (fade_in, fade_out) = match shape {
            FadeShape::Linear => (t, 1.0 - t),
            FadeShape::EqualPower => ((t * FRAC_PI_2).sin(), (t * FRAC_PI_2).cos()),
        };
        let end = loop_end - length + i;
        let before_start = loop_start - length + i;
        data[end] = data[end] * fade_out + data[before_start] * fade_in;
    }
    length
}

/// The highest level each frequency reaches in a sample, to see how high its content goes: of each of the
/// `size / 2 + 1` frequencies (number k is k × rate / size Hz) the magnitude at its loudest, over Hann windowed frames
/// of `size` samples half a frame apart. A sine at full level, on a frequency, is 1.
///
/// The frames start half a frame before the data, so its first samples count as much as the rest: where playing
/// starts, a sudden start is part of the sound. The last frame ends with the data: where a sample ends (or loops), a
/// cut is not. Data shorter than a frame is followed by silence.
///
/// @param size a power of two, at least 2
/// @param out `size / 2 + 1` values
/// @returns the number of frames
pub fn peak_spectrum(data: &[f32], size: usize, out: &mut [f32]) -> usize {
    assert!(size >= 2 && size.is_power_of_two() && out.len() == size / 2 + 1);
    out.fill(0.0);
    if data.is_empty() {
        return 0;
    }
    let hop = size / 2;
    let window: Vec<f32> =
        (0..size).map(|i| 0.5 - 0.5 * (2.0 * core::f32::consts::PI * i as f32 / size as f32).cos()).collect();
    let fft = Fft::new(size);
    let (mut re, mut im) = (vec![0.0f32; size], vec![0.0f32; size]);
    // a sine of amplitude a gives a × size / 4 in its bin (the window's mean is a half, and half is in the negative
    // frequencies)
    let scale = 4.0 / size as f32;
    let last = data.len().saturating_sub(size) as isize;
    let mut frames = 0;
    let mut at = -(hop as isize);
    loop {
        let from = at.min(last);
        for i in 0..size {
            let j = from + i as isize;
            re[i] = if j >= 0 && (j as usize) < data.len() { data[j as usize] * window[i] } else { 0.0 };
            im[i] = 0.0;
        }
        fft.run(&mut re, &mut im);
        for (k, peak) in out.iter_mut().enumerate() {
            *peak = peak.max((re[k] * re[k] + im[k] * im[k]).sqrt() * scale);
        }
        frames += 1;
        if from >= last {
            return frames;
        }
        at += hop as isize;
    }
}

/// A radix-2 FFT of one size, in place
struct Fft {
    cos: Vec<f32>,
    sin: Vec<f32>,
}

impl Fft {
    fn new(size: usize) -> Fft {
        let angle = |k: usize| -2.0 * core::f64::consts::PI * k as f64 / size as f64;
        Fft {
            cos: (0..size / 2).map(|k| angle(k).cos() as f32).collect(),
            sin: (0..size / 2).map(|k| angle(k).sin() as f32).collect(),
        }
    }

    fn run(&self, re: &mut [f32], im: &mut [f32]) {
        let n = re.len();
        let mut j = 0;
        for i in 1..n {
            let mut bit = n >> 1;
            while j & bit != 0 {
                j ^= bit;
                bit >>= 1;
            }
            j |= bit;
            if i < j {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut len = 2;
        while len <= n {
            let (half, step) = (len / 2, n / len);
            for first in (0..n).step_by(len) {
                for k in 0..half {
                    let (wr, wi) = (self.cos[k * step], self.sin[k * step]);
                    let (a, b) = (first + k, first + k + half);
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
            }
            len <<= 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A sine rising from silence over the first `rise` samples, so its start isn't a click
    fn tone(len: usize, hz: f32, rate: f32, rise: usize) -> Vec<f32> {
        let pi2 = 2.0 * core::f32::consts::PI;
        (0..len)
            .map(|i| {
                let gain = if i < rise { 0.5 - 0.5 * (core::f32::consts::PI * i as f32 / rise as f32).cos() } else { 1.0 };
                gain * (pi2 * ((hz * i as f32 / rate) % 1.0)).sin()
            })
            .collect()
    }

    #[test]
    fn the_peak_spectrum_shows_how_high_the_content_goes() {
        // at 32768 Hz with 1024 a frame, bin k is 32k Hz: 1 kHz at full level, and 4 kHz swelling to -40 dB and going
        // in the first half
        let (rate, size) = (32768.0f32, 1024);
        let swell = |i: usize| {
            if i < 4096 { 0.5 - 0.5 * (2.0 * core::f32::consts::PI * i as f32 / 4096.0).cos() } else { 0.0 }
        };
        let high = tone(8192, 4096.0, rate, 0);
        let data: Vec<f32> =
            tone(8192, 1024.0, rate, 1024).iter().enumerate().map(|(i, v)| v + 0.01 * swell(i) * high[i]).collect();
        let mut out = vec![0.0; size / 2 + 1];
        assert_eq!(peak_spectrum(&data, size, &mut out), 16, "from half a frame before to the end");
        let db = |v: f32| 20.0 * v.log10();
        assert!(db(out[32]).abs() < 0.1, "1 kHz at full level: {}", db(out[32]));
        assert!((db(out[128]) + 40.0).abs() < 0.2, "4 kHz at its loudest, -40 dB: {}", db(out[128]));
        let highest = (1..out.len()).rev().find(|&k| db(out[k]) > -60.0).unwrap();
        assert_eq!(highest, 129, "nothing over -60 dB above it but its own window's spread");
        assert!(out[200..].iter().all(|&v| db(v) < -90.0), "the rest is silent: the cut at the end doesn't count");
    }

    #[test]
    fn a_sudden_start_counts_in_full() {
        // a click on the first sample: frames that started at the data would all but miss it
        let size = 256;
        let mut out = vec![0.0; size / 2 + 1];
        let mut first = vec![0.0; 1000];
        first[0] = 1.0;
        peak_spectrum(&first, size, &mut out);
        assert!(out[1..].iter().all(|&v| (v / (4.0 / size as f32) - 1.0).abs() < 1e-4), "flat, at its full level");
        let mut short = vec![0.0; 3];
        assert_eq!(peak_spectrum(&short, size, &mut out), 2, "shorter than a frame: the two over it");
        short.clear();
        assert_eq!(peak_spectrum(&short, size, &mut out), 0);
        assert!(out.iter().all(|&v| v == 0.0));
    }

    fn sine(len: usize, period: f32) -> Vec<f32> {
        (0..len).map(|i| (2.0 * core::f32::consts::PI * i as f32 / period).sin()).collect()
    }

    #[test]
    fn the_loop_end_continues_into_the_start() {
        // 89.9 samples a period: a loop of whole samples jumps at the seam
        let original = sine(4000, 89.9);
        let (start, end) = (1000, 2000);
        let jump = |d: &[f32]| (d[start] - d[end - 1]).abs();
        let natural_step = (original[start] - original[start - 1]).abs();
        assert!(jump(&original) > 3.0 * natural_step, "the test loop should click");

        let mut data = original.clone();
        assert_eq!(crossfade_loop(&mut data, start, end, 300, FadeShape::Linear), 300);
        assert_eq!(data[end - 1], original[start - 1], "the last sample of the loop is the one before the start");
        assert!((jump(&data) - natural_step).abs() < 1e-6, "the seam steps like the sample does at the start");
        assert_eq!(data[..end - 300], original[..end - 300], "nothing before the fade changes");
        assert_eq!(data[end..], original[end..], "nor after the loop");
    }

    #[test]
    fn equal_power_keeps_the_level_of_unrelated_material() {
        // white noise (xorshift32): the fade's two regions are unrelated
        let mut state = 0x9e37_79b9u32;
        let mut data: Vec<f32> = (0..2000)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as f32 / u32::MAX as f32 * 2.0 - 1.0
            })
            .collect();
        let rms = |d: &[f32]| (d.iter().map(|x| x * x).sum::<f32>() / d.len() as f32).sqrt();
        let before = rms(&data[1500..2000]);
        let mut linear = data.clone();
        crossfade_loop(&mut linear, 1000, 2000, 500, FadeShape::Linear);
        crossfade_loop(&mut data, 1000, 2000, 500, FadeShape::EqualPower);
        // the middle of the fade: linear dips about 3 dB, equal power doesn't
        assert!(rms(&linear[1700..1800]) < 0.8 * before);
        assert!((rms(&data[1700..1800]) / before - 1.0).abs() < 0.2);
    }

    #[test]
    fn an_attack_fades_in_what_is_played_first() {
        let mut data = vec![1.0; 10];
        assert_eq!(fade_in(&mut data, 2, 4, AttackShape::Linear, false), 4);
        assert_eq!(data, [1.0, 1.0, 0.0, 0.25, 0.5, 0.75, 1.0, 1.0, 1.0, 1.0]);
        let mut back = vec![1.0; 10];
        fade_in(&mut back, 7, 4, AttackShape::Curve, true);
        assert_eq!(back, [1.0, 1.0, 1.0, 1.0, 0.5625, 0.25, 0.0625, 0.0, 1.0, 1.0]);
        let mut short = vec![1.0; 4];
        assert_eq!(fade_in(&mut short, 2, 10, AttackShape::Linear, false), 2, "to the end of the sample");
        assert_eq!(fade_in(&mut short, 1, 10, AttackShape::Linear, true), 2, "back to its start");
    }

    #[test]
    fn length_is_limited_to_what_the_loop_has_room_for() {
        let mut data = vec![0.0; 100];
        assert_eq!(max_crossfade(100, 10, 90), 10, "the samples before the start");
        assert_eq!(max_crossfade(100, 60, 90), 30, "the loop length");
        assert_eq!(max_crossfade(100, 0, 90), 0);
        assert_eq!(max_crossfade(100, 50, 101), 0, "loop past the end");
        assert_eq!(crossfade_loop(&mut data, 10, 90, 50, FadeShape::Linear), 10);
        assert_eq!(crossfade_loop(&mut data, 0, 90, 50, FadeShape::Linear), 0);
    }
}
