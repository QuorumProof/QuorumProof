# Multi-language code examples

The same QuorumProof REST scenario — fetch a credential, batch-verify claims,
handle a missing credential — implemented in four languages. Every
implementation prints identical output, so they are tested against a single
expected-output file.

| Language | Path | Requirements | Run |
|---|---|---|---|
| Python | [`python/quickstart.py`](./python/quickstart.py) | Python 3.8+ | `python3 quickstart.py` |
| JavaScript | [`javascript/quickstart.mjs`](./javascript/quickstart.mjs) | Node.js 18+ | `node quickstart.mjs` |
| Rust | [`rust/src/main.rs`](./rust/src/main.rs) | Rust 1.70+ | `cargo run --quiet` |
| Go | [`go/main.go`](./go/main.go) | Go 1.21+ | `go run .` |

All examples read `QP_API_URL` (default `http://localhost:3000`) and, if set,
send `QP_API_KEY` as the `x-api-key` header.

## Files

| File | Purpose |
|---|---|
| [`SPEC.md`](./SPEC.md) | The scenario every implementation must follow, including exact output. |
| [`expected_output.txt`](./expected_output.txt) | Golden stdout shared by all implementations. |
| [`mock_server.py`](./mock_server.py) | Stdlib HTTP stub serving deterministic responses for tests. |
| [`templates/`](./templates/) | Templates for adding a new scenario or a new language. |

## Testing

```bash
./scripts/check_code_examples.sh            # all languages with a toolchain installed
./scripts/check_code_examples.sh python go  # a subset
```

The script starts the mock server, runs each example against it, and diffs
stdout against `expected_output.txt`. Languages whose toolchain is missing
are skipped locally; in CI (`CODE_EXAMPLES_STRICT=1`) a missing toolchain is
a failure. The `code-examples` workflow runs it on every PR touching
`examples/multi-language/`.

Maintenance rules are documented in
[`docs/code-examples.md`](../../docs/code-examples.md).
