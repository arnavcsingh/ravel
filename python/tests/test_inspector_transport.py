import importlib.util
import json
import tempfile
import time
import unittest
from unittest.mock import Mock, patch

from ravel.client import Client
from ravel.process import RuntimeProcess

HAS_SDK = importlib.util.find_spec("agentverse_sdk") is not None


@unittest.skipUnless(HAS_SDK, "Install python/requirements-inspector.txt for optional transport tests")
class InspectorTransportTests(unittest.TestCase):
    def test_local_a2a_multiturn_against_real_go(self):
        from starlette.testclient import TestClient
        from ravel.inspector_server import create_app
        with tempfile.TemporaryDirectory() as directory, RuntimeProcess(directory) as runtime:
            api = Client(runtime.url)
            run = api.request("/demo", {"mode": "observe", "interactive": False})["runId"]
            deadline = time.monotonic() + 20
            while api.snapshot(run)["run"]["status"] != "completed":
                self.assertLess(time.monotonic(), deadline)
                time.sleep(.05)
            with TestClient(create_app(runtime.url)) as transport:
                context = None
                for index, prompt in enumerate(("Analyze my latest Ravel run", "Show the blast radius", "Replay the race", "Repair it")):
                    message = {"role": "ROLE_USER", "messageId": f"test-{index}", "parts": [{"text": prompt}]}
                    if context:
                        message["contextId"] = context
                    response = transport.post("/", headers={"A2A-Version": "1.0"}, json={"jsonrpc": "2.0", "id": index, "method": "SendMessage", "params": {"message": message}})
                    payload = response.json()
                    self.assertNotIn("error", payload)
                    reply = payload["result"]["message"]
                    context = reply["contextId"]
                    result = json.loads(reply["parts"][1]["text"].removeprefix("Ravel tool result:\n"))
                    self.assertTrue(result["ok"], result)
                    if index == 1:
                        self.assertEqual(len(result["facts"]["active"]), 2)
                    if index == 2:
                        steps = result["facts"]["steps"]
                        self.assertEqual(len(steps), 5)
                        self.assertEqual([s["runtimeSeq"] for s in steps], sorted(s["runtimeSeq"] for s in steps))
                    if index == 3:
                        self.assertEqual(result["facts"]["status"], "clean")
                        self.assertEqual(len(result["facts"]["replacements"]), 2)
                self.assertFalse(transport.get("/health").json()["ready"])
            final = api.snapshot(run)
            self.assertEqual(final["activeAffectedCount"], 0)
            self.assertEqual(len(final["hazards"]), 1)

    def test_sdk_registration_lookup_and_error_behavior(self):
        from agentverse_sdk._common import av
        from requests import HTTPError, Response
        from uagents_core.config import AgentverseConfig
        def response(code, detail):
            response = Response()
            response.status_code = code
            response._content = json.dumps(detail).encode()
            return response
        config = AgentverseConfig(base_url="agentverse.ai", http_prefix="https")
        request = Mock(address="public-test-address")
        request.model_dump_json.return_value = "{}"
        with patch.object(av.requests, "get", return_value=response(200, {"name": "Existing name", "handle": "existing-handle", "profile": {}})) as get, patch.object(av.requests, "post", return_value=response(200, {})) as post:
            av.register_to_agentverse_sync(request, {}, config)
            self.assertEqual(get.call_args.kwargs["url"], "https://agentverse.ai/v2/agents/public-test-address")
            self.assertEqual(post.call_args.kwargs["url"], "https://agentverse.ai/v2/agents")
            request.model_dump_json.assert_called_with(exclude={"name": True, "handle": True})
            for status in (404, 401, 403, 500):
                get.return_value = response(status, {"detail": "Rejected"})
                post.reset_mock()
                with self.assertRaises(HTTPError):
                    av.register_to_agentverse_sync(request, {}, config)
                post.assert_not_called()
            get.return_value = response(200, {})
            post.return_value = response(500, {"detail": "Rejected"})
            with self.assertRaises(HTTPError):
                av.register_to_agentverse_sync(request, {}, config)


if __name__ == "__main__":
    unittest.main()
