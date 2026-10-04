"""Scheduler tests use a named fixture provider against genuine Go runtime events."""
import tempfile
import threading
import time
import unittest
import json
import os
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from ravel.client import RuntimeErrorResponse

from ravel.live_demo import LiveDemo
from ravel.process import RuntimeProcess
from ravel.live_demo_server import make_server


class LabFixture:
    def run_agent(self, task, session, model):
        source, target, transform = task["prompt"].splitlines()[0].split("|")
        retries = 0
        for _ in range(3):
            value = session.observe_resource(source)["content"]
            output = value.replace("INTEGER", "UUID") if transform == "uuid" else "// fixture output\n" + value
            result = session.write_resource(target, output)
            if not result.get("rejected"):
                break
            retries += 1
            session = session.retry()
        session.complete()
        return {"attemptId": session.attempt_id, "retries": retries, "summary": "Offline scheduler fixture"}

    def analyze(self, evidence, model):
        return {"analyzer": "test-fixture", "relevance": "POSSIBLE", "reason": "Offline scheduler annotation", "affectedElements": []}


class LiveLabTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.runtime = RuntimeProcess(Path(self.temp.name) / "runtime").__enter__()
        self.manager = LiveDemo(self.runtime.url, Path(self.temp.name) / "controller", LabFixture)
        self.config = {"scheduler": "interactive", "files": {"schema.sql": "id INTEGER", "types.ts": "initial", "client.ts": "initial"}, "agents": [
            {"id": "reader", "name": "Contract Builder", "task": "schema.sql|types.ts|copy"},
            {"id": "writer", "name": "Migration Author", "task": "schema.sql|schema.sql|uuid"},
            {"id": "consumer", "name": "Client Builder", "task": "types.ts|client.ts|copy"},
        ]}

    def tearDown(self):
        self.manager.close()
        self.runtime.__exit__()
        self.temp.cleanup()

    def wait_for(self, run, predicate):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            record = self.manager.status(run)
            if predicate(record):
                return record
            threading.Event().wait(.01)
        self.fail("Scheduler failed to reach expected state: " + str(self.manager.status(run)))

    def wait_agent(self, run, key, state):
        return self.wait_for(run, lambda r: r["agents"][key]["state"] == state)

    def race(self, mode="observe"):
        run = self.manager.start({**self.config, "mode": mode})["runId"]
        self.manager.control(run, "reader", "hold")
        self.manager.control(run, "reader", "start")
        self.wait_agent(run, "reader", "held")
        self.manager.control(run, "writer", "start")
        self.wait_agent(run, "writer", "done")
        self.manager.control(run, "reader", "release")
        self.wait_agent(run, "reader", "done")
        self.manager.control(run, "consumer", "start")
        self.wait_agent(run, "consumer", "done")
        self.manager.finish(run)
        self.wait_for(run, lambda r: r["phase"] in ("completed", "failed"))
        return run

    def test_generic_hold_release_discovers_stale_lineage_and_repairs(self):
        run = self.race()
        before = self.manager.client.snapshot(run)
        self.assertEqual(before["activeAffectedCount"], 2)
        events = self.manager.client.events(run)
        intent = next(e for e in events if e["kind"] == "WRITE_INTENT")
        commits = [e for e in events if e["kind"] == "WRITE_COMMIT"]
        self.assertLess(intent["runtimeSeq"], commits[0]["runtimeSeq"])
        self.assertEqual(intent["attemptId"], commits[1]["attemptId"])
        inspected = self.manager.inspect(run)
        self.assertEqual(inspected["agents"]["reader"]["observed"][0]["path"], "schema.sql")
        self.assertTrue(inspected["agents"]["reader"]["observed"][0]["versionId"])
        self.manager.repair(run, before["hazards"][0]["id"])
        repaired = self.wait_for(run, lambda r: r["phase"] in ("completed", "failed"))
        self.assertEqual(repaired["repairs"][-1]["status"], "clean", repaired)
        after = self.manager.client.snapshot(run)
        self.assertEqual(after["activeAffectedCount"], 0)
        self.assertEqual(len(after["hazards"]), len(before["hazards"]))
        self.assertNotEqual(before["heads"]["types.ts"], after["heads"]["types.ts"])

    def test_generic_guard_uses_fresh_observations(self):
        run = self.race("guard")
        snap = self.manager.client.snapshot(run)
        self.assertEqual(snap["guard"]["rejectedWrites"], 1)
        self.assertEqual(snap["guard"]["retries"], 1)
        self.assertEqual(snap["activeAffectedCount"], 0)
        self.assertEqual(self.manager.status(run)["agents"]["reader"]["attempt"], 2)
        extras = self.manager.inspect(run)["timelineExtras"]
        reject = next(marker for marker in extras if marker["action"] == "GUARD REJECT")
        self.assertIn("schema.sql@1 → @2", reject["description"])
        self.assertIsNone(reject["versionId"])
        self.assertTrue(any(marker["action"] == "RETRY" for marker in extras))

    def test_repair_identical_downstream_and_blocked_self_read(self):
        class RegenerationFixture(LabFixture):
            def run_agent(provider, task, session, model):
                if task["name"] != "Client Builder":
                    return super().run_agent(task, session, model)
                if session.identity.get("repairOf"):
                    try:
                        session.observe_resource("client.ts")
                    except RuntimeErrorResponse as error:
                        if error.status != 400:
                            raise
                    else:
                        raise AssertionError("Affected self-read must be rejected")
                session.observe_resource("types.ts")
                session.write_resource("client.ts", "// identical client generated against the observed contract")
                session.complete()
                return {"attemptId": session.attempt_id, "summary": "Regeneration regression fixture"}
        self.manager.factory = RegenerationFixture
        run = self.race()
        before = self.manager.client.snapshot(run)
        self.manager.repair(run, before["hazards"][0]["id"])
        result = self.wait_for(run, lambda r:r["phase"] in ("completed", "failed"))
        self.assertEqual(result["repairs"][-1]["status"], "clean", result)
        after = self.manager.client.snapshot(run)
        self.assertEqual(after["activeAffectedCount"], 0)
        self.assertEqual(len(after["hazards"]), 1)
        old = self.manager.client.request("/versions/" + before["heads"]["client.ts"] + "/content")
        new = self.manager.client.request("/versions/" + after["heads"]["client.ts"] + "/content")
        self.assertEqual(old["contentHash"], new["contentHash"])
        self.assertNotEqual(old["id"], new["id"])
        plan = result["repairs"][-1]["plan"]
        self.assertEqual([step["agentKey"] for step in plan], ["reader", "consumer"])
        events = self.manager.client.events(run)
        attempts = [e["payload"]["attempt"] for e in events if e["kind"] == "TASK_ATTEMPT_START" and e["payload"]["attempt"].get("repairOf")]
        self.assertEqual(len(attempts), 2)
        self.assertTrue(all(not a["frontier"] and not a["observedVersions"] for a in attempts))
        observations = [e["payload"]["observation"] for e in events if e["kind"] == "OBSERVE_RESOURCE" and e["attemptId"] == new["producerAttemptId"]]
        self.assertEqual([o["versionId"] for o in observations], [after["heads"]["types.ts"]])

    def test_repair_attempt_history_survives_incomplete_failed_and_rejected_work(self):
        manager = self.manager
        class HistoryFixture(LabFixture):
            repair_round = 0
            def run_agent(provider, task, session, model):
                source, target, transform = task["prompt"].splitlines()[0].split("|")
                repair = session.identity.get("repairOf")
                if repair and task["name"] == "Contract Builder":
                    HistoryFixture.repair_round += 1
                if repair and HistoryFixture.repair_round == 1:
                    session.complete()
                    return {"attemptId": session.attempt_id, "summary": "Explicit incomplete fixture: no output"}
                if repair and HistoryFixture.repair_round == 2:
                    raise RuntimeError("Explicit failed regeneration fixture")
                if transform == "uuid":
                    return super().run_agent(task, session, model)
                if repair and task["name"] == "Contract Builder":
                    # The HTTP failure must stay visible without contaminating observations.
                    with self.assertRaises(RuntimeErrorResponse):
                        session.observe_resource(target)
                    session.observe_resource(source)
                    intent = session.write_intent(target, "constant output")
                    writer = manager.status(session.run_id)["agents"]["writer"]
                    mutation = manager.client.create_attempt(session.run_id, writer["agentId"], task_id=writer["taskId"])
                    mutation.write_resource(source, "id UUID -- newer contract")
                    mutation.complete()
                    rejected = session.commit_write(intent["id"])
                    self.assertTrue(rejected["rejected"])
                    session = session.retry()
                    self.assertEqual(session.identity["repairOf"], repair)
                session.observe_resource(source)
                session.write_resource(target, "constant output")
                session.complete()
                return {"attemptId": session.attempt_id, "summary": "Identical immutable regeneration fixture"}

        self.manager.factory = HistoryFixture
        run = self.race()
        before = self.manager.client.snapshot(run)
        self.assertEqual(before["activeAffectedCount"], 2)
        hazard = before["hazards"][0]["id"]
        for expected in ("incomplete", "failed", "clean"):
            self.manager.repair(run, hazard)
            record = self.wait_for(run, lambda r: r["phase"] in ("completed", "failed"))
            self.assertEqual(record["repairs"][-1]["status"], expected, record)
        after = self.manager.client.snapshot(run)
        inspected = self.manager.inspect(run)
        events = self.manager.client.events(run)
        self.assertEqual(after["activeAffectedCount"], 0)
        self.assertEqual([r["status"] for r in inspected["repairs"]], ["incomplete", "failed", "clean"])
        self.assertTrue(any(a["repairOf"] and a["status"] == "failed" for a in inspected["attempts"]))
        self.assertTrue(any(a["repairOf"] and a["status"] == "invalidated" for a in inspected["attempts"]))
        self.assertTrue(inspected["operationErrors"])
        self.assertTrue(inspected["resultHistory"])
        self.assertEqual(len(after["hazards"]), len(before["hazards"]))
        for path in ("types.ts", "client.ts"):
            old = self.manager.client.request("/versions/" + before["heads"][path] + "/content")
            new = self.manager.client.request("/versions/" + after["heads"][path] + "/content")
            self.assertNotEqual(old["id"], new["id"])
            self.assertEqual(old["contentHash"], new["contentHash"])
        # Optional capture for frontend contract/render regression tests, from real Go facts.
        capture = os.getenv("RAVEL_REPAIR_TRACE_CAPTURE")
        if capture:
            Path(capture).write_text(json.dumps({"provider": "offline HistoryFixture", "events": events, "before": before, "snapshot": after, "controller": inspected}, indent=2), encoding="utf-8")

    def test_pause_after_observation_happens_before_intent(self):
        run = self.manager.start(self.config)["runId"]
        self.manager.control(run, "reader", "pause-after-observation")
        self.manager.control(run, "reader", "start")
        self.wait_agent(run, "reader", "paused")
        events = self.manager.client.events(run)
        self.assertTrue(any(e["kind"] == "OBSERVE_RESOURCE" for e in events))
        self.assertFalse(any(e["kind"] == "WRITE_INTENT" for e in events))
        with self.assertRaises(ValueError):
            self.manager.finish(run)
        with self.assertRaises(ValueError):
            self.manager.control(run, "reader", "start")
        self.manager.control(run, "reader", "resume")
        self.wait_agent(run, "reader", "done")
        self.manager.finish(run)
        self.wait_for(run, lambda r: r["phase"] == "completed")

    def test_queued_task_edit_and_retry_preserve_history(self):
        manager = self.manager
        class AttemptBoundaryFixture(LabFixture):
            def run_agent(provider, task, session, model):
                if session.identity["number"] > 1:
                    current = manager.inspect(session.run_id)
                    agent = current["agents"]["reader"]
                    self.assertEqual(agent["attemptId"], session.attempt_id)
                    self.assertEqual(agent["observed"], [])
                    self.assertEqual(agent["produced"], [])
                    self.assertNotIn("reader", current["results"])
                    self.assertTrue(current["resultHistory"])
                return super().run_agent(task, session, model)
        self.manager.factory = AttemptBoundaryFixture
        run = self.manager.start(self.config)["runId"]
        self.manager.control(run, "reader", "start", {"task": "types.ts|custom/output.ts|copy"})
        self.wait_agent(run, "reader", "done")
        first = self.manager.status(run)["agents"]["reader"]["attemptId"]
        self.manager.control(run, "reader", "retry")
        self.wait_agent(run, "reader", "done")
        self.assertNotEqual(first, self.manager.status(run)["agents"]["reader"]["attemptId"])
        self.assertIn("custom/output.ts", self.manager.client.snapshot(run)["heads"])
        self.manager.finish(run)
        self.wait_for(run, lambda r: r["phase"] == "completed")

    def test_natural_six_arbitrary_agents_finish_without_schedule(self):
        agents = [{"id": f"worker-{i}", "name": f"Unrelated task {i}", "task": f"config.json|out/{i}.txt|copy"} for i in range(6)]
        run = self.manager.start({"scheduler": "natural", "agents": agents, "files": {"config.json": '{"pageSize":20}'}})["runId"]
        record = self.wait_for(run, lambda r: r["phase"] == "completed")
        self.assertEqual(len(record["results"]), 6)
        self.assertEqual(record["hazardCount"], 0)
        snap = self.manager.client.snapshot(run)
        self.assertEqual(len(snap["heads"]), 7)
        self.assertEqual(sum(e["kind"] == "WRITE_INTENT" for e in self.manager.client.events(run)), 6)
        with self.assertRaises(ValueError):
            self.manager.control(run, "worker-0", "pause")

    def test_invalid_configuration_creates_no_runtime_events(self):
        invalid = [
            {**self.config, "agents": self.config["agents"][:1]},
            {**self.config, "agents": self.config["agents"] * 3},
            {**self.config, "agents": [self.config["agents"][0]] * 2},
            {**self.config, "files": {"../escape": "content"}},
            {**self.config, "files": {"C:/escape": "content"}},
            {**self.config, "scheduler": "controlled"},
        ]
        for config in invalid:
            with self.assertRaises(ValueError):
                self.manager.start(config)
        self.assertEqual(self.manager.client.request("/runs"), [])

    def test_controller_shutdown_does_not_release_held_write(self):
        run = self.manager.start(self.config)["runId"]
        self.manager.control(run, "reader", "hold")
        self.manager.control(run, "reader", "start")
        self.wait_agent(run, "reader", "held")
        before = self.manager.client.snapshot(run)["heads"]
        self.manager.close()
        self.assertEqual(self.manager.client.snapshot(run)["heads"], before)
        self.assertFalse(any(e["kind"] == "WRITE_COMMIT" for e in self.manager.client.events(run)))

    def test_interactive_recovery_preserves_trace_without_restart(self):
        run = self.manager.start(self.config)["runId"]
        recovered = LiveDemo(self.runtime.url, self.manager.directory, LabFixture)
        try:
            self.assertEqual(recovered.status(run)["phase"], "interrupted")
            with self.assertRaises(ValueError):
                recovered.control(run, "reader", "start")
        finally:
            recovered.close()

    def test_http_individual_start_hold_release_and_origin_boundary(self):
        server = make_server(self.manager, 0)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        def call(path, data=None, origin=None):
            request = Request(f"http://127.0.0.1:{server.server_port}" + path,
                              data=json.dumps(data).encode() if data is not None else None,
                              headers={"Content-Type": "application/json", **({"Origin": origin} if origin else {})})
            with urlopen(request, timeout=3) as response:
                return json.load(response)
        try:
            with self.assertRaises(HTTPError) as denied:
                call("/runs", self.config, "https://untrusted.invalid")
            self.assertEqual(denied.exception.code, 403)
            run = call("/runs", self.config)["runId"]
            self.assertTrue(call(f"/runs/{run}/agents/reader/hold", {})["accepted"])
            self.assertTrue(call(f"/runs/{run}/agents/reader/start", {})["accepted"])
            self.wait_agent(run, "reader", "held")
            status = call(f"/runs/{run}")
            self.assertTrue(status["agents"]["reader"]["pending"]["intentId"])
            self.assertEqual(status["agents"]["reader"]["observed"][0]["path"], "schema.sql")
            self.assertTrue(call(f"/runs/{run}/agents/reader/release", {})["accepted"])
            self.wait_agent(run, "reader", "done")
            call(f"/runs/{run}/finish", {})
            self.wait_for(run, lambda r: r["phase"] == "completed")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

    def test_pause_after_search_records_only_real_search_observations(self):
        class SearchFixture(LabFixture):
            def run_agent(self, task, session, model):
                if task["name"] != "Contract Builder":
                    return super().run_agent(task, session, model)
                matches = session.search_repository("INTEGER")
                session.write_resource("search-result.txt", "\n".join(match["text"] for match in matches))
                session.complete()
                return {"attemptId": session.attempt_id, "summary": "Offline search fixture"}
        self.manager.factory = SearchFixture
        run = self.manager.start(self.config)["runId"]
        self.manager.control(run, "reader", "pause-after-observation")
        self.manager.control(run, "reader", "start")
        self.wait_agent(run, "reader", "paused")
        inspected = self.manager.inspect(run)
        self.assertEqual([o["path"] for o in inspected["agents"]["reader"]["observed"]], ["schema.sql"])
        self.assertTrue(any(marker["action"] == "OBSERVE" and marker["resourceId"] == "schema.sql" for marker in inspected["timelineExtras"]))
        self.manager.control(run, "writer", "start")
        self.wait_agent(run, "writer", "done")
        self.manager.control(run, "reader", "resume")
        self.wait_agent(run, "reader", "done")
        self.manager.finish(run)
        self.wait_for(run, lambda r: r["phase"] == "completed")
        snap = self.manager.client.snapshot(run)
        self.assertEqual(len(snap["hazards"]), 1)
        self.assertEqual(snap["hazards"][0]["observed"]["resourceId"], "schema.sql")

    def test_no_mutation_and_provider_failure_remain_truthful(self):
        class NoMutation(LabFixture):
            def run_agent(self, task, session, model):
                session.complete()
                return {"attemptId": session.attempt_id, "summary": "Offline no-op fixture"}
        self.manager.factory = NoMutation
        run = self.manager.start({**self.config, "scheduler": "natural"})["runId"]
        record = self.wait_for(run, lambda r: r["phase"] == "completed")
        self.assertEqual(len(record["warnings"]), 3)
        self.assertEqual(record["hazardCount"], 0)
        class Failure(LabFixture):
            def run_agent(self, task, session, model):
                raise RuntimeError("Offline provider failure")
        self.manager.factory = Failure
        run = self.manager.start({**self.config, "scheduler": "natural"})["runId"]
        record = self.wait_for(run, lambda r: r["phase"] == "failed")
        self.assertIn("provider failure", record["error"])
        self.assertTrue(all(attempt["status"] == "failed" for attempt in self.manager.inspect(run)["attempts"]))
        self.assertFalse(any(e["kind"] == "WRITE_COMMIT" for e in self.manager.client.events(run)))
