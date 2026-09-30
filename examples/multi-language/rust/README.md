# Rust quickstart

Requires Rust 1.70+. Dependencies: `ureq` (blocking HTTP) and `serde_json`.
This crate declares its own `[workspace]` so it builds independently of the
repository's contract workspace.

```bash
QP_API_URL=http://localhost:3000 cargo run --quiet
```

See [../SPEC.md](../SPEC.md) for what the example does and prints.
