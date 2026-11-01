//! ADSR envelope. The attack rises linearly, decay and release fall exponentially and reach -60 dB of their
//! distance at the set time, like an analog envelope.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

/// Times in seconds, sustain 0..1
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Adsr {
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
}

/// Below this the envelope is silent
const FLOOR: f32 = 1e-4;
const MIN_TIME: f32 = 0.0005;

#[derive(Clone, Debug)]
pub struct Envelope {
    stage: Stage,
    level: f32,
    attack_step: f32,
    decay_coef: f32,
    release_coef: f32,
    sustain: f32,
}

/// Coefficient for an exponential fall to -60 dB in `time` seconds
fn fall_coef(time: f32, sample_rate: f32) -> f32 {
    (0.001f32.ln() / (time.max(MIN_TIME) * sample_rate)).exp()
}

impl Default for Envelope {
    fn default() -> Self {
        Self::new()
    }
}

impl Envelope {
    pub fn new() -> Self {
        Envelope { stage: Stage::Idle, level: 0.0, attack_step: 1.0, decay_coef: 0.0, release_coef: 0.0, sustain: 1.0 }
    }

    /// Updates the times and sustain level, also while the envelope runs
    pub fn set(&mut self, p: &Adsr, sample_rate: f32) {
        self.attack_step = 1.0 / (p.attack.max(MIN_TIME) * sample_rate);
        self.decay_coef = fall_coef(p.decay, sample_rate);
        self.release_coef = fall_coef(p.release, sample_rate);
        self.sustain = p.sustain.clamp(0.0, 1.0);
    }

    /// Starts the attack from the current level, so a retriggered note doesn't click
    pub fn trigger(&mut self) {
        self.stage = Stage::Attack;
    }

    pub fn release(&mut self) {
        if self.stage != Stage::Idle {
            self.stage = Stage::Release;
        }
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }

    pub fn level(&self) -> f32 {
        self.level
    }

    pub fn is_idle(&self) -> bool {
        self.stage == Stage::Idle
    }

    pub fn tick(&mut self) -> f32 {
        match self.stage {
            Stage::Idle => {}
            Stage::Attack => {
                self.level += self.attack_step;
                if self.level >= 1.0 {
                    self.level = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.level = self.sustain + (self.level - self.sustain) * self.decay_coef;
                if self.level - self.sustain < FLOOR {
                    self.level = self.sustain;
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => {
                // follows sustain changes while held
                self.level = self.sustain + (self.level - self.sustain) * 0.999;
            }
            Stage::Release => {
                self.level *= self.release_coef;
                if self.level < FLOOR {
                    self.level = 0.0;
                    self.stage = Stage::Idle;
                }
            }
        }
        self.level
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f32 = 48000.0;

    fn run(env: &mut Envelope, seconds: f32) -> f32 {
        let mut level = 0.0;
        for _ in 0..(seconds * SR) as usize {
            level = env.tick();
        }
        level
    }

    #[test]
    fn attack_decay_sustain_release() {
        let mut env = Envelope::new();
        env.set(&Adsr { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.2 }, SR);
        env.trigger();
        assert!((run(&mut env, 0.005) - 0.5).abs() < 0.01, "halfway through the attack");
        run(&mut env, 0.006);
        assert_eq!(env.stage(), Stage::Decay);
        let after_decay = run(&mut env, 0.1);
        assert!((after_decay - 0.5) < 0.5 * 0.0011, "-60 dB of the way to sustain after the decay time");
        run(&mut env, 0.1);
        assert_eq!(env.stage(), Stage::Sustain);
        env.release();
        let after_release = run(&mut env, 0.2);
        assert!((after_release / 0.5 - 0.001).abs() < 0.0002, "-60 dB after the release time");
        run(&mut env, 0.1);
        assert!(env.is_idle());
        assert_eq!(env.level(), 0.0);
    }

    #[test]
    fn release_during_attack_and_retrigger_from_level() {
        let mut env = Envelope::new();
        env.set(&Adsr { attack: 0.1, decay: 0.1, sustain: 1.0, release: 0.05 }, SR);
        env.trigger();
        let level = run(&mut env, 0.05);
        env.release();
        let falling = run(&mut env, 0.01);
        assert!(falling < level);
        env.trigger();
        assert!(env.tick() > falling, "attack continues from the current level");
    }

    #[test]
    fn idle_envelope_ignores_release() {
        let mut env = Envelope::new();
        env.release();
        assert!(env.is_idle());
        assert_eq!(env.tick(), 0.0);
    }
}
