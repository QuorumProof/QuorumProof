# Multi-language example specification

Every language implementation in this directory performs **the same
scenario** against the QuorumProof REST API and prints **byte-identical
output**. This is what makes the examples testable: the harness in
[`scripts/check_code_examples.sh`](../../scripts/check_code_examples.sh) runs
each one against [`mock_server.py`](./mock_server.py) and diffs stdout against
[`expected_output.txt`](./expected_output.txt).

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `QP_API_URL` | `http://localhost:3000` | Base URL of the API server (no trailing slash). |
| `QP_API_KEY` | _(unset)_ | Sent as the `x-api-key` header when set. |

## Scenario

1. **Fetch a credential** — `GET {QP_API_URL}/api/v2/credentials/42`.
   Print:
   ```
   credential 42: type=<credential_type> revoked=<true|false> issuer=<issuer>
   ```
2. **Batch-verify claims** — `POST {QP_API_URL}/api/verify/batch` with body
   ```json
   { "items": [
       { "credential_id": 42, "claim_type": "HasDegree" },
       { "credential_id": 42, "claim_type": "HasDegree" },
       { "credential_id": 99, "claim_type": "HasLicense" } ] }
   ```
   Print the summary, then one indented line per result, in input order:
   ```
   batch: total=<n> verified=<n> not_found=<n> duplicates=<n>
     <credential_id> <claim_type> -> <status>
   ```
3. **Handle a missing credential** — `GET {QP_API_URL}/api/v2/credentials/99`.
   The server answers `404` with an RFC 9457 Problem Details body. Print:
   ```
   credential 99: not found (<title>)
   ```
   Any other non-2xx status is a hard error: print to stderr and exit non-zero.

## Rules for implementations

- **Standard library first.** Python and Go use only the standard library;
  JavaScript uses the built-in `fetch` (Node 18+). Rust uses `ureq` +
  `serde_json`, the smallest mainstream option.
- **No SDK wrappers.** Examples show the raw HTTP contract so readers can
  port them to any other language.
- **One file per language**, under ~120 lines, commented at the same points
  (the numbered steps above) so readers can compare languages side by side.
- **Exit code** `0` on success, non-zero on any unexpected response.
