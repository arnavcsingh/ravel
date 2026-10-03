"""Identical synthetic work in OFF, Observe and Guard. Not AsynCodeBench."""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import platform
import statistics
import subprocess
import time

from .client import Client
from .process import ROOT, RuntimeProcess, build

ORIGINAL = {"prefix": "/v1/", "factor": 1}
MIGRATED = {"prefix": "/v2/", "factor": 100}
SCENARIOS = [
    {"id": "overlapping-migration", "changes": [MIGRATED], "stale": True},
    {"id": "factor-only", "changes": [{**ORIGINAL, "factor": 100}], "stale": True},
    {"id": "serial-control", "changes": [MIGRATED], "stale": False, "schedule": "serial"},
    {"id": "identical-write-control", "changes": [ORIGINAL], "stale": False},
    {"id": "aba-control", "changes": [MIGRATED, ORIGINAL], "stale": False},
    {"id": "aba-then-change", "changes": [MIGRATED, ORIGINAL, {"prefix": "/v3/", "factor": 10}], "stale": True},
]
MODES = ("off", "observe", "guard")


def encode(value):
    return json.dumps(value, separators=(",", ":"))


def generate_api(content):
    contract = json.loads(content)
    return f'exports.transform = value => {encode(contract["prefix"])} + String(value * {contract["factor"]});\n'


def check_output(source, symbol, expected):
    # Execute the original JavaScript artifact in Node's time-bounded VM. Never
    # replace this with regex/string matching: it must independently test behavior.
    evaluator = """
const fs = require('node:fs'), vm = require('node:vm');
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
try {
  const result = vm.runInNewContext(p.source + '\\n[0, 2, -3].map(exports.' + p.symbol + ')', {exports:{}}, {timeout:100});
  process.stdout.write(JSON.stringify(result) === JSON.stringify(p.expected) ? 'true' : 'false');
} catch { process.stdout.write('false'); }
"""
    try:
        result = subprocess.run(
            ["node", "-e", evaluator], input=json.dumps({"source": source, "symbol": symbol,
                "expected": [expected["prefix"] + str(n * expected["factor"]) for n in [0, 2, -3]]}),
            capture_output=True, text=True, timeout=5, check=True,
        )
        return result.stdout == "true"
    except (subprocess.SubprocessError, OSError):
        return False


def run_trial(scenario, mode, directory, client=None, repetition=1):
    directory = Path(directory)
    workspace = directory / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    (workspace / "contract.json").write_text(encode(ORIGINAL), encoding="utf-8")
    backend = producer = frontend = None
    calls = generated_bytes = reruns = 0
    run_id = None

    def generate(function, text):
        nonlocal calls, generated_bytes
        result = function(text)
        calls += 1
        generated_bytes += len(result.encode())
        return result

    started = time.perf_counter()
    if mode != "off":
        if client is None:
            raise ValueError("Observe and Guard require a Go runtime client")
        run_id = client.create_run(scenario["id"], mode, {"contract.json": encode(ORIGINAL)})
        backend = client.create_attempt(run_id, client.create_agent(run_id, "Backend"), "Generate API", "Implement the current contract.")
        producer = client.create_attempt(run_id, client.create_agent(run_id, "Producer"), "Migrate contract", "Publish the requested contract changes.")
        frontend = client.create_attempt(run_id, client.create_agent(run_id, "Frontend"), "Generate client", "Implement the API contract.")

    def migrate():
        for contract in scenario["changes"]:
            if producer:
                producer.write_resource("contract.json", encode(contract))
            else:
                (workspace / "contract.json").write_text(encode(contract), encoding="utf-8")
        if producer:
            producer.complete()

    if scenario.get("schedule") == "serial":
        migrate()
    observed = backend.observe_resource("contract.json")["content"] if backend else (workspace / "contract.json").read_text()
    candidate = generate(generate_api, observed)
    intent = backend.write_intent("api.js", candidate) if backend else None
    if scenario.get("schedule") != "serial":
        migrate()
    if intent:
        result = backend.commit_write(intent["id"])
        if result["rejected"]:
            reruns += 1
            backend = backend.retry()
            fresh = backend.observe_resource("contract.json")["content"]
            if backend.write_resource("api.js", generate(generate_api, fresh))["rejected"]:
                raise RuntimeError("Unexpected retry rejection after producer completion")
        backend.complete()
    else:
        (workspace / "api.js").write_text(candidate, encoding="utf-8")
    api = frontend.observe_resource("api.js")["content"] if frontend else (workspace / "api.js").read_text()
    output = generate(lambda text: text.replace("exports.transform", "exports.render"), api)
    if frontend:
        frontend.write_resource("client.js", output)
        frontend.complete()
        client.end(run_id)
    else:
        (workspace / "client.js").write_text(output, encoding="utf-8")
    elapsed = (time.perf_counter() - started) * 1000
    snapshot = client.snapshot(run_id) if run_id else None
    events = client.events(run_id) if run_id else []
    if snapshot:
        # Local benchmark evaluates the actual materialized artifacts too.
        workspace = Path(snapshot["run"]["workspace"])
        (directory / "snapshot.json").write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
        (directory / "events.json").write_text(json.dumps(events, indent=2), encoding="utf-8")
    checks = {name: check_output((workspace / filename).read_text(encoding="utf-8"), symbol, scenario["changes"][-1])
              for name, filename, symbol in [("api", "api.js", "transform"), ("client", "client.js", "render")]}
    return {"scenario": scenario["id"], "mode": mode, "repetition": repetition,
        "success": all(checks.values()), "dependencyChecks": checks,
        "dependencyPassRate": sum(checks.values()) / 2,
        "hazardsDetected": len(snapshot["hazards"]) if snapshot else None,
        "writesRejected": sum(e["kind"] == "WRITE_REJECTED" for e in events),
        "attemptsRerun": reruns, "generationCalls": calls, "generatedBytes": generated_bytes,
        "elapsedMs": elapsed, "runId": run_id, "directory": str(directory)}


