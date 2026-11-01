//! Voice engine of the Axs7 virtual sampler. Built for wasm32-unknown-unknown and run in an AudioWorklet, with a
//! plain C ABI (no wasm-bindgen, so the worklet needs no glue code). The module has no imports.
//!
//! Memory protocol: the web side allocates a sample buffer with `alloc_f32`, fills it and hands it over with
//! `engine_set_sample`, which takes ownership. Program parameters are written to `engine_params` and applied with
//! `engine_set_program`. `engine_process` returns a pointer to the rendered mono block.
//!
//! The `dsp_` functions edit a buffer from `alloc_f32` in place, for the web side's main thread.

pub mod dsp;
pub mod engine;
pub mod envelope;
pub mod filter;
pub mod params;
pub mod voice;

use core::ptr::slice_from_raw_parts_mut;

use engine::Engine;
use voice::{LoopMode, NoteOn};

#[no_mangle]
pub extern "C" fn alloc_f32(len: usize) -> *mut f32 {
    Box::into_raw(vec![0.0f32; len].into_boxed_slice()) as *mut f32
}

/// # Safety
/// `ptr` and `len` from `alloc_f32`, not handed to the engine
#[no_mangle]
pub unsafe extern "C" fn free_f32(ptr: *mut f32, len: usize) {
    drop(Box::from_raw(slice_from_raw_parts_mut(ptr, len)));
}

#[no_mangle]
pub extern "C" fn engine_new(sample_rate: f32) -> *mut Engine {
    Box::into_raw(Box::new(Engine::new(sample_rate)))
}

/// # Safety
/// `engine` from `engine_new`, here and in the functions below
#[no_mangle]
pub unsafe extern "C" fn engine_params(engine: *mut Engine) -> *mut f32 {
    (*engine).params_in.as_mut_ptr()
}

/// # Safety
/// see `engine_params`
#[no_mangle]
pub unsafe extern "C" fn engine_set_program(engine: *mut Engine, id: u32) {
    let params = (*engine).params_in;
    (*engine).set_program(id, params);
}

/// Takes ownership of the buffer
///
/// # Safety
/// `data` and `len` from `alloc_f32`
#[no_mangle]
pub unsafe extern "C" fn engine_set_sample(engine: *mut Engine, id: u32, data: *mut f32, len: usize, rate: f32) {
    let data = Box::from_raw(slice_from_raw_parts_mut(data, len)).into_vec();
    (*engine).set_sample(id, data, rate);
}

/// # Safety
/// see `engine_params`
#[no_mangle]
pub unsafe extern "C" fn engine_remove_sample(engine: *mut Engine, id: u32) {
    (*engine).remove_sample(id);
}

/// # Safety
/// see `engine_params`
#[no_mangle]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn engine_note_on(engine: *mut Engine, key: u32, velocity: f32, program: u32, sample: u32,
    ratio: f64, loop_start: u32, loop_end: u32, loop_mode: u32, gain: f32) {
    (*engine).note_on(NoteOn {
        key,
        velocity,
        program,
        sample,
        ratio,
        loop_start: loop_start as usize,
        loop_end: loop_end as usize,
        loop_mode: LoopMode::from_u32(loop_mode),
        gain,
    });
}

/// # Safety
/// see `engine_params`
#[no_mangle]
pub unsafe extern "C" fn engine_note_off(engine: *mut Engine, key: u32) {
    (*engine).note_off(key);
}

/// # Safety
/// see `engine_params`
#[no_mangle]
pub unsafe extern "C" fn engine_all_notes_off(engine: *mut Engine, hard: u32) {
    (*engine).all_notes_off(hard != 0);
}

/// # Safety
/// see `engine_params`
#[no_mangle]
pub unsafe extern "C" fn engine_set_bend(engine: *mut Engine, semitones: f32) {
    (*engine).set_bend(semitones);
}

/// # Safety
/// see `engine_params`
#[no_mangle]
pub unsafe extern "C" fn engine_set_modulation(engine: *mut Engine, amount: f32) {
    (*engine).set_modulation(amount);
}

/// # Safety
/// see `engine_params`
#[no_mangle]
pub unsafe extern "C" fn engine_set_volume(engine: *mut Engine, volume: f32) {
    (*engine).set_volume(volume);
}

/// # Safety
/// see `engine_params`
#[no_mangle]
pub unsafe extern "C" fn engine_set_polyphony(engine: *mut Engine, voices: u32) {
    (*engine).set_polyphony(voices as usize);
}

/// # Safety
/// see `engine_params`
#[no_mangle]
pub unsafe extern "C" fn engine_active_voices(engine: *mut Engine) -> u32 {
    (*engine).active_voices() as u32
}

/// Crossfades a forward loop's end into what comes before its start, see `dsp::crossfade_loop`
///
/// @param shape 0 linear, 1 equal power
/// @returns the length used
///
/// # Safety
/// `data` and `len` from `alloc_f32`
#[no_mangle]
pub unsafe extern "C" fn dsp_crossfade_loop(data: *mut f32, len: usize, loop_start: u32, loop_end: u32, length: u32,
    shape: u32) -> u32 {
    let data = core::slice::from_raw_parts_mut(data, len);
    dsp::crossfade_loop(data, loop_start as usize, loop_end as usize, length as usize, dsp::FadeShape::from_u32(shape))
        as u32
}

/// @returns the rendered block, valid until the next call
///
/// # Safety
/// see `engine_params`
#[no_mangle]
pub unsafe extern "C" fn engine_process(engine: *mut Engine, frames: u32) -> *const f32 {
    (*engine).process(frames as usize).as_ptr()
}
