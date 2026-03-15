#!/bin/bash
set -e

echo "Building QuorumProof contracts..."
cargo build --release --target wasm32-unknown-unknown

echo "Build complete."
