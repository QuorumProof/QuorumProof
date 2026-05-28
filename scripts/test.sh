#!/bin/bash
set -e

echo "Running QuorumProof tests..."
cargo test --target x86_64-unknown-linux-gnu

echo "All tests passed."
