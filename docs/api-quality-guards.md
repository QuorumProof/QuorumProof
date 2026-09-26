# API Quality Guards

This note tracks lightweight quality controls for the API server.

## GraphQL Depth Limiting

`api-server/src/routes/graphql.ts` rejects queries deeper than
`GRAPHQL_MAX_DEPTH` before resolver execution. The default limit is `8`.

## Contract Invariant Testing

Contract invariant scenarios should live under `contracts/integration_tests`
and focus on state transitions that must hold across upgrades:

- credentials cannot become valid after revocation
- expired credentials cannot be verified as active
- attestor reputation updates must be monotonic within one event batch
- replayed proof requests must not create duplicate state

## Performance Profiling In CI

CI jobs can run API profiling with:

```bash
npm --prefix api-server run build
node --cpu-prof api-server/dist/index.js
```

Store generated `*.cpuprofile` files as workflow artifacts when profiling is
enabled.

## Scenario-Based Testing

Scenario files should describe setup, API calls, expected state, and rollback
expectations. Keep them deterministic and isolated from live networks.
