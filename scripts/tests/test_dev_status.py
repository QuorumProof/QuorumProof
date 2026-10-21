"""Tests for scripts/dev_status.py (#1673)."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import dev_status  # noqa: E402


LCOV_SAMPLE = """\
SF:src/a.ts
LF:10
LH:7
end_of_record
SF:src/b.ts
LF:5
LH:5
end_of_record
"""


class ParseLcovTests(unittest.TestCase):
    def test_sums_lines_across_records(self):
        self.assertEqual(dev_status.parse_lcov(LCOV_SAMPLE), (15, 12))

    def test_empty_input_yields_zero(self):
        self.assertEqual(dev_status.parse_lcov(""), (0, 0))


class CoverageTests(unittest.TestCase):
    def test_missing_file_is_reported_not_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = dev_status.collect_coverage({"frontend": Path(tmp) / "nope.info"})
        self.assertEqual(len(result), 1)
        self.assertFalse(result[0].available)
        self.assertIsNone(result[0].percent)
        self.assertEqual(result[0].status, "no data")

    def test_threshold_classification(self):
        ok = dev_status.Coverage("a", lines_found=100, lines_hit=75, available=True)
        low = dev_status.Coverage("b", lines_found=100, lines_hit=69, available=True)
        self.assertEqual(ok.status, "ok")
        self.assertEqual(low.status, "below threshold")

    def test_threshold_boundary_is_inclusive(self):
        at = dev_status.Coverage("c", lines_found=100, lines_hit=70, available=True)
        self.assertEqual(at.status, "ok")


class ContractSizeTests(unittest.TestCase):
    def test_reports_size_and_marks_unbuilt(self):
        with tempfile.TemporaryDirectory() as tmp:
            wasm_dir = Path(tmp)
            (wasm_dir / "quorum_proof.wasm").write_bytes(b"x" * 2048)
            sizes = dev_status.collect_contract_sizes(wasm_dir, ["quorum_proof", "sbt_registry"])
        self.assertEqual(sizes[0].size_bytes, 2048)
        self.assertIsNone(sizes[1].size_bytes)


class FormatTests(unittest.TestCase):
    def test_format_bytes(self):
        self.assertEqual(dev_status.format_bytes(None), "not built")
        self.assertEqual(dev_status.format_bytes(512), "512 B")
        self.assertEqual(dev_status.format_bytes(2048), "2.0 KiB")
        self.assertEqual(dev_status.format_bytes(3 * 1024 * 1024), "3.00 MiB")


class RenderTests(unittest.TestCase):
    def _status(self, **kwargs):
        base = dict(generated_at="2026-01-01 00:00 UTC", coverage=[], contracts=[])
        base.update(kwargs)
        return dev_status.DevStatus(**base)

    def test_html_escapes_user_controlled_text(self):
        status = self._status(
            activity=dev_status.Activity(branch="<script>alert(1)</script>"),
        )
        page = dev_status.render_html(status)
        self.assertNotIn("<script>alert(1)</script>", page)
        self.assertIn("&lt;script&gt;", page)

    def test_below_threshold_row_is_flagged(self):
        status = self._status(
            coverage=[dev_status.Coverage("frontend", lines_found=10, lines_hit=1, available=True)],
        )
        self.assertIn('class="bad"', dev_status.render_html(status))

    def test_ci_section_states_when_not_collected(self):
        page = dev_status.render_html(self._status(ci_runs=None))
        self.assertIn("CI data not collected", page)


class WriteOutputsTests(unittest.TestCase):
    def test_writes_html_and_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            status = dev_status.DevStatus(generated_at="now", coverage=[], contracts=[])
            html_path, json_path = dev_status.write_outputs(status, Path(tmp) / "out")
            self.assertTrue(html_path.read_text(encoding="utf-8").startswith("<!doctype html>"))
            data = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertEqual(data["generated_at"], "now")


if __name__ == "__main__":
    unittest.main()
