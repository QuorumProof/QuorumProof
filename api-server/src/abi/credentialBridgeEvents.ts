/**
 * Pinned ABI for the foreign-chain credential contract events the bridge
 * decodes — Issue #880 hardening.
 *
 * This is intentionally checked into source control (not fetched from an
 * env var or a remote registry) so that a change to the emitting contract's
 * event signatures requires a reviewed PR here, not a runtime config edit
 * that can silently change what the bridge treats as a valid credential
 * event.
 *
 * ABI_VERSION must be bumped whenever this array changes, and the emitting
 * contract address/deployment this ABI was pinned against should be tracked
 * in the PR description.
 */
export const CREDENTIAL_BRIDGE_ABI_VERSION = 'v1';

export const CREDENTIAL_BRIDGE_ABI = [
  {
    type: 'event',
    name: 'CredentialIssued',
    inputs: [
      { name: 'credentialId', type: 'uint256', indexed: true },
      { name: 'holder', type: 'address', indexed: true },
      { name: 'issuer', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
  {
    type: 'event',
    name: 'CredentialRevoked',
    inputs: [
      { name: 'credentialId', type: 'uint256', indexed: true },
      { name: 'issuer', type: 'address', indexed: true },
    ],
    anonymous: false,
  },
] as const;
