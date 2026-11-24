//! Finding a forward loop in a sample: as long as it can be, with a jump back that doesn't click, and a level that
//! doesn't step at the jump, so the loop is heard as little as possible.
//!
//! A loop is scored by these, in dB, lower is better:
//! - the **seam**: how much the sound around the loop end differs from the sound around the loop start, which is
//!   what the jump puts after it. Each side of the jump is compared over a few ms, the samples nearest it most.
//! - the **level step**: the level over the last 50 ms of the loop against the first 50 ms, heard as a pumping at
//!   every turn (a dying sound steps most). How the level moves within the loop (a tremolo, voices beating) is part
//!   of the sound, and only counts when it is large: a gap, say.
//! - the **length**: shorter loops repeat more often, and are heard more.
//!
//! It searches all lengths and places in a coarse copy of the sample first, then follows the best few down to the
//! sample itself.

/// A seam this good is as good as none
const SEAM_FLOOR_DB: f32 = -50.0;
/// A dB of level step is as bad as this much seam
const STEP_WEIGHT: f32 = 6.0;
/// A step this small isn't heard (and a level measured over a few ms ripples this much on a steady low note)
const STEP_UNHEARD_DB: f32 = 0.5;
/// How far the level may move within the loop before it counts, and how much a dB more counts
const SWING_FREE_DB: f32 = 6.0;
const SWING_WEIGHT: f32 = 1.0;
/// How long the level at each end of a loop is measured over, in seconds
const STEP_S: f32 = 0.05;
/// Half the length is as bad as this much seam
const HALVING_DB: f32 = 12.0;
/// How far each side of the jump is compared, in seconds
const SEAM_S: f32 = 0.008;
/// The longest region searched place by place: longer ones are searched in a copy halved until it fits
const COARSE_MAX: usize = 2048;
/// The candidates followed from the coarse search down
const KEEP: usize = 48;

/// A loop `find_loop` found
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FoundLoop {
    pub start: usize,
    /// after the loop's last sample
    pub end: usize,
    /// how much the sound around the jump differs from what it continues, dB under the sound (very low for none)
    pub seam_db: f32,
    /// how much the level at the end of the loop differs from the level at its start, dB
    pub step_db: f32,
    /// how far the level goes up and down within the loop, dB
    pub swing_db: f32,
}

/// Finds the loop, start to end, within `lo..hi` of what plays, `min_len` to `max_len` samples long, that is
/// heard the least (see the module). `data` ends where playing ends (END): the sound after the jump is compared with
/// what comes after the loop end, which has to be there, a few ms of it, as do a few ms before the loop start.
///
/// @param min_end where the loop may end first: after where playing starts, when that is in the loop
/// @returns None if there is no room for one
pub fn find_loop(data: &[f32], lo: usize, hi: usize, min_len: usize, max_len: usize, min_end: usize, rate: f32)
    -> Option<FoundLoop> {
    let hi = hi.min(data.len());
    let min_len = min_len.max(2);
    if hi <= lo || max_len < min_len {
        return None;
    }
    let mut levels = 0;
    while (hi - lo) >> levels > COARSE_MAX {
        levels += 1;
    }
    let mut pyramid = vec![data.to_vec()];
    for _ in 0..levels {
        let half = halve(pyramid.last().unwrap());
        pyramid.push(half);
    }
    let search = Search { pyramid, levels: Levels::new(data, rate), lo, hi, min_len, max_len, min_end, rate };
    let mut candidates = search.coarse(levels);
    for level in (0..levels).rev() {
        candidates = candidates.iter().filter_map(|c| search.refine(c, level, true)).collect();
    }
    // a last look around each at the sample itself
    candidates
        .iter()
        .filter_map(|c| search.refine(c, 0, false))
        .min_by(|x, y| x.cost.total_cmp(&y.cost))
        .map(|c| FoundLoop {
            start: c.start,
            end: c.end,
            seam_db: seam_db(&search.pyramid[0], c.start, c.end, search.window(0), true),
            step_db: search.levels.step(c.start, c.end),
            swing_db: search.levels.range(c.start, c.end),
        })
}

