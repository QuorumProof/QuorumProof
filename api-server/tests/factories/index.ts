/**
 * Test data factories for the API server test suite (Issue #1677).
 *
 * Import from here rather than from the individual modules:
 *
 *   import { buildCredential, buildSlice, buildSbt } from './factories/index.js';
 *
 * Each factory returns plain JSON-shaped fixtures. Call
 * `resetFactorySequences()` in a `beforeEach` when a test needs ids to start
 * from the same value every time. See docs/test-factories.md.
 */

import { resetCredentialSequence } from './credential.js';
import { resetSliceSequence } from './slice.js';
import { resetSbtSequence } from './sbt.js';
import { resetStellarAddressSequence } from './stellar.js';

export * from './stellar.js';
export * from './credential.js';
export * from './slice.js';
export * from './sbt.js';

/** Reset every factory's id and address sequence to its initial state. */
export function resetFactorySequences(): void {
  resetCredentialSequence();
  resetSliceSequence();
  resetSbtSequence();
  resetStellarAddressSequence();
}
