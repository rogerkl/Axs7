//! Lowpass filters: a resonant 2-pole state variable filter with trapezoidal integration (zero delay feedback), which
//! stays stable while the cutoff is modulated, and the X7000's filter built from three of them.

#[derive(Clone, Debug, Default)]
pub struct Lowpass {
    ic1eq: f32,
    ic2eq: f32,
    g: f32,
    k: f32,
}

/// Highest cutoff as a fraction of the sample rate
const MAX_CUTOFF: f32 = 0.49;

impl Lowpass {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.ic1eq = 0.0;
        self.ic2eq = 0.0;
    }

    /// @param q 0.707 is flat, higher gives a resonance peak at the cutoff
    pub fn set(&mut self, cutoff: f32, q: f32, sample_rate: f32) {
        let fc = cutoff.clamp(10.0, MAX_CUTOFF * sample_rate);
        self.g = (core::f32::consts::PI * fc / sample_rate).tan();
        self.k = 1.0 / q.max(0.5);
    }

    pub fn process(&mut self, v0: f32) -> f32 {
        let a1 = 1.0 / (1.0 + self.g * (self.g + self.k));
        let a2 = self.g * a1;
        let a3 = self.g * a2;
        let v3 = v0 - self.ic2eq;
        let v1 = a1 * self.ic1eq + a2 * v3;
        let v2 = self.ic2eq + a2 * self.ic1eq + a3 * v3;
        self.ic1eq = 2.0 * v1 - self.ic1eq;
        self.ic2eq = 2.0 * v2 - self.ic2eq;
        v2
    }
}

/// The Q of each 2-pole section of a 6th order Butterworth lowpass: 1 / (2 cos θ) for its poles at θ = 15°, 45°, 75°
const BUTTERWORTH6_Q: [f32; 3] = [0.517_638_1, core::f32::consts::FRAC_1_SQRT_2, 1.931_851_6];

/// 6-pole Butterworth lowpass: 36 dB per octave, flat to the cutoff and no resonance. The X7000's filter measures as
/// one (a switched capacitor filter, its clock 50 times the cutoff): 3 dB down at the cutoff, 36 at twice it, 72 at
/// four times.
#[derive(Clone, Debug, Default)]
pub struct Butterworth6 {
    sections: [Lowpass; 3],
}

impl Butterworth6 {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn reset(&mut self) {
        self.sections.iter_mut().for_each(Lowpass::reset);
    }

    pub fn set(&mut self, cutoff: f32, sample_rate: f32) {
        for (section, q) in self.sections.iter_mut().zip(BUTTERWORTH6_Q) {
            section.set(cutoff, q, sample_rate);
        }
    }

    pub fn process(&mut self, x: f32) -> f32 {
        self.sections.iter_mut().fold(x, |y, section| section.process(y))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48000.0;

    /// Peak amplitude of the filtered sine after it has settled
    fn gain_at(frequency: f32, cutoff: f32, q: f32) -> f32 {
        let mut f = Lowpass::new();
        f.set(cutoff, q, SR);
        let mut peak: f32 = 0.0;
        for i in 0..(SR as usize / 2) {
            let x = (2.0 * core::f32::consts::PI * frequency * i as f32 / SR).sin();
            let y = f.process(x);
            if i > SR as usize / 4 {
                peak = peak.max(y.abs());
            }
        }
        peak
    }

    #[test]
    fn passes_below_and_cuts_above_the_cutoff() {
        assert!((gain_at(100.0, 2000.0, 0.707) - 1.0).abs() < 0.01);
        let two_octaves_up = gain_at(8000.0, 2000.0, 0.707);
        assert!(two_octaves_up < 0.07, "12 dB/octave: {two_octaves_up}");
    }

    #[test]
    fn resonance_peaks_at_the_cutoff() {
        assert!((gain_at(1000.0, 1000.0, 0.707) - 0.707).abs() < 0.02);
        assert!((gain_at(1000.0, 1000.0, 10.0) - 10.0).abs() < 0.5);
    }

    /// Gain of the 6-pole filter for a sine, after it has settled
    fn butterworth_gain(frequency: f32, cutoff: f32) -> f32 {
        let mut f = Butterworth6::new();
        f.set(cutoff, SR);
        let mut peak: f32 = 0.0;
        for i in 0..(SR as usize / 2) {
            // the phase in f64: in f32 it is too coarse after a while for 70 dB down
            let y = f.process((2.0 * core::f64::consts::PI * frequency as f64 * i as f64 / SR as f64).sin() as f32);
            if i > SR as usize / 4 {
                peak = peak.max(y.abs());
            }
        }
        peak
    }

    #[test]
    fn butterworth_is_flat_then_falls_36_db_an_octave() {
        let db = |g: f32| 20.0 * g.log10();
        assert!(db(butterworth_gain(250.0, 1000.0)).abs() < 0.1, "flat below the cutoff");
        assert!((db(butterworth_gain(1000.0, 1000.0)) + 3.0).abs() < 0.3, "3 dB down at the cutoff");
        assert!((db(butterworth_gain(2000.0, 1000.0)) + 36.1).abs() < 1.0, "36 dB at an octave above");
        // 73.4 at 48 kHz: the bilinear transform, matched at the cutoff, is a little steeper above it
        let two = db(butterworth_gain(4000.0, 1000.0));
        assert!((two + 73.4).abs() < 0.5, "72 dB at two: {two}");
        for f in [500.0, 700.0, 900.0] {
            assert!(butterworth_gain(f, 1000.0) <= 1.001, "no resonance peak at {f} Hz");
        }
    }

    #[test]
    fn stable_with_extreme_settings() {
        let mut f = Lowpass::new();
        for i in 0..48000 {
            f.set(if i % 2 == 0 { 20.0 } else { 30000.0 }, 50.0, SR);
            let y = f.process(if i % 100 < 50 { 1.0 } else { -1.0 });
            assert!(y.is_finite());
        }
    }
}
