#!/bin/bash
set -e

NETWORK=${STELLAR_NETWORK:-testnet}
TEST_THREADS=${TEST_THREADS:-1}

echo "Running E2E tests on $NETWORK..."
echo "Using $TEST_THREADS test thread(s)"

cd contracts/e2e_tests

STELLAR_NETWORK=$NETWORK cargo test --release -- --test-threads=$TEST_THREADS --nocapture

echo "E2E tests completed successfully on $NETWORK"
