/**
 * ABI-based EVM log decoding — Issue #880 hardening.
 *
 * Replaces the previous `decodeEthEvent`, which matched `topics[0]` against
 * hex strings read from `ETH_TOPIC_CREDENTIAL_ISSUED`/`ETH_TOPIC_CREDENTIAL_REVOKED`
 * env vars: an operator typo or unset env var silently turned every event
 * into `type: 'Unknown'`, and there was no verification that `data` actually
 * decoded to the shape the caller expected. This decodes against the pinned
 * ABI in `src/abi/credentialBridgeEvents.ts` via `ethers.Interface`, which
 * both derives the correct topic0 from the ABI itself (no env var to get
 * out of sync) and validates/decodes the non-indexed `data` payload.
 */
import { Interface } from 'ethers';
import { CREDENTIAL_BRIDGE_ABI } from '../abi/credentialBridgeEvents.js';
import type { RawLog } from './mptProof.js';

export interface DecodedCredentialEvent {
  type: 'CredentialIssued' | 'CredentialRevoked';
  credentialId: string;
  holder?: string;
  issuer: string;
}

const iface = new Interface(CREDENTIAL_BRIDGE_ABI as unknown as string[]);

export class UnrecognizedLogError extends Error {}

/**
 * Decode a raw EVM log against the pinned credential-bridge ABI.
 * Throws `UnrecognizedLogError` if the log's topic0 doesn't match a known
 * event — callers must not treat an undecodable log as a soft "unknown"
 * event and continue; an anchor whose proof yields a log we don't recognize
 * cannot be considered a verified credential event.
 */
export function decodeCredentialLog(log: RawLog): DecodedCredentialEvent {
  let parsed;
  try {
    parsed = iface.parseLog({ topics: log.topics, data: log.data });
  } catch (err) {
    throw new UnrecognizedLogError(`Log does not decode against the pinned ABI: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed) {
    throw new UnrecognizedLogError('Log topic0 does not match any event in the pinned ABI');
  }

  if (parsed.name === 'CredentialIssued') {
    return {
      type: 'CredentialIssued',
      credentialId: parsed.args.credentialId.toString(),
      holder: parsed.args.holder as string,
      issuer: parsed.args.issuer as string,
    };
  }
  if (parsed.name === 'CredentialRevoked') {
    return {
      type: 'CredentialRevoked',
      credentialId: parsed.args.credentialId.toString(),
      issuer: parsed.args.issuer as string,
    };
  }
  throw new UnrecognizedLogError(`Unhandled event name from ABI: ${parsed.name}`);
}
