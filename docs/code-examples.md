# Code Examples in Multiple Languages

QuorumProof's REST API can be called from any language. This page shows the
core flows in **Python, JavaScript, Rust and Go** and explains how those
examples are tested and maintained (issue #1638).

The complete, runnable programs live in
[`examples/multi-language/`](../examples/multi-language/). The snippets
below are excerpts from those programs: if a snippet here and the program
disagree, the program is authoritative (it is what CI runs).

Contents:

- [Setup](#setup)
- [Fetch a credential](#fetch-a-credential)
- [Batch-verify claims](#batch-verify-claims)
- [Handle a missing credential](#handle-a-missing-credential)
- [Running the examples](#running-the-examples)
- [How the examples are tested](#how-the-examples-are-tested)
- [Maintaining the examples](#maintaining-the-examples)

---

## Setup

Every example reads two environment variables:

| Env var | Default | Meaning |
|---|---|---|
| `QP_API_URL` | `http://localhost:3000` | Base URL of the API server. |
| `QP_API_KEY` | _(unset)_ | Sent as the `x-api-key` header when set. |

The examples use the **v2** credential routes (`/api/v2/...`), which return
raw resource objects and RFC 9457 Problem Details errors. See
[api-response-examples.md](./api-response-examples.md) for every response
shape and [migration-guides.md](./migration-guides.md#api-v1--v2) if you are
still on v1.

---

## Fetch a credential

`GET /api/v2/credentials/:id` returns a [`Credential`](./api-response-examples.md#credential).

<details open><summary><b>Python</b></summary>

```python
status, cred = request("GET", "/api/v2/credentials/42")
if status != 200:
    sys.exit(f"GET credential 42 failed: HTTP {status}")
print(f"credential 42: type={cred['credential_type']} "
      f"revoked={str(cred['revoked']).lower()} issuer={cred['issuer']}")
```

</details>
<details><summary><b>JavaScript</b></summary>

```javascript
const cred = await request('GET', '/api/v2/credentials/42');
if (cred.status !== 200) fail(`GET credential 42 failed: HTTP ${cred.status}`);
const c = cred.body;
console.log(`credential 42: type=${c.credential_type} revoked=${c.revoked} issuer=${c.issuer}`);
```

</details>
<details><summary><b>Rust</b></summary>

```rust
let cred = match client.request("GET", "/api/v2/credentials/42", None) {
    Ok((200, body)) => body,
    other => fail(format!("GET credential 42 failed: {other:?}")),
};
println!(
    "credential 42: type={} revoked={} issuer={}",
    cred["credential_type"],
    cred["revoked"],
    cred["issuer"].as_str().unwrap_or_default()
);
```

</details>
<details><summary><b>Go</b></summary>

```go
var cred credential
if status, err := request("GET", "/api/v2/credentials/42", nil, &cred); err != nil || status != 200 {
	fail("GET credential 42 failed: HTTP %d %v", status, err)
}
fmt.Printf("credential 42: type=%d revoked=%t issuer=%s\n", cred.CredentialType, cred.Revoked, cred.Issuer)
```

</details>

---

## Batch-verify claims

`POST /api/verify/batch` verifies many `(credential_id, claim_type)` pairs in
one call. Duplicate pairs are resolved once and reported in
`summary.duplicates_deduplicated`. Results come back in input order.

<details open><summary><b>Python</b></summary>

```python
items = [
    {"credential_id": 42, "claim_type": "HasDegree"},
    {"credential_id": 42, "claim_type": "HasDegree"},
    {"credential_id": 99, "claim_type": "HasLicense"},
]
status, batch = request("POST", "/api/verify/batch", {"items": items})
s = batch["summary"]
print(f"batch: total={s['total']} verified={s['verified']} "
      f"not_found={s['not_found']} duplicates={s['duplicates_deduplicated']}")
for r in batch["results"]:
    print(f"  {r['credential_id']} {r['claim_type']} -> {r['status']}")
```

</details>
<details><summary><b>JavaScript</b></summary>

```javascript
const items = [
  { credential_id: 42, claim_type: 'HasDegree' },
  { credential_id: 42, claim_type: 'HasDegree' },
  { credential_id: 99, claim_type: 'HasLicense' },
];
const batch = await request('POST', '/api/verify/batch', { items });
const s = batch.body.summary;
console.log(
  `batch: total=${s.total} verified=${s.verified} not_found=${s.not_found} duplicates=${s.duplicates_deduplicated}`,
);
for (const r of batch.body.results) {
  console.log(`  ${r.credential_id} ${r.claim_type} -> ${r.status}`);
}
```

</details>
<details><summary><b>Rust</b></summary>

```rust
let items = json!({ "items": [
    { "credential_id": 42, "claim_type": "HasDegree" },
    { "credential_id": 42, "claim_type": "HasDegree" },
    { "credential_id": 99, "claim_type": "HasLicense" },
]});
let batch = match client.request("POST", "/api/verify/batch", Some(items)) {
    Ok((200, body)) => body,
    other => fail(format!("POST verify/batch failed: {other:?}")),
};
let s = &batch["summary"];
println!(
    "batch: total={} verified={} not_found={} duplicates={}",
    s["total"], s["verified"], s["not_found"], s["duplicates_deduplicated"]
);
```

</details>
<details><summary><b>Go</b></summary>

```go
items := map[string]any{"items": []map[string]any{
	{"credential_id": 42, "claim_type": "HasDegree"},
	{"credential_id": 42, "claim_type": "HasDegree"},
	{"credential_id": 99, "claim_type": "HasLicense"},
}}
var batch batchResponse
if status, err := request("POST", "/api/verify/batch", items, &batch); err != nil || status != 200 {
	fail("POST verify/batch failed: HTTP %d %v", status, err)
}
s := batch.Summary
fmt.Printf("batch: total=%d verified=%d not_found=%d duplicates=%d\n", s.Total, s.Verified, s.NotFound, s.Duplicates)
```

</details>

---

## Handle a missing credential

A missing credential returns `404` with a Problem Details body. Every example
treats `404` as an expected outcome and reads `title`; any other non-2xx
status is a hard error.

<details open><summary><b>Python</b></summary>

```python
status, problem = request("GET", "/api/v2/credentials/99")
if status != 404:
    sys.exit(f"GET credential 99: expected 404, got HTTP {status}")
print(f"credential 99: not found ({problem['title']})")
```

</details>
<details><summary><b>JavaScript</b></summary>

```javascript
const missing = await request('GET', '/api/v2/credentials/99');
if (missing.status !== 404) fail(`GET credential 99: expected 404, got HTTP ${missing.status}`);
console.log(`credential 99: not found (${missing.body.title})`);
```

</details>
<details><summary><b>Rust</b></summary>

```rust
let problem = match client.request("GET", "/api/v2/credentials/99", None) {
    Ok((404, body)) => body,
    other => fail(format!("GET credential 99: expected 404, got {other:?}")),
};
println!("credential 99: not found ({})", problem["title"].as_str().unwrap_or_default());
```

</details>
<details><summary><b>Go</b></summary>

```go
var p problem
if status, err := request("GET", "/api/v2/credentials/99", nil, &p); err != nil || status != 404 {
	fail("GET credential 99: expected 404, got HTTP %d %v", status, err)
}
fmt.Printf("credential 99: not found (%s)\n", p.Title)
```

</details>

**Output (identical for all four languages)**

```
credential 42: type=1 revoked=false issuer=GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZRXDMTGEYJ66SDOQ62RK
batch: total=3 verified=2 not_found=1 duplicates=1
  42 HasDegree -> verified
  42 HasDegree -> verified
  99 HasLicense -> not_found
credential 99: not found (Credential not found)
```

For calling the Soroban contracts directly (rather than the REST API), see
[api-endpoint-examples.md](./api-endpoint-examples.md) and
[sdk-methods-reference.md](./sdk-methods-reference.md).

---

## Running the examples

| Language | Directory | Command |
|---|---|---|
| Python 3.8+ | `examples/multi-language/python` | `python3 quickstart.py` |
| Node.js 18+ | `examples/multi-language/javascript` | `node quickstart.mjs` |
| Rust 1.70+ | `examples/multi-language/rust` | `cargo run --quiet` |
| Go 1.21+ | `examples/multi-language/go` | `go run .` |

Point `QP_API_URL` at a running API server, or at the mock server described
below.

---

## How the examples are tested

The examples are tested as **golden-output programs**:

1. [`examples/multi-language/SPEC.md`](../examples/multi-language/SPEC.md)
   defines the scenario and the exact lines each step prints.
2. [`mock_server.py`](../examples/multi-language/mock_server.py) is a
   standard-library HTTP stub serving deterministic responses with the shapes
   documented in [api-response-examples.md](./api-response-examples.md).
3. [`scripts/check_code_examples.sh`](../scripts/check_code_examples.sh)
   starts the mock, runs every implementation against it and diffs stdout
   with [`expected_output.txt`](../examples/multi-language/expected_output.txt).

```bash
./scripts/check_code_examples.sh            # every language with a toolchain installed
./scripts/check_code_examples.sh python go  # a subset
CODE_EXAMPLES_STRICT=1 ./scripts/check_code_examples.sh   # missing toolchain = failure
```

The [`code-examples`](../.github/workflows/code-examples.yml) workflow
installs all four toolchains and runs the script in strict mode on every PR
that touches `examples/multi-language/`.

Because all implementations share one expected-output file, a change that
updates one language but not the others fails CI.

---

## Maintaining the examples

**When the API changes.** Any PR that changes a response shape used by the
examples (`Credential`, `BatchVerificationResponse`, Problem Details) must, in
the same PR:

1. Update `mock_server.py` to the new shape.
2. Update all four implementations.
3. Update the snippets on this page.
4. Update `expected_output.txt` if the printed output changes.

**Adding a scenario.** Start from
[`templates/EXAMPLE_TEMPLATE.md`](../examples/multi-language/templates/EXAMPLE_TEMPLATE.md)
and the per-language `*.tmpl` files next to it. Describe the scenario in
`SPEC.md` first, then implement it in all four languages. A scenario is not
merged in fewer than four languages.

**Adding a language.** Add `examples/multi-language/<lang>/` with a
`README.md`, implement the full `SPEC.md` scenario, add a `case` arm in
`scripts/check_code_examples.sh`, and install the toolchain in the workflow.

**Style rules.**

- Standard library first; justify any dependency in the language's `README.md`.
- No SDK wrappers: the examples document the raw HTTP contract.
- Keep the numbered step comments (`// 1.`, `// 2.`, …) aligned across
  languages so they can be read side by side.
- Never hard-code secrets; read credentials from `QP_API_KEY`.

**Ownership.** Example changes are reviewed like code. Reviewers check that
the four implementations still produce identical output and that this page's
snippets match the programs.

---

See also: [FAQ](./faq.md) · [Glossary](./glossary.md) ·
[API client guide](./api-client-guide.md)
