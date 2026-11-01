//! A sample's sound parameters as the engine gets them, in physical units. Like on the X7000 they belong to the
//! sample (its OUT and LFO settings), not the program. The web side converts from the 0-99 values the user edits
//! (web/src/model/params.ts has the same layout).

pub const PARAM_COUNT: usize = 16;
pub type Params = [f32; PARAM_COUNT];

/// output level, linear
pub const LEVEL: usize = 0;
/// how much velocity changes the level, 0..1
pub const VEL_LEVEL: usize = 1;
/// lowpass cutoff in Hz, at the lowest velocity
pub const CUTOFF: usize = 2;
/// octaves the cutoff rises at full velocity
pub const VEL_FILTER: usize = 3;
/// seconds to fade after key off, for looping and alternating samples
pub const RELEASE: usize = 4;
/// how much velocity changes the release time, 0..1: softer notes get a shorter release
pub const VEL_RELEASE: usize = 5;
/// vibrato rate in Hz
pub const LFO_RATE: usize = 6;
/// vibrato depth in semitones
pub const LFO_DEPTH: usize = 7;
/// seconds after key on before the vibrato starts
pub const LFO_DELAY: usize = 8;
/// vibrato depth in semitones at full aftertouch, the X7000's pressure sens (no delay)
pub const PRESSURE_DEPTH: usize = 9;

pub const DEFAULT_PARAMS: Params = [
    0.5, 0.5, 20000.0, 0.0, // level, velocity to level, cutoff, velocity to filter
    0.3, 0.0, // release, velocity to release
    5.0, 0.0, 0.0, // LFO rate, depth, delay
    0.0, // aftertouch depth
    0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
];
