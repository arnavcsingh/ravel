"""Repository commands; no runtime behavior is implemented in this launcher."""

import os
from pathlib import Path
import subprocess
import sys
import time

from ravel.process import BINARY, ROOT, build, go_command


def pnpm(*args):
    # Resolve pnpm's actual JS entry point to avoid shell quoting on Windows.
    entry = os.environ.get("npm_execpath")
    return ["node", entry, *args] if entry else (["pnpm.cmd" if os.name == "nt" else "pnpm", *args])


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "serve"
    args = sys.argv[2:]
    os.chdir(ROOT)
    if action == "benchmark":
        from ravel.benchmark import main as benchmark
        return benchmark(args)
    if action == "upstream":
        from ravel.upstream import main as upstream
        return upstream(args)
    if action == "build":
        build()
        return 0
    if action == "test":
        go_command("test", "./...")
        build()
        environment = {**os.environ, "PYTHONPATH": str(ROOT / "python")}
        subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "python/tests", "-v"], env=environment, check=True)
        subprocess.run(pnpm("test:ui"), check=True)
        return 0
    if action == "test:race":
        os.environ["CGO_ENABLED"] = "1"
        go_command("test", "-race", "./...")
        return 0
    if action in ("serve", "reset", "dev"):
        build()
        command = [str(BINARY), *(["-reset"] if action == "reset" else []), *args]
        if action != "dev":
            return subprocess.call(command)
        # Vite remains the frontend development server, proxying the same API.
        runtime = subprocess.Popen(command)
        frontend = None
        try:
            frontend = subprocess.Popen(["node", str(ROOT / "node_modules/vite/bin/vite.js"), "--config", "apps/web/vite.config.ts", "--configLoader", "runner"])
            while runtime.poll() is None and frontend.poll() is None:
                time.sleep(0.2)
            return runtime.returncode or frontend.returncode or 0
        finally:
            for process in (frontend, runtime):
                if process and process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
    raise ValueError(f"Unknown command: {action}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
