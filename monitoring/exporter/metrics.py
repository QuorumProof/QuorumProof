"""Prometheus metrics definitions for QuorumProof contract monitoring."""

from prometheus_client import Counter, Gauge, Histogram, CollectorRegistry

# Create a registry for all metrics
registry = CollectorRegistry()

# Counters
credentials_issued_total = Counter(
    'quorumproof_credentials_issued_total',
    'Total credentials issued since deployment',
    registry=registry
)

credentials_revoked_total = Counter(
    'quorumproof_credentials_revoked_total',
    'Total credentials revoked',
    registry=registry
)

attestations_total = Counter(
    'quorumproof_attestations_total',
    'Total attestation events',
    registry=registry
)

api_errors_total = Counter(
    'quorumproof_api_errors_total',
    'Total RPC / contract errors',
    ['error_code'],
    registry=registry
)

proof_requests_total = Counter(
    'quorumproof_proof_requests_total',
    'Total ZK proof requests generated',
    registry=registry
)

rate_limit_hits_total = Counter(
    'quorumproof_rate_limit_hits_total',
    'Times rate limit was exceeded',
    ['address'],
    registry=registry
)

# Gauges
attestation_success_rate = Gauge(
    'quorumproof_attestation_success_rate',
    'Ratio of attested credentials to total issued (0–1)',
    registry=registry
)

contract_paused = Gauge(
    'quorumproof_contract_paused',
    '1 if contract is paused, 0 otherwise',
    registry=registry
)

active_slices_total = Gauge(
    'quorumproof_active_slices_total',
    'Number of quorum slices currently active',
    registry=registry
)

contract_gas_usage = Gauge(
    'quorumproof_contract_gas_usage',
    'Gas usage for contract operations',
    ['operation'],
    registry=registry
)

contract_state_size = Gauge(
    'quorumproof_contract_state_size',
    'Size of contract state in bytes',
    registry=registry
)

backup_last_success_timestamp = Gauge(
    'quorumproof_backup_last_success_timestamp',
    'Unix timestamp of the last successful backup verification',
    registry=registry
)

backup_verification_status = Gauge(
    'quorumproof_backup_verification_status',
    '1 if the most recent backup passed verification, 0 if it failed',
    registry=registry
)

# Histograms
api_request_duration_seconds = Histogram(
    'quorumproof_api_request_duration_seconds',
    'RPC call latency',
    buckets=(0.1, 0.5, 1, 2, 5),
    registry=registry
)

contract_invocation_duration_seconds = Histogram(
    'quorumproof_contract_invocation_duration_seconds',
    'Contract invocation latency',
    ['operation'],
    buckets=(0.1, 0.5, 1, 2, 5),
    registry=registry
)
