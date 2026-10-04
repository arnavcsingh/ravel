"""Admission and unavailable-metric boundaries for saved native reports."""

import contextlib
import io
import json
import hashlib
from pathlib import Path
import tempfile
import unittest

from ravel.upstream_results import export, summarize


class UpstreamResultsTests(unittest.TestCase):
    def write_bundle(self, path, valid=True, eligible=True):
        path.mkdir()
        artifact = b"{}"
        (path / "report.json").write_bytes(artifact)
        bundle = {
            "artifacts": {"report.json": {"bytes": len(artifact), "sha256": hashlib.sha256(artifact).hexdigest()}},
            "status": "valid" if valid else "invalid",
            "instrumentation": {"valid": valid},
            "eligibility": {"official_aggregate": eligible},
            "protocol": "single",
            "provenance": {"model": "gemini/test", "api_key": "must-not-export"},
        }
        (path / "run_bundle.json").write_text(json.dumps(bundle), encoding="utf-8")

    def test_invalid_and_ineligible_attempts_are_excluded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.write_bundle(root / "native-1")
            self.write_bundle(root / "native-2", valid=False)
            self.write_bundle(root / "native-3", eligible=False)
            with contextlib.redirect_stdout(io.StringIO()):
                export(root)
            result = json.loads((root / "comparison.json").read_text(encoding="utf-8"))
            self.assertEqual(len(result["comparison"]), 1)
            self.assertEqual(len(result["excluded_attempts"]), 2)
            self.assertNotIn("must-not-export", json.dumps(result))

    def test_missing_metrics_and_ravel_are_not_zero(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "native-1"
            self.write_bundle(path)
            result = summarize(path)
            self.assertIsNone(result["native"]["normalized_drs"])
            self.assertIsNone(result["native"]["total_tokens"])
            self.assertIsNone(result["ravel"])

    def test_modified_artifact_excludes_recorded_valid_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "native-1"
            self.write_bundle(path)
            (path / "report.json").write_text('{"changed":true}', encoding="utf-8")
            result = summarize(path)
            self.assertFalse(result["admitted"])
            self.assertEqual(result["local_artifact_issues"], ["artifact_checksum_mismatch:report.json"])