def summarize(trials):
    result = []
    for mode in MODES:
        selected = [t for t in trials if t["mode"] == mode]
        count = len(selected)
        row = {"mode": mode, "trials": count,
            "successRate": sum(t["success"] for t in selected) / count if count else 0,
            "dependencyPassRate": sum(t["dependencyPassRate"] for t in selected) / count if count else 0,
            "hazardsDetected": sum(t["hazardsDetected"] or 0 for t in selected) if mode != "off" else None,
            "medianElapsedMs": statistics.median(t["elapsedMs"] for t in selected) if count else 0,
            "recomputedGenerations": sum(max(0, t["generationCalls"] - 2) for t in selected)}
        for key in ("writesRejected", "attemptsRerun", "generationCalls", "generatedBytes"):
            row[key] = sum(t[key] for t in selected)
        result.append(row)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--output", default=str(ROOT / ".ravel" / "benchmarks"))
    args = parser.parse_args(argv)
    if not 1 <= args.repetitions <= 100:
        parser.error("--repetitions must be between 1 and 100")
    directory = Path(args.output).resolve() / datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%f")
    directory.mkdir(parents=True)
    build()
    trials = []
    with RuntimeProcess(directory / "trace") as runtime:
        client = Client(runtime.url)
        for mode in MODES:
            run_trial(SCENARIOS[0], mode, directory / "warmup" / mode, client, 0)
        for repetition in range(1, args.repetitions + 1):
            for index, scenario in enumerate(SCENARIOS):
                for offset in range(3):
                    mode = MODES[(repetition + index + offset) % 3]
                    trials.append(run_trial(scenario, mode, directory / f'{repetition}-{scenario["id"]}-{mode}', client, repetition))
            print(f"Completed repetition {repetition}/{args.repetitions}", flush=True)
    regressions = [t for t in trials if (
        t["success"] != (t["mode"] == "guard" or not next(s for s in SCENARIOS if s["id"] == t["scenario"])["stale"])
        or t["writesRejected"] != int(t["mode"] == "guard" and next(s for s in SCENARIOS if s["id"] == t["scenario"])["stale"])
        or (t["mode"] == "observe" and t["hazardsDetected"] != int(next(s for s in SCENARIOS if s["id"] == t["scenario"])["stale"])))]
    commit = dirty = None
    try:
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        dirty = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip())
    except (OSError, subprocess.CalledProcessError):
        pass
    timing_note = "Includes HTTP, SQLite facts/projections and materialization; excludes process startup, evaluation and fixture setup. Not directly comparable to the old in-process TypeScript timings or model-heavy workloads."
    report = {"schemaVersion": 2, "suite": "ravel-local-synthetic", "officialAsynCodeBench": False,
        "createdAt": datetime.now(timezone.utc).isoformat(), "commit": commit, "workingTreeDirty": dirty,
        "python": platform.python_version(), "platform": platform.system(), "repetitions": args.repetitions,
        "warmupTrialsExcluded": 3, "model": None, "tokens": None, "tokenOverhead": None,
        "timingNote": timing_note, "scenarios": SCENARIOS, "summary": summarize(trials),
        "regressions": regressions, "trials": trials}
    (directory / "report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    rows = [f'| {r["mode"]} | {r["trials"]} | {r["successRate"]:.0%} | {r["dependencyPassRate"]:.0%} | {r["hazardsDetected"] if r["hazardsDetected"] is not None else "unmeasured"} | {r["writesRejected"]} | {r["attemptsRerun"]} | {r["medianElapsedMs"]:.2f} |' for r in report["summary"]]
    markdown = "# Ravel local synthetic benchmark\n\nNot an official AsynCodeBench result. No models or API keys.\n\n| Mode | Trials | Success | Dependency pass | Hazards | Rejections | Retries | Median ms |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n" + "\n".join(rows) + f"\n\n{timing_note}\n\nRegression mismatches: {len(regressions)}. Tokens: not measured.\n"
    (directory / "report.md").write_text(markdown, encoding="utf-8")
    print(markdown + f"\nSaved results and traces: {directory}")
    return int(bool(regressions))
