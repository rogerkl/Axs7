//! Layout of a program's parameters as the engine gets them, in physical units. The web side converts from the
//! 0-99 values the user edits (web/src/model/params.ts has the same layout).

pub const PARAM_COUNT: usize = 16;
pub type Params = [f32; PARAM_COUNT];

/// output level, linear
pub const LEVEL: usize = 0;
/// how much velocity changes the level, 0..1
pub const VELOCITY: usize = 1;
/// Hz
pub const CUTOFF: usize = 2;
/// Q, 0.707 is flat
pub const RESONANCE: usize = 3;
/// octaves the filter envelope moves the cutoff at full level, negative moves it down
pub const ENV_AMOUNT: usize = 4;
/// attack, decay, sustain, release in seconds, seconds, 0..1, seconds
pub const FILTER_ATTACK: usize = 5;
pub const AMP_ATTACK: usize = 9;

pub const DEFAULT_PARAMS: Params = [
    0.5, 0.5, 20000.0, 0.707, 0.0, // level, velocity, cutoff, resonance, env amount
    0.001, 0.5, 1.0, 0.3, // filter envelope
    0.001, 0.5, 1.0, 0.3, // amp envelope
    0.0, 0.0, 0.0,
];
