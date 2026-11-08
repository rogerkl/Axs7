//! A sample's sound parameters as the engine gets them, in physical units. Like on the X7000 they belong to the
//! sample (its OUT and LFO settings), not the program. The web side converts from the 0-99 values the user edits
//! (web/src/model/params.ts has the same layout).

pub const PARAM_COUNT: usize = 16;
pub type Params = [f32; PARAM_COUNT];

/// output level, linear (the X7000's LEVEL), before velocity
pub const LEVEL: usize = 0;
/// how much velocity changes the level, 0..1 (VEL>LEVEL): see voice.rs for how, as measured on the X7000
pub const VEL_LEVEL: usize = 1;
/// lowpass cutoff in Hz at velocity 64, where velocity doesn't move it
pub const CUTOFF: usize = 2;
/// octaves the cutoff moves from velocity 64 to 0 (down) or to 128 (up), within CUTOFF_MIN..CUTOFF_MAX
pub const VEL_FILTER: usize = 3;
/// seconds to fall 60 dB after key off, for looping and alternating samples, at note off velocity 64
pub const RELEASE: usize = 4;
/// doublings of the release time from note off velocity 64 to 0 (longer) or halvings to 128 (shorter), within
/// RELEASE_MIN..RELEASE_MAX: the X7000's VEL>RELEASE follows how fast the key comes up, not how hard it went down
pub const VEL_RELEASE: usize = 5;
/// vibrato rate in Hz, a sine starting at key on; 0 stops it
pub const LFO_RATE: usize = 6;
/// vibrato depth in the X7000's steps, 0..7 (see voice::vibrato_depth)
pub const LFO_DEPTH: usize = 7;
/// seconds between the depth's steps as the vibrato comes in after key on, 0 for all at once
pub const LFO_DELAY: usize = 8;
/// the X7000's pressure sens, 0..1: scales the steps of vibrato channel aftertouch gives (no delay)
pub const PRESSURE_DEPTH: usize = 9;
/// the lowest and highest cutoff velocity takes it to, Hz: the X7000's at FILTER 0 and 99
pub const CUTOFF_MIN: usize = 10;
pub const CUTOFF_MAX: usize = 11;
/// the shortest and longest release velocity takes it to, seconds
pub const RELEASE_MIN: usize = 12;
pub const RELEASE_MAX: usize = 13;

pub const DEFAULT_PARAMS: Params = [
    0.5, 0.5, 20000.0, 0.0, // level, velocity to level, cutoff, velocity to filter
    0.3, 0.0, // release, velocity to release
    5.0, 0.0, 0.0, // LFO rate, depth (steps), delay (seconds a step)
    0.0, // aftertouch depth
    10.0, 20000.0, // the cutoff's range
    0.005, 20.0, // the release's
    0.0, 0.0,
];
