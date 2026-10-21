// Unit tests for src/inspect.js (#1674). Run with: npm test (inside tools/devtools-extension)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRpcRequest,
  parseRpcResponse,
  summarizeResult,
  classify,
  buildRow,
} from '../src/inspect.js';

const rpcBody = (method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

test('parseRpcRequest accepts recorded Soroban methods', () => {
  const parsed = parseRpcRequest(rpcBody('simulateTransaction', { transaction: 'AAAA' }));
  assert.equal(parsed.method, 'simulateTransaction');
  assert.deepEqual(parsed.params, { transaction: 'AAAA' });
});

test('parseRpcRequest ignores other methods, bad JSON and empty bodies', () => {
  assert.equal(parseRpcRequest(rpcBody('eth_blockNumber')), null);
  assert.equal(parseRpcRequest('not json'), null);
  assert.equal(parseRpcRequest(''), null);
  assert.equal(parseRpcRequest(undefined), null);
});

test('parseRpcResponse returns result or error and tolerates bad JSON', () => {
  assert.deepEqual(parseRpcResponse('{"result":{"status":"PENDING"}}').result, { status: 'PENDING' });
  assert.equal(parseRpcResponse('{"error":{"message":"boom"}}').error.message, 'boom');
  assert.equal(parseRpcResponse('<html>').error.message, 'Response is not valid JSON');
});

test('summarizeResult reads documented fields per method', () => {
  assert.deepEqual(summarizeResult('sendTransaction', { hash: 'h', status: 'PENDING' }), {
    hash: 'h',
    status: 'PENDING',
    errorResultXdr: undefined,
  });
  const sim = summarizeResult('simulateTransaction', {
    latestLedger: 9,
    minResourceFee: '100',
    results: [{}, {}],
    events: [],
  });
  assert.equal(sim.resultCount, 2);
  assert.equal(sim.eventCount, 0);
  assert.equal(sim.restorePreamble, false);
});

test('summarizeResult handles missing or non-object results', () => {
  assert.deepEqual(summarizeResult('getTransaction', undefined), {});
  assert.deepEqual(summarizeResult('getTransaction', 'oops'), {});
  assert.equal(summarizeResult('simulateTransaction', { results: 'nope' }).resultCount, 0);
});

test('classify maps transaction statuses to display states', () => {
  assert.equal(classify('sendTransaction', { status: 'ERROR' }), 'failed');
  assert.equal(classify('sendTransaction', { status: 'TRY_AGAIN_LATER' }), 'pending');
  assert.equal(classify('sendTransaction', { status: 'PENDING' }), 'pending');
  assert.equal(classify('getTransaction', { status: 'SUCCESS' }), 'ok');
  assert.equal(classify('getTransaction', { status: 'FAILED' }), 'failed');
  assert.equal(classify('getTransaction', { status: 'NOT_FOUND' }), 'pending');
  assert.equal(classify('simulateTransaction', { error: 'host trap' }), 'failed');
  assert.equal(classify('simulateTransaction', {}), 'ok');
  assert.equal(classify('getEvents', {}, { message: 'x' }), 'error');
});

test('buildRow produces a contract row for a simulated invocation', () => {
  const entry = {
    request: { postData: { text: rpcBody('simulateTransaction', { transaction: 'AAAA' }) } },
    time: 42.6,
    startedDateTime: '2026-10-16T00:00:00Z',
  };
  const row = buildRow(entry, JSON.stringify({ result: { latestLedger: 5, results: [{}], events: [] } }));
  assert.equal(row.kind, 'contract');
  assert.equal(row.status, 'ok');
  assert.equal(row.durationMs, 43);
  assert.equal(row.summary.resultCount, 1);
});

test('buildRow marks read-only methods as reads and surfaces RPC errors', () => {
  const entry = { request: { postData: { text: rpcBody('getLatestLedger') } }, time: 3 };
  const row = buildRow(entry, JSON.stringify({ error: { code: -32600, message: 'bad' } }));
  assert.equal(row.kind, 'read');
  assert.equal(row.status, 'error');
  assert.equal(row.error.message, 'bad');
});

test('buildRow returns null for non-Soroban traffic', () => {
  const entry = { request: { postData: { text: rpcBody('eth_call') } } };
  assert.equal(buildRow(entry, '{}'), null);
});
