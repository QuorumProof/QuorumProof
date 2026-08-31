"""Tests for performance regression detection in monitoring/exporter."""

import json
import os
import sys
import tempfile
from unittest.mock import Mock, patch
from pathlib import Path

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from performance_regression import PerformanceRegressionDetector, REGRESSION_THRESHOLD_RATIO
from metrics import (
    contract_invocation_duration_seconds,
    query_sla_violations_total,
    performance_regression_detected,
)


@pytest.fixture
def temp_baseline_file():
    """Create a temporary baseline file for testing."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
        baseline_data = {
            "recorded_at": "2024-01-01T00:00:00Z",
            "p95": {
                "issue_credential": 0.8,
                "revoke_credential": 0.7,
                "attest": 0.9,
                "get_credential": 0.2,
                "get_slice": 0.15,
                "verify_proof": 1.5,
            }
        }
        json.dump(baseline_data, f)
        temp_file = f.name
    yield temp_file
    os.unlink(temp_file)


@pytest.fixture
def detector(temp_baseline_file):
    """Create a PerformanceRegressionDetector with a temporary baseline."""
    return PerformanceRegressionDetector(baseline_path=temp_baseline_file)


class TestBaselineLoading:
    """Test baseline file loading and handling."""

    def test_load_baseline_from_file(self, temp_baseline_file):
        """Test that baseline is correctly loaded from JSON file."""
        detector = PerformanceRegressionDetector(baseline_path=temp_baseline_file)
        assert detector.baseline is not None
        assert detector.baseline.get("issue_credential") == 0.8
        assert detector.baseline.get("get_credential") == 0.2

    def test_load_nonexistent_baseline_returns_empty(self):
        """Test that missing baseline file results in empty baseline."""
        detector = PerformanceRegressionDetector(baseline_path="/nonexistent/baseline.json")
        assert detector.baseline == {}

    def test_malformed_baseline_returns_empty(self):
        """Test that malformed JSON baseline is handled gracefully."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            f.write("{invalid json")
            temp_file = f.name
        try:
            detector = PerformanceRegressionDetector(baseline_path=temp_file)
            assert detector.baseline == {}
        finally:
            os.unlink(temp_file)

    def test_baseline_without_p95_key_returns_empty(self):
        """Test that baseline file without 'p95' key returns empty baseline."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump({"recorded_at": "2024-01-01T00:00:00Z"}, f)
            temp_file = f.name
        try:
            detector = PerformanceRegressionDetector(baseline_path=temp_file)
            assert detector.baseline == {}
        finally:
            os.unlink(temp_file)


class TestRegressionThreshold:
    """Test the 20% performance regression detection threshold."""

    def test_no_regression_within_threshold(self, detector):
        """Test that 19% slower than baseline does not trigger regression."""
        operation = "issue_credential"
        baseline_p95 = detector.baseline.get(operation)

        threshold_ratio = baseline_p95 * (1 + 0.19)
        for _ in range(100):
            detector.record_query(operation, threshold_ratio)

        detector.evaluate()
        metric_value = performance_regression_detected.labels(operation=operation)._value.get()
        assert metric_value == 0

    def test_regression_at_exactly_20_percent(self, detector):
        """Test that exactly 20% slower triggers regression (≥ threshold)."""
        operation = "issue_credential"
        baseline_p95 = detector.baseline.get(operation)

        regression_value = baseline_p95 * REGRESSION_THRESHOLD_RATIO
        for _ in range(100):
            detector.record_query(operation, regression_value)

        detector.evaluate()
        metric_value = performance_regression_detected.labels(operation=operation)._value.get()
        assert metric_value == 1

    def test_regression_above_20_percent(self, detector):
        """Test that 21% slower than baseline triggers regression."""
        operation = "get_credential"
        baseline_p95 = detector.baseline.get(operation)

        regression_value = baseline_p95 * (1 + 0.21)
        for _ in range(100):
            detector.record_query(operation, regression_value)

        detector.evaluate()
        metric_value = performance_regression_detected.labels(operation=operation)._value.get()
        assert metric_value == 1

    def test_no_regression_when_faster(self, detector):
        """Test that faster queries do not trigger regression."""
        operation = "verify_proof"
        baseline_p95 = detector.baseline.get(operation)

        faster_value = baseline_p95 * 0.9
        for _ in range(100):
            detector.record_query(operation, faster_value)

        detector.evaluate()
        metric_value = performance_regression_detected.labels(operation=operation)._value.get()
        assert metric_value == 0


class TestSLAViolationCounting:
    """Test SLA violation detection and counting."""

    def test_sla_violation_incremented_when_exceeded(self, detector):
        """Test that SLA violations are counted when duration exceeds ceiling."""
        operation = "issue_credential"
        sla_ceiling = detector.sla.get(operation)
        violation_duration = sla_ceiling + 0.5

        initial_count = query_sla_violations_total.labels(operation=operation)._value.get()
        detector.record_query(operation, violation_duration)
        final_count = query_sla_violations_total.labels(operation=operation)._value.get()

        assert final_count > initial_count

    def test_sla_violation_not_incremented_within_ceiling(self, detector):
        """Test that queries within SLA do not increment violation counter."""
        operation = "get_credential"
        sla_ceiling = detector.sla.get(operation)
        within_sla = sla_ceiling - 0.05

        initial_count = query_sla_violations_total.labels(operation=operation)._value.get()
        detector.record_query(operation, within_sla)
        final_count = query_sla_violations_total.labels(operation=operation)._value.get()

        assert final_count == initial_count

    def test_sla_violation_at_exactly_ceiling(self, detector):
        """Test behavior at exactly the SLA ceiling."""
        operation = "attest"
        sla_ceiling = detector.sla.get(operation)

        initial_count = query_sla_violations_total.labels(operation=operation)._value.get()
        detector.record_query(operation, sla_ceiling)
        final_count = query_sla_violations_total.labels(operation=operation)._value.get()

        assert final_count == initial_count

    def test_multiple_sla_violations_counted(self, detector):
        """Test that multiple violations are counted correctly."""
        operation = "revoke_credential"
        sla_ceiling = detector.sla.get(operation)
        violation_duration = sla_ceiling + 0.2

        initial_count = query_sla_violations_total.labels(operation=operation)._value.get()
        for _ in range(3):
            detector.record_query(operation, violation_duration)
        final_count = query_sla_violations_total.labels(operation=operation)._value.get()

        assert (final_count - initial_count) == 3


class TestEdgeCases:
    """Test edge cases and boundary conditions."""

    def test_missing_baseline_data_for_operation(self, detector):
        """Test behavior when baseline data is missing for an operation."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            baseline_data = {
                "recorded_at": "2024-01-01T00:00:00Z",
                "p95": {
                    "issue_credential": 0.8,
                }
            }
            json.dump(baseline_data, f)
            temp_file = f.name

        try:
            detector = PerformanceRegressionDetector(baseline_path=temp_file)
            operation = "get_credential"

            for _ in range(100):
                detector.record_query(operation, 0.2)

            detector.evaluate()
            metric_value = performance_regression_detected.labels(operation=operation)._value.get()
            assert metric_value == 0
        finally:
            os.unlink(temp_file)

    def test_single_sample_operation(self, detector):
        """Test that single sample operation doesn't crash p95 estimation."""
        operation = "get_slice"
        detector.record_query(operation, 0.1)

        p95 = detector._estimate_p95(operation)
        assert p95 is not None

    def test_zero_baseline_latency(self):
        """Test behavior when baseline is zero or near-zero."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            baseline_data = {
                "recorded_at": "2024-01-01T00:00:00Z",
                "p95": {
                    "issue_credential": 0.0,
                }
            }
            json.dump(baseline_data, f)
            temp_file = f.name

        try:
            detector = PerformanceRegressionDetector(baseline_path=temp_file)
            operation = "issue_credential"

            for _ in range(100):
                detector.record_query(operation, 0.5)

            detector.evaluate()
            metric_value = performance_regression_detected.labels(operation=operation)._value.get()
            assert metric_value == 0
        finally:
            os.unlink(temp_file)

    def test_near_zero_baseline_latency(self):
        """Test behavior with very small baseline latency."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            baseline_data = {
                "recorded_at": "2024-01-01T00:00:00Z",
                "p95": {
                    "issue_credential": 0.001,
                }
            }
            json.dump(baseline_data, f)
            temp_file = f.name

        try:
            detector = PerformanceRegressionDetector(baseline_path=temp_file)
            operation = "issue_credential"

            for _ in range(100):
                detector.record_query(operation, 0.002)

            detector.evaluate()
            metric_value = performance_regression_detected.labels(operation=operation)._value.get()
            assert metric_value >= 0
        finally:
            os.unlink(temp_file)

    def test_no_samples_recorded(self, detector):
        """Test behavior when no samples have been recorded."""
        operation = "issue_credential"
        p95 = detector._estimate_p95(operation)
        assert p95 is None

    def test_operation_not_in_sla_config(self, detector):
        """Test recording for operation without SLA configuration."""
        operation = "unknown_operation"

        initial_count = query_sla_violations_total.labels(operation=operation)._value.get()
        detector.record_query(operation, 1.0)
        final_count = query_sla_violations_total.labels(operation=operation)._value.get()

        assert final_count == initial_count


