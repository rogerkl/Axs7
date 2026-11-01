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

#[cfg(test)]
mod tests {
    use super::*;

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
