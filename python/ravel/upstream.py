"""Port of the existing upstream launcher. The pinned Bash bootstrap is unchanged."""

from datetime import datetime, timezone
import os
import subprocess

from .process import ROOT


def main(args):
    action = args[0] if args else "check"
    if len(args) > 1 or action not in ("setup", "check", "runner-check", "dry-run", "smoke"):
        raise ValueError("Usage: pnpm benchmark:upstream [setup|check|runner-check|dry-run|smoke]")
    reports = ROOT / ".ravel" / "benchmark-source" / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    log_path = reports / f'{datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%f")}-{action}.log'
    command = ["bash", "benchmarks/asyncodebench.sh", action]
    if os.name == "nt":
        command = ["wsl.exe", *(["-d", os.environ["RAVEL_WSL_DISTRO"]] if os.environ.get("RAVEL_WSL_DISTRO") else []), "--", *command]
    print(f"AsynCodeBench {action}; log: {log_path}", flush=True)
    with log_path.open("w", encoding="utf-8") as log:
        with subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True) as child:
            for line in child.stdout:
                print(line, end="", flush=True)
                log.write(line)
            code = child.wait()
            log.write(f"\nExit: {code}\n")
    return code