#[derive(Clone, Copy, Debug)]
struct Candidate {
    /// in the samples of its level
    start: usize,
    end: usize,
    cost: f32,
}

struct Search {
    /// the sample, then halved again and again
    pyramid: Vec<Vec<f32>>,
    levels: Levels,
    lo: usize,
    hi: usize,
    min_len: usize,
    max_len: usize,
    min_end: usize,
    rate: f32,
}

impl Search {
    /// The samples compared on each side of the jump at a level
    fn window(&self, level: usize) -> usize {
        ((SEAM_S * self.rate / (1 << level) as f32).round() as usize).max(8)
    }

    fn cost(&self, seam_db: f32, start: usize, end: usize) -> f32 {
        seam_db.max(SEAM_FLOOR_DB)
            + self.levels.cost(start, end)
            + HALVING_DB * (self.max_len as f32 / (end - start) as f32).log2()
    }

    /// The limits of a loop at a level, in its samples: first start, last end, shortest, longest, first end
    fn limits(&self, level: usize) -> (usize, usize, usize, usize, usize) {
        let scale = 1 << level;
        let n = self.pyramid[level].len();
        let w = self.window(level);
        (self.lo.div_ceil(scale).max(w), (self.hi / scale).min(n.saturating_sub(w)), self.min_len.div_ceil(scale).max(1),
            self.max_len / scale, self.min_end.div_ceil(scale))
    }

    /// Every length and place at the coarsest level, a running sum of the seam's differences for each length: the
    /// best place of each length, the best of those
    fn coarse(&self, level: usize) -> Vec<Candidate> {
        let y = &self.pyramid[level];
        let w = self.window(level);
        let scale = 1 << level;
        let (first, last, shortest, longest, first_end) = self.limits(level);
        let mut energy = vec![0.0f64; y.len() + 1];
        for (i, v) in y.iter().enumerate() {
            energy[i + 1] = energy[i] + (*v as f64) * (*v as f64);
        }
        let diff = |i: usize, len: usize| {
            let d = (y[i] - y[i + len]) as f64;
            d * d
        };
        let mut best = Vec::new();
        for len in shortest..=longest {
            let first = first.max(first_end.saturating_sub(len));
            if first + len > last {
                continue;
            }
            let mut num: f64 = (first - w..first + w).map(|i| diff(i, len)).sum();
            let mut pick: Option<(f32, usize)> = None;
            for start in first..=last - len {
                if start > first {
                    num += diff(start + w - 1, len) - diff(start - 1 - w, len);
                }
                let end = start + len;
                let den = (energy[start + w] - energy[start - w]) + (energy[end + w] - energy[end - w]);
                let cost = ratio_db(num.max(0.0), den).max(SEAM_FLOOR_DB)
                    + self.levels.cost(start * scale, end * scale);
                if pick.is_none_or(|(c, _)| cost < c) {
                    pick = Some((cost, start));
                }
            }
            if let Some((cost, start)) = pick {
                let length = HALVING_DB * (self.max_len as f32 / (len * scale) as f32).log2();
                best.push(Candidate { start, end: start + len, cost: cost + length });
            }
        }
        best.sort_by(|x, y| x.cost.total_cmp(&y.cost));
        let mut kept: Vec<Candidate> = Vec::new();
        for c in best {
            let near = |k: &Candidate| k.start.abs_diff(c.start) <= 2 && k.end.abs_diff(c.end) <= 2;
            if !kept.iter().any(near) {
                kept.push(c);
                if kept.len() == KEEP {
                    break;
                }
            }
        }
        kept
    }

