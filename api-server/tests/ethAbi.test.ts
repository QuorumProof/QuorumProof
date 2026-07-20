import { describe, it, expect } from 'vitest';
import { Interface, Wallet, id as topicId } from 'ethers';
import { decodeCredentialLog, UnrecognizedLogError } from '../src/services/ethAbi.js';
import { CREDENTIAL_BRIDGE_ABI } from '../src/abi/credentialBridgeEvents.js';

const iface = new Interface(CREDENTIAL_BRIDGE_ABI as unknown as string[]);

describe('decodeCredentialLog', () => {
  it('decodes a genuine CredentialIssued log against the pinned ABI', () => {
    const holder = Wallet.createRandom().address;
    const issuer = Wallet.createRandom().address;
    const encoded = iface.encodeEventLog(iface.getEvent('CredentialIssued')!, [42n, holder, issuer]);

    const decoded = decodeCredentialLog({
      address: issuer,
      topics: encoded.topics,
      data: encoded.data,
    });

    expect(decoded.type).toBe('CredentialIssued');
    expect(decoded.credentialId).toBe('42');
    expect(decoded.holder?.toLowerCase()).toBe(holder.toLowerCase());
    expect(decoded.issuer?.toLowerCase()).toBe(issuer.toLowerCase());
  });

  it('decodes a genuine CredentialRevoked log', () => {
    const issuer = Wallet.createRandom().address;
    const encoded = iface.encodeEventLog(iface.getEvent('CredentialRevoked')!, [7n, issuer]);

    const decoded = decodeCredentialLog({ address: issuer, topics: encoded.topics, data: encoded.data });
    expect(decoded.type).toBe('CredentialRevoked');
    expect(decoded.credentialId).toBe('7');
  });

  it('rejects a log whose topic0 is not in the pinned ABI', () => {
    const bogusTopic0 = topicId('SomeOtherEvent(uint256)');
    expect(() =>
      decodeCredentialLog({
        address: Wallet.createRandom().address,
        topics: [bogusTopic0, '0x' + '00'.repeat(32)],
        data: '0x',
      }),
    ).toThrow(UnrecognizedLogError);
  });

  it('rejects a log with malformed data that fails ABI decoding', () => {
    const frag = iface.getEvent('CredentialIssued')!;
    expect(() =>
      decodeCredentialLog({
        address: Wallet.createRandom().address,
        topics: [frag.topicHash], // missing the two indexed address topics
        data: '0x',
      }),
    ).toThrow(UnrecognizedLogError);
  });
});
