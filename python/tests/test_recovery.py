"""Exercise actual process death, SQLite reopening, reconstruction and CLI reset."""

from pathlib import Path
import subprocess
import tempfile
import unittest

from ravel.client import Client
from ravel.process import BINARY, ROOT, RuntimeProcess


class RecoveryTests(unittest.TestCase):
    def test_process_recovery_and_archive_reset(self):
        with tempfile.TemporaryDirectory(prefix="ravel-recovery-") as temporary:
            directory = Path(temporary) / "data"
            with RuntimeProcess(directory) as process:
                client = Client(process.url)
                run = client.create_run("Recovery", files={"input.txt": "original"})
                agent = client.create_agent(run, "Writer")
                session = client.create_attempt(run, agent, "Write", "Observe and write")
                session.observe_resource("input.txt")
                session.write_resource("output.txt", "committed")
                pending = session.write_intent("output.txt", "uncommitted")
                before = client.snapshot(run)
                workspace = Path(before["run"]["workspace"])
                active_reset = subprocess.run([str(BINARY), "-data", str(directory), "-reset"], cwd=ROOT, capture_output=True, text=True)
                self.assertNotEqual(active_reset.returncode, 0)
                self.assertIn("already owns", active_reset.stderr)
            (workspace / "output.txt").write_text("external damage", encoding="utf-8")
            with RuntimeProcess(directory) as process:
                client = Client(process.url)
                self.assertEqual(client.snapshot(run), before)
                client.request(f"/runs/{run}/reconstruct", {})
                self.assertEqual((workspace / "output.txt").read_text(), "committed")
                # Captured intent remains historical, but restart never publishes it.
                self.assertTrue(any(e["kind"] == "WRITE_INTENT" and e["payload"]["id"] == pending["id"] for e in client.events(run)))
            result = subprocess.run([str(BINARY), "-data", str(directory), "-reset"], cwd=ROOT, capture_output=True, text=True, check=True)
            archived = Path(result.stdout.split("Previous data archived:", 1)[1].strip())
            self.assertTrue((archived / "ravel.db").is_file())
            self.assertFalse(directory.exists())
            with RuntimeProcess(directory, seed=True) as process:
                runs = Client(process.url).request("/runs")
                self.assertEqual(len(runs), 1)
                self.assertNotEqual(runs[0]["id"], run)
