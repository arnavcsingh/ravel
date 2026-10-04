"""Launch the pinned official harness without changing its tasks or evaluator."""

import argparse
from datetime import datetime, timezone
import os
import re
import subprocess
import sys

from .process import ROOT


def model_environment(source):
    environment = dict(source)
    if not environment.get("LLM_API_KEY"):
        environment["LLM_API_KEY"] = environment.get("GEMINI_API_KEY", "")
        # LiteLLM's native Gemini route carries thought signatures in tool IDs,
        # which survive the pinned SDK's transport-agnostic message conversion.
        environment.setdefault("LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta")
        environment.setdefault("LLM_MODEL", "gemini/gemini-3.5-flash-lite")
    if not all(environment.get(k) for k in ("LLM_API_KEY", "LLM_MODEL", "LLM_BASE_URL")):
        raise ValueError("Set GEMINI_API_KEY, or LLM_API_KEY / LLM_MODEL / LLM_BASE_URL, in .env")
    # Forward values through the process environment, never command-line arguments.
    names = [key for key in environment if key.startswith("LLM_")]
    environment["WSLENV"] = ":".join(filter(None, [environment.get("WSLENV", ""), *names]))
    return environment


def main(args):
    # Redirected Windows consoles otherwise default to cp1252 on output too.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if args == ["results"]:
        from .upstream_results import export
        return export(ROOT / ".ravel" / "benchmark-source")
    action = args[0] if args else "check"
    actions = ("setup", "check", "runner-check", "dry-run", "smoke", "doctor", "run")
    if action not in actions or (len(args) > 1 and action != "run"):
        raise ValueError("Usage: pnpm benchmark:upstream " + "|".join(actions))
    options = []
    environment = os.environ.copy()
    if action in ("run", "doctor"):
        environment = model_environment(environment)
    if action == "run":
        parser = argparse.ArgumentParser(description="Run the unmodified OpenHands benchmark baseline")
        parser.add_argument("--task", default="asyncodebench:cachetools")
        parser.add_argument("--protocol", choices=("single", "serial_specialists", "async_private", "caid_manager", "async_manager"), default="single")
        parser.add_argument("--max-iterations", type=int, default=100)
        parser.add_argument("--sub-iterations", type=int, default=100)
        parser.add_argument("--rounds-of-chat", type=int, default=2)
        parsed = parser.parse_args(args[1:])
        if min(parsed.max_iterations, parsed.sub_iterations, parsed.rounds_of_chat) < 1:
            parser.error("Budgets must be positive")
        for key, value in vars(parsed).items():
            options.extend(["--" + key.replace("_", "-"), str(value)])
    reports = ROOT / ".ravel" / "benchmark-source" / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    log_path = reports / f'{datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%f")}-{action}.log'
    command = ["bash", "benchmarks/asyncodebench.sh", action, *options]
    if os.name == "nt":
        command = ["wsl.exe", *(["-d", os.environ["RAVEL_WSL_DISTRO"]] if os.environ.get("RAVEL_WSL_DISTRO") else []), "--", *command]
    print(f"AsynCodeBench {action}; log: {log_path}", flush=True)
    bundle_directory = None
    with log_path.open("w", encoding="utf-8") as log:
        with subprocess.Popen(command, cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace") as child:
            for line in child.stdout:
                for key in ("LLM_API_KEY", "GEMINI_API_KEY", "AGENTVERSE_AGENT_URI", "ASI_ONE_API_KEY"):
                    if environment.get(key):
                        line = line.replace(environment[key], "[redacted]")
                if line.startswith("[AsynCodeBench] Result bundle: "):
                    name = line.strip().replace("\\", "/").split("/")[-2]
                    if re.fullmatch(r"native-\d{8}T\d{6}", name):
                        bundle_directory = reports.parent / name
                print(line, end="", flush=True)
                log.write(line)
                log.flush()
            code = child.wait()
            if action == "run" and code == 0:
                from .upstream_results import summarize
                if bundle_directory is None or not summarize(bundle_directory)["admitted"]:
                    code = 2
                    message = "Harness finished, but its result is not admitted to the official comparison.\n"
                    print(message, end="", flush=True)
                    log.write(message)
            log.write(f"\nExit: {code}\n")
    return code
