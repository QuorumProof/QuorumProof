"""#846 — Automated performance regression detection.

Compares live p95 query latency against a persisted JSON baseline and
emits Prometheus metrics when operations breach their SLA ceiling.
"""

import json
import logging
import math
import os
import time
from collections import defaultdict, deque
from typing import Deque, Dict, Optional

from metrics import (
    contract_invocation_duration_seconds,
    performance_regression_detected,
    query_baseline_p95_seconds,
    query_sla_threshold_seconds,
    query_sla_violations_total,
)

logger = logging.getLogger(__name__)

# Default SLA ceilings in seconds per contract operation.
DEFAULT_SLA_SECONDS: Dict[str, float] = {
    "issue_credential": 2.0,
    "revoke_credential": 2.0,
    "attest": 2.0,
    "get_credential": 0.5,
    "get_slice": 0.5,
    "verify_proof": 5.0,
}

# How much slower than baseline (relative) triggers a regression alert.
REGRESSION_THRESHOLD_RATIO = 1.20  # 20% slower than baseline
SAMPLE_WINDOW = 1000


class PerformanceRegressionDetector:
    """Detects latency regressions against a stored baseline."""

    def __init__(
        self,
        baseline_path: str = "performance_baseline.json",
        sla_config: Optional[Dict[str, float]] = None,
    ):
        self.baseline_path = baseline_path
        self.sla: Dict[str, float] = sla_config or DEFAULT_SLA_SECONDS
        self.baseline: Dict[str, float] = self._load_baseline()
        self._samples: Dict[str, Deque[float]] = defaultdict(
            lambda: deque(maxlen=SAMPLE_WINDOW)
        )
        self._register_sla_metrics()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def record_query(self, operation: str, duration_seconds: float) -> None:
        """Record a single query duration and check SLA / regression."""
        contract_invocation_duration_seconds.labels(operation=operation).observe(
            duration_seconds
        )
        self._samples[operation].append(duration_seconds)

        sla_ceiling = self.sla.get(operation)
        if sla_ceiling is not None and duration_seconds > sla_ceiling:
            query_sla_violations_total.labels(operation=operation).inc()
            logger.warning(
                "SLA breach on %s: %.3fs > %.3fs ceiling",
                operation,
                duration_seconds,
                sla_ceiling,
            )

    def evaluate(self) -> None:
        """Compare current p95 estimates against baseline; update metrics."""
        for operation in self.sla:
            p95 = self._estimate_p95(operation)
            if p95 is None:
                continue

            baseline_p95 = self.baseline.get(operation)
            if baseline_p95 is None:
                continue

            ratio = p95 / baseline_p95 if baseline_p95 > 0 else 1.0
            is_regression = ratio >= REGRESSION_THRESHOLD_RATIO
            performance_regression_detected.labels(operation=operation).set(
                1 if is_regression else 0
            )
            query_baseline_p95_seconds.labels(operation=operation).set(baseline_p95)

            if is_regression:
                logger.warning(
                    "Performance regression on %s: p95=%.3fs is %.0f%% above baseline %.3fs",
                    operation,
                    p95,
                    (ratio - 1) * 100,
                    baseline_p95,
                )

    def save_baseline(self) -> None:
        """Persist current p95 estimates as the new baseline."""
        new_baseline: Dict[str, float] = {}
        for operation in self.sla:
            p95 = self._estimate_p95(operation)
            if p95 is not None:
                new_baseline[operation] = p95

        with open(self.baseline_path, "w") as fh:
            json.dump(
                {"recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "p95": new_baseline},
                fh,
                indent=2,
            )
        self.baseline = new_baseline
        logger.info("Performance baseline saved to %s", self.baseline_path)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load_baseline(self) -> Dict[str, float]:
        if not os.path.exists(self.baseline_path):
            logger.info("No baseline file found at %s; regression detection disabled until baseline is saved.", self.baseline_path)
            return {}
        try:
            with open(self.baseline_path) as fh:
                data = json.load(fh)
            return data.get("p95", {})
        except Exception as exc:
            logger.error("Failed to load baseline from %s: %s", self.baseline_path, exc)
            return {}

    def _estimate_p95(self, operation: str) -> Optional[float]:
        """Estimate p95 from the bounded in-memory sample window."""
        samples = self._samples.get(operation)
        if not samples:
            return None

        ordered = sorted(samples)
        index = max(0, math.ceil(0.95 * len(ordered)) - 1)
        return float(ordered[index])

    def _register_sla_metrics(self) -> None:
        for operation, ceiling in self.sla.items():
            query_sla_threshold_seconds.labels(operation=operation).set(ceiling)
            performance_regression_detected.labels(operation=operation).set(0)
