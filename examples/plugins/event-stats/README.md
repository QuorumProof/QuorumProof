# @quorumproof/plugin-event-stats

Example plugin for the QuorumProof API server (issue #1647). Start here when
writing your own — the full walkthrough is in
[docs/plugin-development-guide.md](../../../docs/plugin-development-guide.md).

## What it does

- Counts broadcast events per type.
- `GET /api/plugins/event-stats/stats` returns the counters.
- Optionally POSTs every event to `forwardUrl`.
- Adds `plugin:event-stats:forwarder` to `/health` (degraded after
  `failureThreshold` consecutive forward failures).

## Enable

From `api-server/`:

```bash
QUORUMPROOF_PLUGINS=../examples/plugins/event-stats/index.js \
QUORUMPROOF_PLUGIN_CONFIG='{"../examples/plugins/event-stats/index.js":{"forwardUrl":"https://example.com/hook","failureThreshold":5}}' \
npm run dev
```

## Config

| Key | Type | Default | |
|---|---|---|---|
| `forwardUrl` | string | — | Forward each event as JSON. |
| `failureThreshold` | number | `5` | Consecutive failures before health degrades. |

## Test

```bash
npm install
npm test
```
