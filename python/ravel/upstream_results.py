"""Allowlisted native results; invalid attempts never enter comparison rows."""

import json
import hashlib
from pathlib import Path


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


def summarize(directory):
    bundle = read_json(directory / "run_bundle.json")
    artifact_issues = []
    inventory = bundle.get("artifacts", {})
    if not inventory:
        artifact_issues.append("missing_artifact_inventory")
    for name, expected in inventory.items():
        path = (directory / name).resolve()
        if not path.is_relative_to(directory.resolve()) or not path.is_file():
            artifact_issues.append(f"missing_or_external_artifact:{name}")
            continue
        data = path.read_bytes()
        if len(data) != expected.get("bytes") or hashlib.sha256(data).hexdigest() != expected.get("sha256"):
            artifact_issues.append(f"artifact_checksum_mismatch:{name}")
    cost = read_json(directory / "cost.json").get("total", {})
    dependencies = read_json(directory / "strict_dependency_metrics.json")
    process = read_json(directory / "process_metrics_summary.json")
    eligibility = bundle.get("eligibility", {})
    admitted = (
        bundle.get("status") == "valid"
        and bundle.get("instrumentation", {}).get("valid") is True
        and eligibility.get("official_aggregate") is True
        and not artifact_issues
    )
    return {
        "artifact_directory": directory.name,
        "task": bundle.get("task_id"),
        "protocol": bundle.get("protocol"),
        "release": bundle.get("release"),
        "status": bundle.get("status"),
        "admitted": admitted,
        "local_artifact_issues": artifact_issues,
        "hard_failures": bundle.get("instrumentation", {}).get("hard_failures", []),
        "provenance": {key: bundle.get("provenance", {}).get(key) for key in (
            "benchmark_revision", "sdk_revision", "model", "subagent_model",
        )},
        "budgets": bundle.get("execution_profile", {}).get("observed", {}),
        "native": {
            "final_test": bundle.get("final_test"),
            "adpr": dependencies.get("final_integrated_ADPR"),
            "strict_drs": dependencies.get("strict_DRS"),
            "normalized_drs": process.get("formal_metrics", {}).get("DRS_score", {}).get("value"),
            "dependencies": dependencies.get("dependency_metrics", []),
            "checkpoint_count": dependencies.get("checkpoint_count"),
            "wall_seconds": cost.get("wall_clock_duration"),
            "agent_seconds": cost.get("duration"),
            "input_tokens": cost.get("prompt_tokens"),
            "output_tokens": cost.get("completion_tokens"),
            "total_tokens": cost.get("total_tokens"),
            "reported_cost_usd": cost.get("cost"),
        },
        "ravel": None,
    }


def export(root):
    root = Path(root)
    attempts = [summarize(path.parent) for path in sorted(root.glob("native-*/run_bundle.json"))]
    result = {
        "schema_version": 1,
        "benchmark": "AsynCodeBench",
        "scope": "local task subset; not a full benchmark score",
        "notes": [
            "Comparison rows require upstream valid instrumentation, official aggregate eligibility, and matching artifact checksums.",
            "Invalid attempts are retained only as diagnostics.",
            "Null metrics are unavailable; reported cost zero does not establish free API usage.",
            "Ravel adapter and comparison are pending; native and Ravel metrics remain separate.",
        ],
        "comparison": [attempt for attempt in attempts if attempt["admitted"]],
        "excluded_attempts": [attempt for attempt in attempts if not attempt["admitted"]],
    }
    root.mkdir(parents=True, exist_ok=True)
    path = root / "comparison.json"
    path.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {path}")
    print("Protocol           Status       Tests        ADPR     Tokens")
    for attempt in attempts:
        native = attempt["native"]
        test = native["final_test"] or {}
        adpr = (native["adpr"] or {}).get("value")
        print(f'{str(attempt["protocol"]):18} {str(attempt["status"]):12} '
              f'{test.get("passed")}/{test.get("collected")}        {adpr}     {native["total_tokens"]}')
    return 0
