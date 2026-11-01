#!/bin/sh
# Builds the Rust voice engine to wasm and puts it where Vite serves it from.
# Needs the wasm target: rustup target add wasm32-unknown-unknown
set -e
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown -p axs7_engine
mkdir -p web/public
cp target/wasm32-unknown-unknown/release/axs7_engine.wasm web/public/engine.wasm
