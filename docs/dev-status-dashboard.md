# Development Status Dashboard

`scripts/dev_status.py` generates a single-page status report for the repository: test
coverage, contract size, recent activity and (optionally) CI results. It is a static HTML
file, so it can be opened locally or uploaded as a CI artifact. It has no server and no
dependencies beyond Python 3.

## Generating the report

```bash
# 1. Produce the coverage data (optional but recommended)
(cd frontend && npm run test:coverage)
(cd dashboard && npx vitest --run --coverage)

# 2. Build the contracts so their sizes are measured (optional)
cargo build --release --target wasm32-unknown-unknown -p quorum_proof -p sbt_registry -p zk_verifier

# 3. Generate the dashboard
python3 scripts/dev_status.py              # writes reports/dev-status/
python3 scripts/dev_status.py --ci         # also lists recent GitHub Actions runs
python3 scripts/dev_status.py --output-dir /tmp/status
```

Open `reports/dev-status/index.html` in a browser. The raw data is written alongside it as
`dev-status.json`. The output directory is git-ignored.

The `--ci` flag requires the GitHub CLI (`gh`) to be installed and authenticated
(`gh auth login`). Without `gh`, the CI section says the data was not collected instead of
failing.

## Metrics

### Test coverage

Line coverage is read from the `lcov.info` file written by each Vitest run:

| Suite | Source |
|-------|--------|
| `frontend` | `frontend/coverage/lcov.info` (`npm run test:coverage`) |
| `dashboard` | `dashboard/coverage/lcov.info` (`vitest --run --coverage`) |

Coverage is `lines hit / lines found`, summed across every file in the lcov report. A suite
is marked **below threshold** when it is under **70%**, which matches the line threshold CI
enforces for the frontend. A suite with no lcov file shows **no data**. This is not a
failure: the report only describes what was measured.

### Contract performance (wasm size)

Soroban contracts are limited by the size of their compiled WebAssembly, so the report lists
the size of each contract's `.wasm` file from `target/wasm32-unknown-unknown/release/`. A
contract that has not been built shows **not built**.

Compare sizes between runs to catch regressions. A large jump usually means a new dependency
or an accidental debug build.

### Repository activity

- **Branch**: the currently checked-out branch.
- **Last commit**: short hash, subject and relative age.
- **Commits (7 days)**: number of commits on `HEAD` in the last seven days.

### CI runs (`--ci`)

The five most recent workflow runs from `gh run list`, showing workflow, branch, status and
conclusion.

## Reading the output

| Field | Meaning |
|-------|---------|
| Generated | UTC time the report was produced. Values are a snapshot, not live. |
| `ok` / `below threshold` / `no data` | Coverage status, as described above. |
| `not built` | The contract `.wasm` was not found. Build it first. |

## Extending the dashboard

1. Add a `collect_*` function to `scripts/dev_status.py` that returns a dataclass. Keep the
   parsing separate from the subprocess or filesystem access so it can be unit-tested.
2. Add the field to `DevStatus` and set it in `collect()`.
3. Render it in `render_html()`. Escape every value with `_e()`. Repository data such as
   branch names is user-controlled and must not be emitted raw.
4. Add tests to `scripts/tests/test_dev_status.py` and run them:

   ```bash
   python3 scripts/tests/test_dev_status.py
   ```

## Known limitations

- Rust (`cargo llvm-cov`) coverage is not collected yet. Only the JavaScript suites are.
- Performance metrics cover contract size only. Latency or throughput numbers would come from
  the existing benchmark workflow (`.github/workflows/benchmarks.yml`), which does not yet
  export machine-readable results.
- The report is generated on demand. It is not scheduled, and it does not publish to GitHub
  Pages.
