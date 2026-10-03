import tempfile
from pathlib import Path
import unittest

from ravel.benchmark import SCENARIOS, MODES, run_trial, summarize, check_output
from ravel.client import Client
from ravel.process import RuntimeProcess


class BenchmarkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="ravel-python-")
        cls.root = Path(cls.temp.name)
        cls.runtime = RuntimeProcess(cls.root / "trace").__enter__()
        cls.client = Client(cls.runtime.url)

    @classmethod
    def tearDownClass(cls):
        cls.runtime.__exit__()
        cls.temp.cleanup()

    def scenario(self, scenario):
        trials = [run_trial(scenario, mode, self.root / scenario["id"] / mode, self.client) for mode in MODES]
        off, observe, guard = trials
        self.assertEqual(off["success"], not scenario["stale"])
        self.assertIsNone(off["hazardsDetected"])
        self.assertEqual(observe["success"], off["success"])
        self.assertEqual(observe["hazardsDetected"], int(scenario["stale"]))
        self.assertTrue(guard["success"])
        self.assertEqual(guard["writesRejected"], int(scenario["stale"]))
        self.assertEqual(guard["attemptsRerun"], int(scenario["stale"]))
        self.assertEqual(guard["generationCalls"], 2 + int(scenario["stale"]))
        self.assertGreater(guard["generatedBytes"], 0)
        self.assertEqual(summarize(trials)[2]["dependencyPassRate"], 1)

    def test_broken_stale_nonterminating(self):
        expected = {"prefix": "/v2/", "factor": 100}
        for source in ['exports.transform = n => "/v1/" + n;', 'throw new Error("broken")', 'exports.transform = () => { while (true) {} };']:
            with self.subTest(source=source):
                self.assertFalse(check_output(source, "transform", expected))


for scenario in SCENARIOS:
    setattr(BenchmarkTests, "test_" + scenario["id"].replace("-", "_"), lambda self, scenario=scenario: self.scenario(scenario))

if __name__ == "__main__":
    unittest.main()
