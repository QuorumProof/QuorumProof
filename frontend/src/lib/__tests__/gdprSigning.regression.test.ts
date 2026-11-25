import { describe, expect, it, vi } from 'vitest';
import { signMessage } from '@stellar/freighter-api';
import * as gdprSigning from '../gdprSigning';

vi.mock('@stellar/freighter-api', () => ({ signMessage: vi.fn() }));

describe('GDPR signing API', () => {
  // regression: #1983
  // The old export promised signer extraction but always returned null.
  // Restoring that stub must fail this public API contract test.
  it('regression_1983_does_not_expose_placeholder_signer_recovery', () => {
    expect(gdprSigning).not.toHaveProperty('extractSignerAddress');
  });

  // regression: #1983
  // Removing client-side recovery must retain the claimed address and signature
  // in the payload, so a server can verify them against the credential subject.
  it('regression_1983_preserves_the_payload_for_server_verification', async () => {
    const subjectAddress = 'GAXMCLWLFVD4KELSYDTC35U3OWVEH37RCLJLQ3BX4UD4EW7J5YPAHH';
    const signature = 'dGVzdFNpZ25hdHVyZQ==';
    vi.mocked(signMessage).mockResolvedValue({ signedMessage: signature, signerAddress: subjectAddress });

    const payload = await gdprSigning.createSignedGdprRequest(42, subjectAddress);

    expect(payload).toEqual({
      credentialId: 42,
      challenge: expect.any(String),
      subjectAddress,
      signature,
    });
    expect(signMessage).toHaveBeenCalledWith(
      `GDPR_REQUEST:42:${payload.challenge}:${subjectAddress}`,
    );
  });
});
