"""Launcher contracts: credentials stay in environment and upstream owns execution."""
import unittest
import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tempfile
from unittest.mock import patch

from ravel.upstream import main, model_environment


class UpstreamTests(unittest.TestCase):
    def test_windows_console_is_configured_for_utf8(self):
        buffer = io.BytesIO()
        console = io.TextIOWrapper(buffer, encoding="cp1252", newline="\n")
        with patch("sys.stdout", console):
            with self.assertRaises(ValueError):
                main(["unknown"])
            print("✓")
        console.flush()
        self.assertEqual(buffer.getvalue(), "✓\n".encode("utf-8"))

    def test_unicode_output_redaction_and_exit_status(self):
        # A real byte-producing child exercises decoding on Windows too.
        spawn_child = subprocess.Popen
        with tempfile.TemporaryDirectory() as directory:
            def launch(command, **kwargs):
                self.assertNotIn("test-secret", command)
                self.assertEqual(kwargs["encoding"], "utf-8")
                self.assertEqual(kwargs["errors"], "replace")
                return spawn_child(
                    [sys.executable, "-c", "import sys; sys.stdout.buffer.write('✓ test-secret\\n'.encode('utf-8') + b'\\x90\\n'); sys.exit(7)"],
                    **kwargs,
                )
            output = io.StringIO()
            with patch("ravel.upstream.ROOT", Path(directory)), patch.dict("os.environ", {"GEMINI_API_KEY": "test-secret"}, clear=True), patch("ravel.upstream.subprocess.Popen", side_effect=launch), contextlib.redirect_stdout(output):
                self.assertEqual(main(["doctor"]), 7)
            log = next((Path(directory) / ".ravel/benchmark-source/reports").glob("*.log")).read_text(encoding="utf-8")
            self.assertIn("✓ [redacted]", log)
            self.assertIn("\ufffd", log)
            self.assertIn("Exit: 7", log)
            self.assertNotIn("test-secret", log + output.getvalue())

    def test_gemini_environment_and_wsl_forwarding(self):
        result = model_environment({"GEMINI_API_KEY": "test-secret", "WSLENV": "EXISTING"})
        self.assertEqual(result["LLM_API_KEY"], "test-secret")
        self.assertEqual(result["LLM_MODEL"], "gemini/gemini-3.5-flash-lite")
        self.assertEqual(result["LLM_BASE_URL"], "https://generativelanguage.googleapis.com/v1beta")
        self.assertIn("LLM_API_KEY", result["WSLENV"].split(":"))
        self.assertNotIn("test-secret", result["WSLENV"])
        self.assertTrue(result["WSLENV"].startswith("EXISTING:"))

    def test_explicit_provider_is_preserved(self):
        source = {"LLM_API_KEY": "explicit", "LLM_MODEL": "provider/model", "LLM_BASE_URL": "https://example.test/v1"}
        result = model_environment(source)
        self.assertEqual({k: result[k] for k in source}, source)
        with self.assertRaises(ValueError):
            model_environment({"LLM_API_KEY": "incomplete"})
        with self.assertRaises(ValueError):
            model_environment({})

    def test_invalid_budget_never_starts_harness(self):
        with patch.dict("os.environ", {"GEMINI_API_KEY": "test"}, clear=True), patch("ravel.upstream.subprocess.Popen") as spawn:
            with self.assertRaises(SystemExit):
                main(["run", "--max-iterations", "0"])
            spawn.assert_not_called()


if __name__ == "__main__":
    unittest.main()
