"""Offline orchestration tests. Provider fixtures are never used by live startup."""
import tempfile
import threading
import time
import unittest
from pathlib import Path
from ravel.live_demo import LiveDemo, FILES, PROMPTS
from ravel.process import RuntimeProcess
from ravel.gemini import GeminiError


class ProviderFixture:
    def __init__(self, no_mutation=False, fail=False, semantic_fail=False):
        self.no_mutation, self.fail, self.semantic_fail = no_mutation, fail, semantic_fail

    def run_agent(self, task, session, model):
        role = task["name"]
        if self.fail and role == "Database":
            session.complete("failed")
            raise GeminiError("Provider fixture timeout")
        retries = 0
        if not self.no_mutation:
            for _ in range(3):
                source = "api/types.ts" if role == "Frontend" else "schema.sql"
                text = session.observe_resource(source)["content"]
                if role == "Database":
                    output, content = "schema.sql", text.replace("INTEGER", "UUID")
                elif role == "Backend":
                    output, content = "api/types.ts", "// produced by test provider\nexport interface User { id: " + ("string" if "UUID" in text else "number") + "; }\n"
                else:
                    output, content = "frontend/client.ts", "// produced by test provider\n" + text
                result = session.write_resource(output, content)
                if not result.get("rejected"):
                    break
                retries += 1
                session = session.retry()
        session.complete()
        return {"attemptId": session.attempt_id, "retries": retries, "summary": "Unit-test provider fixture"}

    def analyze(self, evidence, model):
        if self.semantic_fail:
            raise GeminiError("Semantic fixture timeout")
        return {"analyzer": "test-fixture", "relevance": "POSSIBLE", "reason": "Unit-test annotation", "affectedElements": []}


class LiveDemoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = RuntimeProcess(Path(self.temp.name) / "runtime").__enter__()
        self.manager = LiveDemo(self.runtime.url, Path(self.temp.name) / "controller", lambda: ProviderFixture())

    def tearDown(self):
        self.manager.close()
        self.runtime.__exit__()
        self.temp.cleanup()

    def wait(self, run):
        limit = time.monotonic() + 15
        while time.monotonic() < limit:
            status = self.manager.status(run)
            if status["phase"] in ("completed", "failed"):
                return status
            threading.Event().wait(.01)
        self.fail("Controller did not finish")

    def test_controlled_real_intent_and_repair_history(self):
        run = self.manager.start({})["runId"]
        self.assertEqual(self.wait(run)["phase"], "completed")
        before = self.manager.client.snapshot(run)
        self.assertEqual(before["activeAffectedCount"], 2)
        events = self.manager.client.events(run)
        held = next(e for e in events if e["kind"] == "WRITE_INTENT")
        writes = [e for e in events if e["kind"] == "WRITE_COMMIT"]
        self.assertLess(held["runtimeSeq"], writes[0]["runtimeSeq"])
        self.assertNotEqual(held["attemptId"], writes[0]["attemptId"])
        self.assertEqual(held["attemptId"], writes[1]["attemptId"])
        self.manager.repair(run, before["hazards"][0]["id"])
        status = self.wait(run)
        self.assertEqual(status["phase"], "completed", status)
        self.assertEqual(status["repairs"][-1]["status"], "clean")
        after = self.manager.client.snapshot(run)
        self.assertEqual(after["activeAffectedCount"], 0)
        self.assertEqual(len(after["hazards"]), 1)
        self.assertEqual(sum(before["heads"][p] != after["heads"][p] for p in FILES), 2)
        recovered = LiveDemo(self.runtime.url, self.manager.directory, lambda: ProviderFixture())
        self.assertEqual(recovered.status(run)["repairs"][-1]["status"], "clean")
        recovered.close()

    def test_guard_retries_fresh_attempt(self):
        run = self.manager.start({"mode": "guard"})["runId"]
        self.assertEqual(self.wait(run)["phase"], "completed")
        snap = self.manager.client.snapshot(run)
        self.assertEqual(snap["guard"]["rejectedWrites"], 1)
        self.assertEqual(snap["guard"]["retries"], 1)
        self.assertEqual(snap["activeAffectedCount"], 0)

    def test_fresh_runs_and_natural_mode(self):
        first = self.manager.start({"scheduler": "natural"})["runId"]
        self.assertEqual(self.wait(first)["phase"], "completed")
        second = self.manager.start({"scheduler": "natural"})["runId"]
        self.assertEqual(self.wait(second)["phase"], "completed")
        self.assertNotEqual(first, second)
        self.assertEqual(len(self.manager.client.request("/runs")), 2)
        self.assertNotIn("intentId", self.manager.status(first))

    def test_no_mutation_is_truthful_and_does_not_deadlock(self):
        self.manager.factory = lambda: ProviderFixture(no_mutation=True)
        run = self.manager.start({})["runId"]
        status = self.wait(run)
        self.assertEqual(status["phase"], "completed")
        self.assertEqual(status["hazardCount"], 0)
        self.assertEqual(len(status["warnings"]), 3)

    def test_provider_failure_releases_real_pending_mutation(self):
        self.manager.factory = lambda: ProviderFixture(fail=True)
        run = self.manager.start({})["runId"]
        status = self.wait(run)
        self.assertEqual(status["phase"], "failed")
        self.assertIn("timeout", status["error"])
        self.assertEqual(self.manager.client.snapshot(run)["run"]["status"], "completed")

    def test_semantic_failure_preserves_trace(self):
        self.manager.factory = lambda: ProviderFixture(semantic_fail=True)
        run = self.manager.start({})["runId"]
        status = self.wait(run)
        self.assertEqual(status["phase"], "completed")
        self.assertIn("Semantic analysis failed", status["warnings"][0])
        self.assertEqual(status["activeAffectedCount"], 2)

    def test_configuration_rejected_before_run_creation(self):
        for config in ({"scheduler": "sleep"}, {"files": {}}, {"prompts": {"Backend": "one"}}):
            with self.assertRaises(ValueError):
                self.manager.start(config)
        self.assertEqual(self.manager.client.request("/runs"), [])

    def test_failed_repair_keeps_original_hazard_inspectable(self):
        run = self.manager.start({})["runId"]
        self.wait(run)
        before = self.manager.client.snapshot(run)
        class FailedRepair(ProviderFixture):
            def run_agent(self, task, session, model):
                session.complete("failed")
                raise GeminiError("Repair provider timed out")
        self.manager.factory = FailedRepair
        self.manager.repair(run, before["hazards"][0]["id"])
        status = self.wait(run)
        self.assertEqual(status["repairs"][-1]["status"], "failed")
        self.assertEqual(self.manager.client.snapshot(run)["heads"], before["heads"])
        self.assertEqual(self.manager.client.snapshot(run)["activeAffectedCount"], 2)
        self.assertEqual(self.manager.inspect(run)["attempts"][-1]["status"], "failed")