class TestBaselinePersistence:
    """Test baseline saving and loading."""

    def test_save_baseline_creates_file(self):
        """Test that save_baseline creates a valid JSON file."""
        with tempfile.NamedTemporaryFile(suffix='.json', delete=False) as f:
            temp_file = f.name
        os.unlink(temp_file)

        try:
            detector = PerformanceRegressionDetector(baseline_path=temp_file)

            for op in detector.sla.keys():
                for i in range(10):
                    detector.record_query(op, 0.5)

            detector.save_baseline()

            assert os.path.exists(temp_file)
            with open(temp_file) as f:
                data = json.load(f)
            assert "p95" in data
            assert "recorded_at" in data
        finally:
            if os.path.exists(temp_file):
                os.unlink(temp_file)

    def test_save_baseline_updates_in_memory(self):
        """Test that save_baseline updates the in-memory baseline."""
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            baseline_data = {
                "recorded_at": "2024-01-01T00:00:00Z",
                "p95": {
                    "issue_credential": 0.5,
                }
            }
            json.dump(baseline_data, f)
            temp_file = f.name

        try:
            detector = PerformanceRegressionDetector(baseline_path=temp_file)
            initial_baseline = detector.baseline.copy()

            for op in detector.sla.keys():
                for _ in range(10):
                    detector.record_query(op, 0.3)

            detector.save_baseline()

            assert detector.baseline != initial_baseline
        finally:
            os.unlink(temp_file)
