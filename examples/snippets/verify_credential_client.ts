/**
 * Example: Credential Verification & Contract Invocation Client
 * Constructed using QuorumProof snippets: `qp-verify-credential`, `qp-invoke-contract`, `qp-ws-subscribe`.
 */

import { Contract, Operation, TransactionBuilder, BASE_FEE, Keypair } from "@stellar/stellar-sdk";

export interface VerifiableCredential {
  id: string;
  issuer: string;
  holder: string;
  expirationTimestamp: number;
  claims: Record<string, unknown>;
  signature: string;
}

/**
 * Validates a credential off-chain using the `qp-verify-credential` pattern.
 */
export async function verifyCredential(
  credential: VerifiableCredential,
): Promise<{ isValid: boolean; reason?: string }> {
  const now = Math.floor(Date.now() / 1000);

  if (credential.expirationTimestamp && now > credential.expirationTimestamp) {
    return { isValid: false, reason: "Credential has expired" };
  }

  if (!credential.signature || credential.signature.trim() === "") {
    return { isValid: false, reason: "Missing cryptographic signature" };
  }

  return { isValid: true };
}

/**
 * Invokes on-chain Soroban contract using the `qp-invoke-contract` pattern.
 */
export async function invokeContract(
  client: any,
  sourceKeypair: Keypair,
  contractId: string,
  method: string,
  args: any[],
) {
  const contract = new Contract(contractId);
  const account = await client.horizon.loadAccount(sourceKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: client.networkPassphrase,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(180)
    .build();

  tx.sign(sourceKeypair);
  return await client.horizon.submitTransaction(tx);
}

/**
 * Subscribes to live QuorumProof events using the `qp-ws-subscribe` pattern.
 */
export function subscribeToEvents(url: string, onEvent: (data: any) => void) {
  const ws = new WebSocket(url);

  ws.onopen = () => {
    console.log("Connected to QuorumProof event feed");
    ws.send(JSON.stringify({ action: "subscribe", topic: "credentials" }));
  };

  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      onEvent(payload);
    } catch (err) {
      console.error("Failed to parse event data", err);
    }
  };

  ws.onerror = (error) => console.error("WebSocket error:", error);
  ws.onclose = () => {
    console.log("Reconnecting in 3s...");
    setTimeout(() => subscribeToEvents(url, onEvent), 3000);
  };

  return () => ws.close();
}