    /// The best loop near a candidate at a level: its places doubled from the level above, or as they are, two samples
    /// either way
    fn refine(&self, c: &Candidate, level: usize, from_above: bool) -> Option<Candidate> {
        let y = &self.pyramid[level];
        let w = self.window(level);
        let scale = 1 << level;
        let (first, last, shortest, longest, first_end) = self.limits(level);
        let (start, end) = if from_above { (c.start * 2, c.end * 2) } else { (c.start, c.end) };
        let mut best: Option<Candidate> = None;
        for s in start.saturating_sub(2)..=start + 2 {
            for e in end.saturating_sub(2)..=end + 2 {
                if s < first || e > last || e < s + shortest || e > s + longest || e < first_end {
                    continue;
                }
                let cost = self.cost(seam_db(y, s, e, w, true), s * scale, e * scale);
                if best.is_none_or(|b| cost < b.cost) {
                    best = Some(Candidate { start: s, end: e, cost });
                }
            }
        }
        best
    }
}

/// num / den in dB; silence (no den) is as bad as no likeness at all
fn ratio_db(num: f64, den: f64) -> f32 {
    if den <= 1e-20 {
        return 0.0;
    }
    (10.0 * (num / den).max(1e-12).log10()) as f32
}

/// How much the `w` samples each side of `end` differ from those each side of `start`, against their level: what the
/// jump from end back to start puts in place of what was there. Weighted, the samples nearest the jump count most.
fn seam_db(y: &[f32], start: usize, end: usize, w: usize, weighted: bool) -> f32 {
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for k in 0..2 * w {
        let weight = if weighted { (w as f64 - (k as f64 + 0.5 - w as f64).abs()) / w as f64 } else { 1.0 };
        let (a, b) = (y[start + k - w] as f64, y[end + k - w] as f64);
        num += weight * (a - b) * (a - b);
        den += weight * (a * a + b * b);
    }
    ratio_db(num, den)
}

/// Half the samples, lowpassed first so nothing folds back: a 15 tap half band filter
fn halve(x: &[f32]) -> Vec<f32> {
    const TAPS: usize = 15;
    let c = (TAPS / 2) as isize;
    let mut h = [0.0f32; TAPS];
    for (i, tap) in h.iter_mut().enumerate() {
        let n = i as isize - c;
        let sinc = if n == 0 { 0.5 } else { (core::f32::consts::FRAC_PI_2 * n as f32).sin() / (core::f32::consts::PI * n as f32) };
        let t = i as f32 / (TAPS - 1) as f32;
        let blackman = 0.42 - 0.5 * (2.0 * core::f32::consts::PI * t).cos() + 0.08 * (4.0 * core::f32::consts::PI * t).cos();
        *tap = sinc * blackman;
    }
    let sum: f32 = h.iter().sum();
    (0..x.len().div_ceil(2))
        .map(|i| {
            let mut v = 0.0;
            for (k, tap) in h.iter().enumerate() {
                let j = 2 * i as isize + k as isize - c;
                if j >= 0 && (j as usize) < x.len() {
                    v += tap * x[j as usize];
                }
            }
            v / sum
        })
        .collect()
}

/// The level of a sample: over any stretch, and every 5 ms over 25 ms, to tell how far it goes up and down
struct Levels {
    /// the sum of the squares before each sample
    energy: Vec<f64>,
    /// samples in STEP_S
    step: usize,
    hop: usize,
    /// per power of two: the lowest and highest level of that many frames from each
    low: Vec<Vec<f32>>,
    high: Vec<Vec<f32>>,
}

