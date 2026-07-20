/**
 * Full-pipeline integration test — Issue #880 hardening.
 *
 * Spins up a real local EVM node (Hardhat Network), deploys a genuine
 * Solidity contract compiled on the fly via solc, emits a real
 * `CredentialIssued` event, and proves the entire bridge pipeline against
 * real chain data end to end:
 *
 *   real tx receipt -> real receipts trie -> real MPT inclusion proof
 *   -> checkpointed (self-consistency + finality checked) real block header
 *   -> verifyAnchorReceiptProof() -> ABI-decoded, cryptographically proven event
 *
 * No mocking of chain data anywhere in this file — every byte the
 * verification path checks comes from the locally running node.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ChildProcess, spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { ethers } from 'ethers';
import solc from 'solc';
import { BridgeStore, ProofType, type ForeignChainEvent } from '../src/services/bridgeStore.js';
import { BlockHeaderStore } from '../src/services/blockHeaderStore.js';
import { prepareAnchor, confirmAnchor, verifyAnchorReceiptProof, checkpointHeader, AnchorVerificationError } from '../src/services/crossChainBridge.js';
import { buildReceiptTrie, createReceiptProof, receiptsRootHex, type ReceiptClaim } from '../src/services/mptProof.js';

const HARDHAT_PORT = 18645;
const RPC_URL = `http://127.0.0.1:${HARDHAT_PORT}`;
const CHAIN_ID = 1; // Ethereum Mainnet mapping in evmChainConfig.ts — real, block-number/timestamp-accurate hardfork schedule
// Forking real mainnet (rather than starting from an empty local chain at
// block 0) keeps block numbers and timestamps mutually consistent with
// Mainnet's actual historical hardfork activation schedule, which
// `headerSchemaForChain(1)`'s `setHardfork: true` auto-detection requires —
// an empty local chain's low block numbers alongside today's wall-clock
// timestamp would violate that real schedule and fail hash verification for
// reasons that have nothing to do with the bridge logic under test.
const FORK_RPC_URL = 'https://ethereum-rpc.publicnode.com';
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';

/** A fresh, pre-funded account per test — avoids any cross-test nonce bookkeeping. */
function hardhatWallet(index: number, p: ethers.JsonRpcProvider): ethers.HDNodeWallet {
  return ethers.HDNodeWallet.fromMnemonic(ethers.Mnemonic.fromPhrase(HARDHAT_MNEMONIC), `m/44'/60'/0'/0/${index}`).connect(p) as ethers.HDNodeWallet;
}

