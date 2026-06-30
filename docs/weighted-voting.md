# Weighted quorum voting

Quorum slices assign each attestor an integer trust weight from 1 through 100. A weight is
relative within one slice; it is not a global reputation score. Slice creators should assign
weights from documented evidence and avoid giving one organization unilateral control unless
that is an explicit policy decision.

## Consensus algorithm

For a credential and slice, the contract evaluates each unexpired, positive attestation that was
submitted through that slice. Suspended attestors contribute zero. Each accepted attestation
contributes the attestor's weight captured at submission time:

```text
achieved_weight = sum(captured_weight(attestation))
consensus       = achieved_weight >= required_weight
```

Capturing the weight at submission prevents a later weight update from revaluing past
attestations. New attestations use the current weight. Threshold changes intentionally apply to
future consensus queries so credential types can adopt different policies over time.

The slice creator chooses one of two threshold modes:

- Absolute: `required_weight = threshold`, where `1 <= threshold <= total_weight`.
- Percentage: `required_weight = ceil(total_weight * percentage / 100)`, where the percentage is
  from 1 through 100. Ceiling division prevents rounding from weakening the configured policy.

For weights `[2, 1, 1]`, an absolute threshold of `3` is met by the weight-2 licensing body and
either weight-1 attestor. A 67% threshold requires `ceil(4 * 67 / 100) = 3` weight units.

## Dynamic management and security

Only the slice creator can add or remove attestors, change weights, or change thresholds. Weight
updates outside 1-100 are rejected. An absolute-threshold slice also rejects a weight reduction
that would make its threshold unreachable. Percentage thresholds automatically track the current
total weight.

`get_weight_audit` provides the immutable sequence of weight changes. `get_weight_distribution`
returns attestor count, total, minimum, maximum, and integer-average weight. Consensus history
records achieved, required, and total weight when a decision reaches threshold.

## Assignment guidance

- Use a small documented scale, such as 1 for direct employers, 2 for accredited institutions,
  and 3 for national regulators. The 1-100 range is a limit, not a reason to use all values.
- Prefer a threshold that requires independent trust domains. A simple majority is above 50%; a
  common supermajority policy is 67%.
- Review concentration through `get_weight_distribution`. If `maximum_weight >= required_weight`,
  one attestor can decide consensus alone.
- Change weights prospectively when evidence changes. Revoke or expire an attestation when its
  underlying evidence, rather than the attestor's general trust level, is no longer valid.

## API summary

- `create_slice`: create a slice with an absolute weight threshold.
- `create_slice_percentage`: create a slice with a percentage threshold.
- `update_attestor_weight`: update one attestor's prospective weight (creator only).
- `update_slice_threshold`: switch to or update an absolute threshold (creator only).
- `update_percentage_threshold`: switch to or update a percentage threshold (creator only).
- `get_slice_threshold_config`: inspect mode, configured value, and effective required weight.
- `get_weight_distribution` / `get_weight_audit`: inspect metrics and change history.