impl Levels {
    fn new(data: &[f32], rate: f32) -> Levels {
        let hop = ((0.005 * rate).round() as usize).max(1);
        let half = ((0.0125 * rate).round() as usize).max(1);
        let mut energy = vec![0.0f64; data.len() + 1];
        for (i, v) in data.iter().enumerate() {
            energy[i + 1] = energy[i] + (*v as f64) * (*v as f64);
        }
        let db: Vec<f32> = (0..data.len().div_ceil(hop).max(1))
            .map(|j| {
                let c = j * hop;
                let (from, to) = (c.saturating_sub(half), (c + half).min(data.len()));
                let mean = if to > from { (energy[to] - energy[from]) / (to - from) as f64 } else { 0.0 };
                (10.0 * mean.max(1e-12).log10()) as f32
            })
            .collect();
        let (mut low, mut high) = (vec![db.clone()], vec![db]);
        let mut span = 1;
        while span * 2 <= low[0].len() {
            let (l, h) = (low.last().unwrap(), high.last().unwrap());
            let n = l.len() - span;
            low.push((0..n).map(|i| l[i].min(l[i + span])).collect());
            high.push((0..n).map(|i| h[i].max(h[i + span])).collect());
            span *= 2;
        }
        Levels { energy, step: ((STEP_S * rate).round() as usize).max(1), hop, low, high }
    }

    /// The level of from..to, dB
    fn level(&self, from: usize, to: usize) -> f32 {
        let mean = (self.energy[to] - self.energy[from]) / (to - from).max(1) as f64;
        (10.0 * mean.max(1e-12).log10()) as f32
    }

    /// How much the level at the end of start..end differs from the level at its start, dB: STEP_S of each, or half
    /// of a shorter loop
    fn step(&self, start: usize, end: usize) -> f32 {
        let t = self.step.min((end - start) / 2).max(1);
        (self.level(end - t, end) - self.level(start, start + t)).abs()
    }

    /// What the level does in start..end adds to a loop's cost
    fn cost(&self, start: usize, end: usize) -> f32 {
        STEP_WEIGHT * (self.step(start, end) - STEP_UNHEARD_DB).max(0.0)
            + SWING_WEIGHT * (self.range(start, end) - SWING_FREE_DB).max(0.0)
    }

