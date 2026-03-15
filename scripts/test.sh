#!/bin/bash
set -e

echo "Running QuorumProof tests..."
cargo test

echo "All tests passed."
