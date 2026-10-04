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

    def test_registration_compat_preserves_errors_and_validates_post(self):
        from agentverse_sdk._common import av
        from requests import HTTPError, Response
        from ravel.agentverse_compat import enable_first_registration
        def error(code, detail):
            response = Response()
            response.status_code = code
            response._content = json.dumps({"detail": detail}).encode()
            return HTTPError(response=response)
        get = Mock(side_effect=error(404, "Agent not found"))
        post = Mock(side_effect=error(404, "Agent not found"))
        with patch.object(av, "_get_stored_listing_sync", get), patch.object(av, "_post_data_sync", post):
            enable_first_registration()
            self.assertIsNone(av._get_stored_listing_sync().name)
            with self.assertRaisesRegex(RuntimeError, "HTTP 404: Agent not found"):
                av._post_data_sync()
            get.side_effect = error(401, "Not authenticated")
            with self.assertRaises(HTTPError):
                av._get_stored_listing_sync()
            post.side_effect = error(500, "SECRET NOT SAFE TO PRINT")
            with self.assertRaisesRegex(RuntimeError, "HTTP 500: Registration rejected"):
                av._post_data_sync()


if __name__ == "__main__":
    unittest.main()
