"""Pure planner regressions; final live validation uses actual Gemini separately."""
import unittest
from ravel.repair import repair_plan


class RepairPlanTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.agents = {}
        for i, key in enumerate(("z-root", "bridge", "a-leaf")):
            attempt = {"id": "attempt-"+key, "taskId":"task-"+key, "agentId":"agent-"+key}
            self.agents[key] = attempt
            self.events += [{"kind":"TASK_ATTEMPT_START", "attemptId":attempt["id"], "payload":{"attempt":attempt, "task":{"prompt":"immutable task "+key}}},
                            {"kind":"WRITE_COMMIT", "payload":{"version":{"id":key, "resourceId":key+".txt", "producerAttemptId":attempt["id"], "creationSeq":i+1}}}]
        self.snapshot = {"hazards":[{"active":True, "consumerVersionId":"z-root", "historicalBlastRadius":["z-root","bridge","a-leaf"], "activeBlastRadius":["z-root","a-leaf"]}],
                         "graph":{"edges":[{"kind":"DERIVED_FROM","source":"z-root","target":"bridge"}, {"kind":"DERIVED_FROM","source":"bridge","target":"a-leaf"}]}}

    def test_orders_through_historical_non_head_bridge(self):
        plan = repair_plan(self.snapshot, self.events, self.agents)
        self.assertEqual([s["agentKey"] for s in plan], ["z-root","a-leaf"])
        self.assertEqual(plan[0]["sourceAttemptId"], "attempt-z-root")
        self.assertEqual(plan[0]["prompt"], "immutable task z-root")

    def test_includes_stale_root_after_partial_repair(self):
        self.snapshot["hazards"][0]["activeBlastRadius"] = ["a-leaf"]
        self.assertEqual([s["agentKey"] for s in repair_plan(self.snapshot,self.events,self.agents)], ["z-root","a-leaf"])

    def test_unknown_producer_is_reported_not_skipped(self):
        del self.agents["a-leaf"]
        with self.assertRaisesRegex(ValueError, "outside this live controller"):
            repair_plan(self.snapshot,self.events,self.agents)
