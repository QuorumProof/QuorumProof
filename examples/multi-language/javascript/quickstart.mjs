#!/usr/bin/env node
// QuorumProof REST quickstart — JavaScript (Node 18+, built-in fetch).
//
// Implements the scenario in ../SPEC.md. Run:
//   QP_API_URL=http://localhost:3000 node quickstart.mjs

const BASE_URL = (process.env.QP_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const API_KEY = process.env.QP_API_KEY;

/** Send a JSON request; return { status, body }. */
async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (API_KEY) headers['x-api-key'] = API_KEY;
  const res = await fetch(BASE_URL + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  // Non-2xx responses still carry a Problem Details body.
  return { status: res.status, body: await res.json() };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function main() {
  // 1. Fetch a credential.
  const cred = await request('GET', '/api/v2/credentials/42');
  if (cred.status !== 200) fail(`GET credential 42 failed: HTTP ${cred.status}`);
  const c = cred.body;
  console.log(`credential 42: type=${c.credential_type} revoked=${c.revoked} issuer=${c.issuer}`);

  // 2. Batch-verify claims.
  const items = [
    { credential_id: 42, claim_type: 'HasDegree' },
    { credential_id: 42, claim_type: 'HasDegree' },
    { credential_id: 99, claim_type: 'HasLicense' },
  ];
  const batch = await request('POST', '/api/verify/batch', { items });
  if (batch.status !== 200) fail(`POST verify/batch failed: HTTP ${batch.status}`);
  const s = batch.body.summary;
  console.log(
    `batch: total=${s.total} verified=${s.verified} not_found=${s.not_found} duplicates=${s.duplicates_deduplicated}`,
  );
  for (const r of batch.body.results) {
    console.log(`  ${r.credential_id} ${r.claim_type} -> ${r.status}`);
  }

  // 3. Handle a missing credential.
  const missing = await request('GET', '/api/v2/credentials/99');
  if (missing.status !== 404) fail(`GET credential 99: expected 404, got HTTP ${missing.status}`);
  console.log(`credential 99: not found (${missing.body.title})`);
}

main().catch((err) => fail(err.stack ?? String(err)));
