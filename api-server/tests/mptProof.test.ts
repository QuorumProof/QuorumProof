import { describe, it, expect } from 'vitest';
import {
  buildReceiptTrie,
  createReceiptProof,
  receiptsRootHex,
  verifyReceiptProof,
  ReceiptProofError,
  type ReceiptClaim,
} from '../src/services/mptProof.js';

function sampleReceipts(): ReceiptClaim[] {
  return [
    {
      txIndex: 0,
      txType: 2,
      status: 1,
      cumulativeGasUsed: '21000',
      logsBloom: '0x' + '00'.repeat(256),
      logs: [],
    },
    {
      txIndex: 1,
      txType: 2,
      status: 1,
      cumulativeGasUsed: '95000',
      logsBloom: '0x' + '00'.repeat(256),
      logs: [
        {
          address: '0x000000000000000000000000000000000000aa',
          topics: [
            '0xd3bd681d2fe91fda330d69feca5dc6a668f4862360861444de295f833e35105',
            '0x000000000000000000000000000000000000000000000000000000000000',
          ].map((t) => t.padEnd(66, '0').slice(0, 66)),
          data: '0x1234',
        },
      ],
    },
    {
      txIndex: 2,
      txType: 0,
      status: 0,
      cumulativeGasUsed: '116000',
      logsBloom: '0x' + '00'.repeat(256),
      logs: [],
    },
  ];
}

describe('mptProof', () => {
  it('round-trips: builds a trie, proves inclusion, and verifies it', async () => {
    const receipts = sampleReceipts();
    const trie = await buildReceiptTrie(receipts);
    const root = receiptsRootHex(trie);

    for (const claim of receipts) {
      const proofNodes = await createReceiptProof(trie, claim.txIndex);
      await expect(verifyReceiptProof(root, { claim, proofNodes })).resolves.toBeUndefined();
    }
  });

  it('rejects a proof when the claimed receipt fields are tampered', async () => {
    const receipts = sampleReceipts();
    const trie = await buildReceiptTrie(receipts);
    const root = receiptsRootHex(trie);

    const target = receipts[1];
    const proofNodes = await createReceiptProof(trie, target.txIndex);

    const tampered: ReceiptClaim = { ...target, status: 0 };
    await expect(verifyReceiptProof(root, { claim: tampered, proofNodes })).rejects.toThrow(ReceiptProofError);
  });

  it('rejects a proof against the wrong receiptsRoot', async () => {
    const receipts = sampleReceipts();
    const trie = await buildReceiptTrie(receipts);
    const target = receipts[0];
    const proofNodes = await createReceiptProof(trie, target.txIndex);

    const wrongRoot = '0x' + 'ab'.repeat(32);
    await expect(verifyReceiptProof(wrongRoot, { claim: target, proofNodes })).rejects.toThrow(ReceiptProofError);
  });

  it('rejects a proof with a corrupted trie node', async () => {
    const receipts = sampleReceipts();
    const trie = await buildReceiptTrie(receipts);
    const root = receiptsRootHex(trie);
    const target = receipts[1];
    const proofNodes = await createReceiptProof(trie, target.txIndex);

    const corrupted = proofNodes.slice();
    const last = corrupted[corrupted.length - 1];
    corrupted[corrupted.length - 1] = last.slice(0, -2) + (last.endsWith('0') ? 'f' : '0');

    await expect(verifyReceiptProof(root, { claim: target, proofNodes: corrupted })).rejects.toThrow(ReceiptProofError);
  });

  it('rejects a claimed txIndex with no receipt at that position', async () => {
    const receipts = sampleReceipts();
    const trie = await buildReceiptTrie(receipts);
    const root = receiptsRootHex(trie);
    const proofNodes = await createReceiptProof(trie, 0);

    const missing: ReceiptClaim = { ...receipts[0], txIndex: 99 };
    await expect(verifyReceiptProof(root, { claim: missing, proofNodes })).rejects.toThrow(ReceiptProofError);
  });
});