const CONTRACT_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
contract CredentialRegistry {
  event CredentialIssued(uint256 indexed credentialId, address indexed holder, address indexed issuer);
  event CredentialRevoked(uint256 indexed credentialId, address indexed issuer);
  function issue(uint256 credentialId, address holder) external {
    emit CredentialIssued(credentialId, holder, msg.sender);
  }
}
`;

let hardhatProcess: ChildProcess;
let provider: ethers.JsonRpcProvider;
let compiled: { abi: unknown[]; bytecode: string };

function compileContract() {
  const input = {
    language: 'Solidity',
    sources: { 'CredentialRegistry.sol': { content: CONTRACT_SOURCE } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const contract = output.contracts['CredentialRegistry.sol']['CredentialRegistry'];
  return { abi: contract.abi, bytecode: '0x' + contract.evm.bytecode.object };
}

async function waitForRpc(timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await provider.send('eth_chainId', []);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('hardhat node did not become ready in time');
}

/**
 * ethers' default nonce population (via the 'pending' tag) is unreliable
 * against Hardhat's EDR-simulated network in this environment — sequential
 * awaited sends have been observed to race and reuse a nonce. Track nonces
 * explicitly per test instead (each test uses its own fresh account, so
 * there's no cross-test contention).
 */
async function deployRegistry(wallet: ethers.HDNodeWallet) {
  let nonce = await provider.getTransactionCount(wallet.address, 'latest');
  const factory = new ethers.ContractFactory(compiled.abi, compiled.bytecode, wallet);
  const deployTx = await factory.getDeployTransaction();
  const deploySent = await wallet.sendTransaction({ ...deployTx, nonce: nonce++ });
  const deployReceipt = await deploySent.wait();
  const contractAddress = deployReceipt!.contractAddress!;
  const contract = new ethers.Contract(contractAddress, compiled.abi, wallet);
  return {
    contract,
    contractAddress,
    nextNonce: () => nonce++,
  };
}

async function sendIssue(
  wallet: ethers.HDNodeWallet,
  contract: ethers.Contract,
  nonce: number,
  credentialId: number,
  holder: string,
): Promise<ethers.TransactionResponse> {
  const populated = await contract.issue.populateTransaction(credentialId, holder);
  return wallet.sendTransaction({ ...populated, nonce });
}

/** Build the *real* receipts trie for a whole block from genuine receipts fetched from the node. */
async function fetchReceiptClaims(txHashes: readonly string[]): Promise<ReceiptClaim[]> {
  const claims: ReceiptClaim[] = [];
  for (const txHash of txHashes) {
    const r = await provider.getTransactionReceipt(txHash);
    claims.push({
      txIndex: r!.index,
      txType: (r!.type ?? 0) as ReceiptClaim['txType'],
      status: Number(r!.status) as 0 | 1,
      cumulativeGasUsed: r!.cumulativeGasUsed.toString(),
      logsBloom: r!.logsBloom,
      logs: r!.logs.map((l) => ({ address: l.address, topics: [...l.topics], data: l.data })),
    });
  }
  return claims;
}

function freshStores() {
  return {
    bridgeStore: new BridgeStore(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-int-'))),
    headerStore: new BlockHeaderStore(fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-int-hdr-'))),
  };
}

beforeAll(async () => {
  const configPath = path.join(__dirname, 'fixtures/hardhat/hardhat.config.js');
  hardhatProcess = spawn(
    path.join(__dirname, '..', 'node_modules', '.bin', 'hardhat'),
    ['node', '--config', configPath, '--port', String(HARDHAT_PORT), '--fork', FORK_RPC_URL],
    { stdio: 'ignore' },
  );
  provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true, batchMaxCount: 1 });
  await waitForRpc();
  compiled = compileContract();
}, 60000);

afterAll(() => {
  hardhatProcess?.kill();
});

describe('Cross-chain bridge — full pipeline against a local EVM node', () => {
  it('verifies a real CredentialIssued event via genuine MPT receipt proof against a checkpointed header', async () => {
    const wallet = hardhatWallet(0, provider);
    const { contract, contractAddress, nextNonce } = await deployRegistry(wallet);

    // Filler tx so our target isn't at index 0 — proves the trie key/proof logic
    // handles non-trivial indices, not just the degenerate single-tx-block case.
    await (await wallet.sendTransaction({ to: wallet.address, value: 0n, nonce: nextNonce() })).wait();

    const credentialId = 4242;
    const holder = ethers.Wallet.createRandom().address;
    const sent = await sendIssue(wallet, contract, nextNonce(), credentialId, holder);
    const receipt = await sent.wait();

    const block = await provider.getBlock(receipt!.blockNumber);
    const rawBlock = await provider.send('eth_getBlockByNumber', [ethers.toBeHex(receipt!.blockNumber), false]);

    const receiptClaims = await fetchReceiptClaims(block!.transactions);
    const trie = await buildReceiptTrie(receiptClaims);
    expect(receiptsRootHex(trie).toLowerCase()).toBe(rawBlock.receiptsRoot.toLowerCase()); // sanity: our encoding matches consensus

    // Mine well past Polygon's confirmation requirement so checkpointing succeeds.
    await provider.send('hardhat_mine', [ethers.toQuantity(200)]);
    const headBlockNumber = parseInt(await provider.send('eth_blockNumber', []), 16);

    const { bridgeStore, headerStore } = freshStores();
    const header = checkpointHeader(
      { chainId: CHAIN_ID, rpcHeader: rawBlock, finality: { mode: 'confirmations', headBlockNumber } },
      headerStore,
    );
    expect(header.blockHash).toBe(rawBlock.hash.toLowerCase());

    const foreignEvent: ForeignChainEvent = {
      chainId: CHAIN_ID,
      txHash: receipt!.hash,
      blockNumber: receipt!.blockNumber,
      blockHash: rawBlock.hash,
      contractAddress,
      blockTimestamp: block!.timestamp,
    };
    const anchor = prepareAnchor({ credentialId, foreignEvent, proofType: ProofType.HashOnly }, bridgeStore);
    confirmAnchor(anchor.txHash, 1, bridgeStore);

    const target = receiptClaims.find((r) => r.txIndex === receipt!.index)!;
    const proofNodes = await createReceiptProof(trie, target.txIndex);

    // logIndex 0: `issue()` emits exactly one log.
    const result = await verifyAnchorReceiptProof(
      { anchorId: 1, logIndexInReceipt: 0, receiptProof: { claim: target, proofNodes } },
      bridgeStore,
      headerStore,
    );

    expect(result.decoded.type).toBe('CredentialIssued');
    expect(result.decoded.credentialId).toBe(String(credentialId));
    expect(result.decoded.holder?.toLowerCase()).toBe(holder.toLowerCase());
    expect(result.decoded.issuer?.toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(bridgeStore.getById(1)?.verified).toBe(true);
  }, 30000);

  it('rejects a proof for a credentialId that does not match the real on-chain event', async () => {
    const wallet = hardhatWallet(1, provider);
    const { contract, contractAddress, nextNonce } = await deployRegistry(wallet);

    const holder = ethers.Wallet.createRandom().address;
    const sent = await sendIssue(wallet, contract, nextNonce(), 777, holder);
    const receipt = await sent.wait();

    const block = await provider.getBlock(receipt!.blockNumber);
    const rawBlock = await provider.send('eth_getBlockByNumber', [ethers.toBeHex(receipt!.blockNumber), false]);
    const receiptClaims = await fetchReceiptClaims(block!.transactions);
    const trie = await buildReceiptTrie(receiptClaims);

    await provider.send('hardhat_mine', [ethers.toQuantity(200)]);
    const headBlockNumber = parseInt(await provider.send('eth_blockNumber', []), 16);

    const { bridgeStore, headerStore } = freshStores();
    checkpointHeader({ chainId: CHAIN_ID, rpcHeader: rawBlock, finality: { mode: 'confirmations', headBlockNumber } }, headerStore);

    const foreignEvent: ForeignChainEvent = {
      chainId: CHAIN_ID,
      txHash: receipt!.hash,
      blockNumber: receipt!.blockNumber,
      blockHash: rawBlock.hash,
      contractAddress,
      blockTimestamp: block!.timestamp,
    };
    // Anchor *claims* credentialId 999 — but the real on-chain event was for 777.
    const anchor = prepareAnchor({ credentialId: 999, foreignEvent }, bridgeStore);
    confirmAnchor(anchor.txHash, 2, bridgeStore);

    const target = receiptClaims.find((r) => r.txIndex === receipt!.index)!;
    const proofNodes = await createReceiptProof(trie, target.txIndex);

    await expect(
      verifyAnchorReceiptProof({ anchorId: 2, logIndexInReceipt: 0, receiptProof: { claim: target, proofNodes } }, bridgeStore, headerStore),
    ).rejects.toThrow(AnchorVerificationError);
    expect(bridgeStore.getById(2)?.verified).toBe(false);
  }, 30000);

  it('rejects a receipt proof forged for a different transaction in the same block', async () => {
    const wallet = hardhatWallet(2, provider);
    const { contract, contractAddress, nextNonce } = await deployRegistry(wallet);

    // Two issue() calls mined in the *same* block via hardhat's manual mining.
    await provider.send('evm_setAutomine', [false]);
    const holderA = ethers.Wallet.createRandom().address;
    const holderB = ethers.Wallet.createRandom().address;
    const sentA = await sendIssue(wallet, contract, nextNonce(), 111, holderA);
    const sentB = await sendIssue(wallet, contract, nextNonce(), 222, holderB);
    await provider.send('evm_mine', []);
    await provider.send('evm_setAutomine', [true]);
    const receiptA = await sentA.wait();
    const receiptB = await sentB.wait();
    expect(receiptA!.blockNumber).toBe(receiptB!.blockNumber);
    expect(receiptA!.index).not.toBe(receiptB!.index);

    const block = await provider.getBlock(receiptA!.blockNumber);
    const rawBlock = await provider.send('eth_getBlockByNumber', [ethers.toBeHex(receiptA!.blockNumber), false]);
    const receiptClaims = await fetchReceiptClaims(block!.transactions);
    const trie = await buildReceiptTrie(receiptClaims);

    await provider.send('hardhat_mine', [ethers.toQuantity(200)]);
    const headBlockNumber = parseInt(await provider.send('eth_blockNumber', []), 16);
    const { bridgeStore, headerStore } = freshStores();
    checkpointHeader({ chainId: CHAIN_ID, rpcHeader: rawBlock, finality: { mode: 'confirmations', headBlockNumber } }, headerStore);

    const foreignEvent: ForeignChainEvent = {
      chainId: CHAIN_ID,
      txHash: receiptA!.hash,
      blockNumber: receiptA!.blockNumber,
      blockHash: rawBlock.hash,
      contractAddress,
      blockTimestamp: block!.timestamp,
    };
    const anchor = prepareAnchor({ credentialId: 111, foreignEvent }, bridgeStore);
    confirmAnchor(anchor.txHash, 3, bridgeStore);

    // Attacker builds a real, validly-generated proof — but for tx B's receipt, not tx A's.
    const claimB = receiptClaims.find((r) => r.txIndex === receiptB!.index)!;
    const proofNodesB = await createReceiptProof(trie, claimB.txIndex);

    await expect(
      verifyAnchorReceiptProof({ anchorId: 3, logIndexInReceipt: 0, receiptProof: { claim: claimB, proofNodes: proofNodesB } }, bridgeStore, headerStore),
    ).rejects.toThrow(AnchorVerificationError); // credentialId 222 (tx B) != registered 111 (tx A)
    expect(bridgeStore.getById(3)?.verified).toBe(false);
  }, 30000);
});
