# Longevity Testing

> Issue #1632

Unit and integration tests run for seconds, but memory leaks, socket leaks and
slow event-loop degradation only appear after hours. The longevity harness runs
the API server under steady, mixed load for a long time, samples its resources
throughout, and flags any resource that keeps growing.

## Quick start

```bash
cd api-server
npm ci

npm run longevity:smoke                      # 3 minutes, sanity check
npm run longevity                            # 30 minutes (default)
LONGEVITY_DURATION=4h npm run longevity      # soak test
```

Reports are written to `api-server/longevity-reports/<timestamp>/` (ignored by git).

## How it works

```
 load generator (N virtual clients, keep-alive)
        │  mixed traffic: slice lookups, paging, credential search,
        │  slice verification, deliberate 4xx paths
        ▼
 API server (in-process Express app + mocked Soroban client)
        ▲
        │  every LONGEVITY_SAMPLE_INTERVAL
 ResourceMonitor ── heap / RSS / external / ArrayBuffers
                 ── event-loop delay (p50 / p99 / max)
                 ── active handles & requests
                 ── open file descriptors (/proc)
                 ── throughput, error count, request p99
        │
        ▼
 detectors.ts ── leak + exhaustion analysis ──► report.md / report.json / samples.csv
```

| File | Role |
|---|---|
| `api-server/longevity/harness.ts` | Harness: config, in-process server, load generator, lifecycle |
| `api-server/longevity/monitor.ts` | Memory and resource sampling |
| `api-server/longevity/detectors.ts` | Leak and resource-exhaustion detection |
| `api-server/longevity/report.ts` | Markdown / JSON / CSV reports |
| `.github/workflows/longevity.yml` | Weekly soak, manual runs, PR smoke run |

In **in-process** mode the Soroban RPC is mocked with deterministic data. The
harness measures only the API server's own code (routing, serialisation,
error handling, search index and caches), and results don't depend on testnet availability.

In **external** mode the harness loads a server that is already running (for
example, one pointed at a real RPC):

```bash
npm start &                     # or any deployment
LONGEVITY_TARGET_URL=http://localhost:3000 \
LONGEVITY_TARGET_PID=$! \
LONGEVITY_DURATION=2h npm run longevity
```

In external mode, RSS and FD counts are read from `/proc/<pid>` of the target
process. Heap, handle and event-loop metrics refer to the load generator
itself, so the heap and handle checks are skipped.

## Memory monitoring

With `--expose-gc` (the npm scripts pass it), the harness forces a full GC
before each sample. `heapUsed` then measures retained memory, not allocation
churn, which is what leak detection needs.

Detection ignores the warm-up window (`LONGEVITY_WARMUP`, default 60s locally
and 120s in CI) because JIT compilation, caches and connection pools settle
during that time. It then fits a least-squares line to each metric:

| Check | Fails when |
|---|---|
| `heap-used-growth` | Steady (R² ≥ 0.6) growth above 10 MB/h |
| `external-memory-growth` | Buffers / ArrayBuffers grow steadily above 10 MB/h |
| `rss-growth` | Steady RSS growth above 25 MB/h |

A metric only fails when the slope is over budget **and** the fit is good.
Ordinary GC saw-tooth noise has a low R² and passes. A slope that is merely
over half the budget is a warning.

## Resource exhaustion detection

| Check | Fails when | Typical cause |
|---|---|---|
| `heap-limit-headroom` | Peak heap ≥ 85% of V8 `heap_size_limit` | Unbounded cache, very large responses |
| `active-handle-growth` | Active handles grow by > 20 | Leaked sockets, timers that are never cleared |
| `fd-growth` | Open FDs grow by > 20 | Sockets / files not closed |
| `event-loop-lag` | Any interval's event-loop p99 > 100 ms | Sync work growing with data size, GC pressure |
| `error-rate` | 5xx + network errors > 1% | Exhaustion showing up as failures |
| `latency-degradation` | Last-quarter p99 > 2× first-quarter p99 | Growing data structures, fragmentation |

Handle and FD growth compare the median of the first and last 10% of samples,
so a single spike doesn't trigger them.

## Reports

Each run writes:

- **`report.md`**: verdict, per-check results, and a start/end/peak/sparkline
  table for every metric. CI appends it to the job summary.
- **`report.json`**: run info, thresholds, findings and all samples, for
  tracking results across runs.
- **`samples.csv`**: raw samples, ready for a spreadsheet or plotting tool.

The exit code is `0` for pass or warn, `1` for fail, and `2` for a harness
error. With `LONGEVITY_STRICT=1`, warn also exits `1`. Ctrl-C stops the run
early and still writes a report.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LONGEVITY_DURATION` | `30m` | Run length (`90s`, `30m`, `4h`) |
| `LONGEVITY_WARMUP` | `60s` | Excluded from trend analysis (capped at ¼ of the duration) |
| `LONGEVITY_SAMPLE_INTERVAL` | `5s` | Sampling period |
| `LONGEVITY_CONCURRENCY` | `8` | Concurrent virtual clients |
| `LONGEVITY_TARGET_URL` | – | Enables external mode |
| `LONGEVITY_TARGET_PID` | – | PID of the external server, for RSS/FD sampling |
| `LONGEVITY_REPORT_DIR` | `./longevity-reports/<ts>` | Output directory |
| `LONGEVITY_STRICT` | `0` | Treat warnings as failures |
| `LONGEVITY_MAX_HEAP_GROWTH_MB_H` | `10` | Heap growth budget |
| `LONGEVITY_MAX_RSS_GROWTH_MB_H` | `25` | RSS growth budget |
| `LONGEVITY_MAX_FD_GROWTH` | `20` | FD growth budget |
| `LONGEVITY_MAX_HANDLE_GROWTH` | `20` | Handle growth budget |
| `LONGEVITY_MAX_EVENT_LOOP_P99_MS` | `100` | Event-loop lag limit |
| `LONGEVITY_MAX_ERROR_RATE` | `0.01` | Error-rate limit |

## CI schedule

| Trigger | Duration | Purpose |
|---|---|---|
| PR touching `api-server/**` | 3 min | Smoke run; catches gross leaks and broken shutdown |
| Weekly (Sunday 02:00 UTC) | 2 h | Soak test |
| Manual dispatch | chosen (≤ 6 h) | Before releases, or while investigating a suspected leak |

Reports are kept as workflow artifacts for 30 days.

## Investigating a failure

1. Open `report.md` and check which metric grew and whether growth started
   right away or after some time.
2. Reproduce locally with the same duration and concurrency.
3. For heap growth, run with `node --inspect --expose-gc --import tsx longevity/harness.ts`,
   take two heap snapshots a few minutes apart in Chrome DevTools and compare
   the retained objects.
4. For handle or FD growth, look for sockets or timers created per request that
   are never closed or cleared.
5. Add a regression scenario to `scenarios` in `harness.ts` that exercises the
   leaking path.