    /// How far the level goes up and down over the frames whose middles are in start..end, dB
    fn range(&self, start: usize, end: usize) -> f32 {
        let frames = self.low[0].len();
        let first = start.div_ceil(self.hop).min(frames - 1);
        let last = ((end.max(1) - 1) / self.hop).min(frames - 1).max(first);
        let count = last - first + 1;
        let k = (usize::BITS - 1 - count.leading_zeros()) as usize;
        let (span, l, h) = (1 << k, &self.low[k], &self.high[k]);
        h[first].max(h[last + 1 - span]) - l[first].min(l[last + 1 - span])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 39555.4;

    /// A tone of a few harmonics, `period` samples a cycle, its level `gain(i)`
    fn tone(len: usize, period: f64, gain: impl Fn(usize) -> f32) -> Vec<f32> {
        (0..len)
            .map(|i| {
                let t = 2.0 * core::f64::consts::PI * i as f64 / period;
                gain(i) * (0.6 * t.sin() + 0.3 * (2.0 * t + 0.4).sin() + 0.1 * (5.0 * t + 1.1).sin()) as f32
            })
            .collect()
    }

    #[test]
    fn a_steady_tone_loops_on_whole_cycles_as_long_as_allowed() {
        let data = tone(20000, 100.0, |_| 0.8);
        let found = find_loop(&data, 1000, 19000, 400, 16000, 0, RATE).unwrap();
        let len = found.end - found.start;
        assert_eq!(len % 100, 0, "whole cycles: {found:?}");
        assert!(len > 15800 && len <= 16000, "as long as allowed: {found:?}");
        assert!(found.seam_db < -60.0 && found.step_db < 0.3, "{found:?}");
        assert!(found.start >= 1000 && found.end <= 19000);
    }

    #[test]
    fn a_cycle_of_no_whole_samples_still_loops_smoothly() {
        let data = tone(30000, 89.37, |_| 0.8);
        let found = find_loop(&data, 0, 30000, 400, 24000, 0, RATE).unwrap();
        let cycles = (found.end - found.start) as f64 / 89.37;
        assert!((cycles - cycles.round()).abs() < 0.03, "{cycles} cycles");
        assert!(found.seam_db < -30.0, "{found:?}");
        assert!(found.end - found.start > 20000, "{found:?}");
    }

    #[test]
    fn a_dying_sound_gets_a_shorter_loop_that_doesnt_pump() {
        // falling 12 dB a second: a loop of all of it would swing 9 dB
        let data = tone(32000, 100.0, |i| 0.25f32.powf(i as f32 / RATE));
        let found = find_loop(&data, 0, 32000, 400, 31000, 0, RATE).unwrap();
        assert!(found.step_db < 4.0, "{found:?}");
        assert!(found.end - found.start < 15000, "{found:?}");
        assert_eq!((found.end - found.start) % 100, 0);
    }

    #[test]
    fn noise_gets_a_loop_all_the_same() {
        let mut state = 0x2545_f491u32;
        let data: Vec<f32> = (0..20000)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state as f32 / u32::MAX as f32 - 0.5
            })
            .collect();
        let found = find_loop(&data, 0, 20000, 400, 15000, 0, RATE).unwrap();
        assert!(found.end - found.start <= 15000 && found.end - found.start >= 400);
        assert!(found.seam_db > -10.0, "noise doesn't match itself: {found:?}");
    }

    #[test]
    fn the_loop_ends_after_where_playing_starts() {
        let data = tone(20000, 100.0, |_| 0.8);
        let found = find_loop(&data, 1000, 19000, 400, 5000, 15000, RATE).unwrap();
        assert!(found.end >= 15000 && found.end - found.start <= 5000, "{found:?}");
        assert_eq!(find_loop(&data, 1000, 19000, 400, 5000, 19500, RATE), None);
    }

    #[test]
    fn no_room_no_loop() {
        let data = tone(2000, 100.0, |_| 0.5);
        assert_eq!(find_loop(&data, 500, 600, 400, 1000, 0, RATE), None, "a region shorter than the shortest loop");
        assert_eq!(find_loop(&data, 0, 2000, 900, 800, 0, RATE), None);
        assert_eq!(find_loop(&data, 1990, 2000, 2, 10, 0, RATE), None, "no room after it for the seam");
    }

    #[test]
    fn the_level_step_and_range() {
        // 20 dB down after the middle
        let data: Vec<f32> = (0..8000).map(|i| if i < 4000 { 0.5 } else { 0.05 } * if i % 2 == 0 { 1.0 } else { -1.0 }).collect();
        let levels = Levels::new(&data, 8000.0);
        assert!(levels.range(0, 3500) < 0.01);
        assert!((levels.range(0, 8000) - 20.0).abs() < 0.01, "{}", levels.range(0, 8000));
        assert!(levels.range(4700, 8000) < 0.01);
        assert!((levels.step(0, 8000) - 20.0).abs() < 0.01, "the end 20 dB under the start");
        assert!(levels.step(3000, 3400) < 0.01);
        assert!(levels.step(1000, 4000) < 0.01, "both ends at the same level");
    }

    #[test]
    fn voices_beating_within_a_loop_are_part_of_the_sound() {
        // two tones a hertz apart: the level comes and goes every second, a loop of whole seconds steps none
        let data: Vec<f32> = (0..(2.6 * RATE) as usize)
            .map(|i| {
                let t = i as f32 / RATE;
                0.4 * (2.0 * core::f32::consts::PI * 200.0 * t).sin() + 0.4 * (2.0 * core::f32::consts::PI * 201.0 * t).sin()
            })
            .collect();
        let max = (2.2 * RATE) as usize;
        let found = find_loop(&data, 0, data.len(), 400, max, 0, RATE).unwrap();
        assert!(found.end - found.start > (0.9 * RATE) as usize, "a long loop, not a short one: {found:?}");
        assert!(found.swing_db > 10.0 && found.step_db < 1.0, "{found:?}");
    }
}
