"""Offline contract and actual-Go integration tests. Never uses an API key."""

import io
import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import HTTPError, URLError

from ravel.client import Client
from ravel.gemini import GeminiError, GeminiRESTTransport, Limits, semantic_input
from ravel.process import RuntimeProcess


def tool(name, **args):
    return {"functionCall": {"id": "call-1", "name": name, "args": args},
            "thoughtSignature": "opaque-signature"}


def response(*parts, reason="STOP"):
    return {"candidates": [{"finishReason": reason, "content": {"role": "model", "parts": list(parts)}}],
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15}}


class FakeProvider:
    def __init__(self, *steps):
        self.steps, self.requests = list(steps), []

    def __call__(self, request, timeout):
        self.requests.append(json.loads(request.data))
        step = self.steps.pop(0)
        value = step(self.requests[-1]) if callable(step) else step
        return io.BytesIO(json.dumps(value).encode())


class TransportTests(unittest.TestCase):
    def test_missing_key_and_model_url_rejected(self):
        with self.assertRaisesRegex(GeminiError, "disabled"):
            GeminiRESTTransport(api_key="")
        transport = GeminiRESTTransport(api_key="secret")
        with self.assertRaisesRegex(GeminiError, "identifier"):
            transport.generate("https://untrusted.invalid", {})
        self.assertEqual(transport.calls, 0)

    def test_rest_headers_budget_and_usage(self):
        captured = []

        def provider(request, timeout):
            captured.append((request, timeout))
            return io.BytesIO(json.dumps(response({"text": "ok"})).encode())

        transport = GeminiRESTTransport("secret", Limits(max_calls=1), provider)
        transport.generate("gemini-test", {"contents": []})
        request, timeout = captured[0]
        self.assertEqual(request.full_url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent")
        self.assertEqual(request.get_header("X-goog-api-key"), "secret")
        self.assertNotIn("secret", request.full_url)
        self.assertEqual(timeout, 45)
        self.assertEqual(transport.usage["totalTokens"], 15)
        with self.assertRaisesRegex(GeminiError, "budget"):
            transport.generate("gemini-test", {})
        self.assertEqual(len(captured), 1)

    def test_provider_errors_are_redacted_and_not_retried(self):
        for status in (400, 401, 403, 404, 429, 500):
            calls = []

            def provider(request, timeout):
                calls.append(request)
                raise HTTPError(request.full_url, status, "secret", {}, io.BytesIO(b"secret"))

            with self.subTest(status=status):
                with self.assertRaises(GeminiError) as error:
                    GeminiRESTTransport("secret", opener=provider).generate("gemini-test", {})
                self.assertNotIn("secret", str(error.exception))
                self.assertIn(str(status), str(error.exception))
                self.assertEqual(len(calls), 1)

    def test_context_response_and_network_limits(self):
        transport = GeminiRESTTransport("secret", Limits(max_context_bytes=1024))
        with self.assertRaisesRegex(GeminiError, "context"):
            transport.generate("gemini-test", {"text": "x" * 2048})
        self.assertEqual(transport.calls, 0)
        for body in (b"not json", b"[]", b"x" * 2_000_001):
            with self.assertRaises(GeminiError):
                GeminiRESTTransport("secret", opener=lambda *a, **k: io.BytesIO(body)).generate("gemini-test", {})

        def disconnected(*args, **kwargs):
            raise URLError("secret")

        with self.assertRaisesRegex(GeminiError, "not retried"):
            GeminiRESTTransport("secret", opener=disconnected).generate("gemini-test", {})

    def test_semantic_json_validation(self):
        good = {"relevance": "CONFLICT", "reason": "UUID differs from number", "affectedElements": ["User.id"]}
        provider = FakeProvider(response({"text": json.dumps(good)}))
        transport = GeminiRESTTransport("secret", opener=provider)
        self.assertEqual(transport.analyze({"old": "INTEGER", "new": "UUID"}, "gemini-test"),
                         {"analyzer": "gemini/gemini-test", **good})
        self.assertEqual(provider.requests[0]["generationConfig"]["responseMimeType"], "application/json")
        invalid = ["not JSON", json.dumps({**good, "confidence": 99}), json.dumps({**good, "reason": ""}),
                   json.dumps({**good, "relevance": "CERTAIN"}), json.dumps({**good, "affectedElements": [12]})]
        for text in invalid:
            with self.subTest(text=text), self.assertRaises(GeminiError):
                GeminiRESTTransport("secret", opener=FakeProvider(response({"text": text}))).analyze({}, "gemini-test")


class AgentIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="ravel-gemini-")
        cls.process = RuntimeProcess(Path(cls.temp.name) / "data").__enter__()
        cls.client = Client(cls.process.url)

    @classmethod
    def tearDownClass(cls):
        cls.process.__exit__()
        cls.temp.cleanup()

    def session(self, mode="guard"):
        run = self.client.create_run("Gemini test", mode, {"input.txt": "OLD\n"})
        agent = self.client.create_agent(run, "Gemini", "gemini/test")
        return self.client.create_attempt(run, agent, "Copy input", "Copy input.txt into output.txt")

    def run_agent(self, session, provider, **limits):
        return GeminiRESTTransport("secret", Limits(**limits), provider).run_agent(
            {"name": "Copy input", "prompt": "Copy input.txt into output.txt"}, session, "gemini-test")

    def test_mediated_tools_and_signature_roundtrip(self):
        session = self.session()
        provider = FakeProvider(response(tool("list_resources")), response(tool("search_repository", query="OLD")),
                                response(tool("observe_resource", path="input.txt")),
                                response(tool("write_resource", path="output.txt", content="OLD\n")),
                                response(tool("finish_task", summary="Copied input")))
        result = self.run_agent(session, provider)
        self.assertEqual(result["status"], "completed")
        second = provider.requests[1]["contents"]
        self.assertEqual(second[1]["parts"][0]["thoughtSignature"], "opaque-signature")
        self.assertEqual(second[2]["parts"][0]["functionResponse"]["id"], "call-1")
        events = self.client.events(session.run_id)
        self.assertTrue(any(e["kind"] == "OBSERVE_RESOURCE" for e in events))
        self.assertTrue(any(e["kind"] == "WRITE_COMMIT" for e in events))
        snapshot = self.client.snapshot(session.run_id)
        self.assertGreater(len(snapshot["graph"]["edges"]), 0)
        self.assertEqual((Path(snapshot["run"]["workspace"]) / "output.txt").read_text(), "OLD\n")

    def test_guard_retry_uses_fresh_attempt_and_transcript(self):
        session = self.session()
        producer = self.client.create_attempt(session.run_id, self.client.create_agent(session.run_id, "Producer"), "Migrate", "Change input")

        def change_input(_):
            producer.write_resource("input.txt", "NEW\n")
            producer.complete()
            return response(tool("write_resource", path="output.txt", content="OLD\n"))

        provider = FakeProvider(response(tool("observe_resource", path="input.txt")), change_input,
                                response(tool("observe_resource", path="input.txt")),
                                response(tool("write_resource", path="output.txt", content="NEW\n")),
                                response(tool("finish_task", summary="Copied fresh input")))
        result = self.run_agent(session, provider)
        self.assertEqual(result["retries"], 1)
        self.assertNotEqual(result["attemptId"], session.attempt_id)
        self.assertEqual(len(provider.requests[2]["contents"]), 1)
        self.assertNotIn("OLD", json.dumps(provider.requests[3]))
        snapshot = self.client.snapshot(session.run_id)
        self.assertEqual(snapshot["guard"]["rejectedWrites"], 1)
        self.assertEqual(snapshot["activeAffectedCount"], 0)
        self.assertEqual((Path(snapshot["run"]["workspace"]) / "output.txt").read_text(), "NEW\n")

    def test_observe_detects_stale_write_and_publishes_annotation(self):
        session = self.session("observe")
        producer = self.client.create_attempt(session.run_id, self.client.create_agent(session.run_id, "Producer"), "Migrate", "Change input")

        def change_input(_):
            producer.write_resource("input.txt", "NEW\n")
            producer.complete()
            return response(tool("write_resource", path="output.txt", content="OLD\n"))

        provider = FakeProvider(response(tool("observe_resource", path="input.txt")), change_input,
                                response(tool("finish_task", summary="Copied input")))
        self.run_agent(session, provider)
        snapshot = self.client.snapshot(session.run_id)
        hazard_id = snapshot["hazards"][0]["id"]
        evidence = semantic_input(self.client, hazard_id)
        self.assertEqual(evidence["task"]["prompt"], "Copy input.txt into output.txt")
        self.assertEqual(evidence["observed"]["content"], "OLD\n")
        self.assertEqual(evidence["validationHead"]["content"], "NEW\n")
        analyzer = GeminiRESTTransport("secret", opener=FakeProvider(response({"text": json.dumps({
            "relevance": "CONFLICT", "reason": "The copy contains old input", "affectedElements": ["output.txt"],
        })})))
        detail = self.client.assess(hazard_id, analyzer.analyze(evidence, "gemini-test"))
        self.assertEqual(detail["assessment"]["analyzer"], "gemini/gemini-test")
        self.assertTrue(detail["active"])
        snapshot["latestRuntimeSeq"] += 1
        self.assertEqual(self.client.snapshot(session.run_id, snapshot["currentRuntimeSeq"]), snapshot)

    def test_exact_base_patch_is_mediated(self):
        session = self.session()

        def patch(payload):
            observed = payload["contents"][-1]["parts"][0]["functionResponse"]["response"]["result"]
            return response(tool("apply_patch", path="input.txt", baseVersionId=observed["version"]["id"],
                                 patch="@@ -1 +1 @@\n-OLD\n+NEW\n"))

        provider = FakeProvider(response(tool("observe_resource", path="input.txt")), patch,
                                response(tool("finish_task", summary="Patched input")))
        self.run_agent(session, provider)
        snapshot = self.client.snapshot(session.run_id)
        self.assertEqual((Path(snapshot["run"]["workspace"]) / "input.txt").read_text(), "NEW\n")

    def test_unknown_tools_and_parallel_batches_do_not_execute(self):
        session = self.session()
        provider = FakeProvider(response(tool("run_shell", command="echo unsafe")),
                                response(tool("observe_resource", path="input.txt"), tool("write_resource", path="bad.txt", content="bad")),
                                response(tool("finish_task", summary="No changes")))
        self.run_agent(session, provider)
        events = self.client.events(session.run_id)
        self.assertFalse(any(e["kind"] in ("OBSERVE_RESOURCE", "WRITE_COMMIT", "COMMAND_START") for e in events))
        self.assertIn("No calls", json.dumps(provider.requests[2]))

    def test_budget_exhaustion_and_truncation_fail_attempt(self):
        for provider in (FakeProvider(response(tool("list_resources"))),
                         FakeProvider(response(tool("write_resource", path="bad.txt", content="bad"), reason="MAX_TOKENS"))):
            session = self.session()
            with self.assertRaises(GeminiError):
                self.run_agent(session, provider, max_calls=1)
            events = self.client.events(session.run_id)
            self.assertEqual(events[-1]["kind"], "TASK_ATTEMPT_END")
            self.assertEqual(events[-1]["payload"]["status"], "failed")
            self.assertFalse(any(e["kind"] == "WRITE_COMMIT" for e in events))

    def test_guard_retry_limit_does_not_publish(self):
        session = self.session()
        producer = self.client.create_attempt(session.run_id, self.client.create_agent(session.run_id, "Producer"))

        def migrate(_):
            producer.write_resource("input.txt", "NEW\n")
            producer.complete()
            return response(tool("write_resource", path="output.txt", content="OLD\n"))

        with self.assertRaisesRegex(GeminiError, "retry limit"):
            self.run_agent(session, FakeProvider(response(tool("observe_resource", path="input.txt")), migrate), max_retries=0)
        snapshot = self.client.snapshot(session.run_id)
        workspace = Path(snapshot["run"]["workspace"])
        self.assertFalse((workspace / "output.txt").exists())
        self.assertEqual(snapshot["guard"]["rejectedWrites"], 1)
