"""Build and manage the local Go executable without a Python server layer."""

import os
from pathlib import Path
import queue
import shutil
import subprocess
import threading

ROOT = Path(__file__).resolve().parents[2]
BINARY = ROOT / ".ravel" / "bin" / ("ravel.exe" if os.name == "nt" else "ravel")


def go_command(*args):
    local = ROOT / ".ravel" / "tools" / "go" / "bin" / ("go.exe" if os.name == "nt" else "go")
    executable = os.environ.get("RAVEL_GO") or shutil.which("go") or (str(local) if local.exists() else None)
    if not executable:
        raise RuntimeError("Install Go 1.26+ or set RAVEL_GO to the Go executable.")
    environment = os.environ.copy()
    environment.setdefault("GOCACHE", str(ROOT / ".ravel" / "go-cache"))
    environment.setdefault("GOMODCACHE", str(ROOT / ".ravel" / "go-mod"))
    subprocess.run([executable, "-C", str(ROOT / "runtime"), *args], env=environment, check=True)


def build():
    BINARY.parent.mkdir(parents=True, exist_ok=True)
    go_command("build", "-o", str(BINARY), "./cmd/ravel")


class RuntimeProcess:
    def __init__(self, directory, seed=False):
        self.directory, self.seed = Path(directory), seed
        self.process = None
        self.logs = []

    def __enter__(self):
        if not BINARY.exists():
            build()
        self.process = subprocess.Popen(
            [str(BINARY), "-data", str(self.directory), "-port", "0", f"-seed={str(self.seed).lower()}"],
            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        messages = queue.Queue()

        def drain():
            for line in self.process.stdout:
                self.logs.append(line)
                messages.put(line)
            messages.put(None)

        self.reader = threading.Thread(target=drain, daemon=True)
        self.reader.start()
        try:
            while True:
                line = messages.get(timeout=30)
                if line is None:
                    raise RuntimeError("Go runtime exited before becoming ready")
                if "ready at " in line:
                    self.url = line.split("ready at ", 1)[1].strip()
                    return self
                print(line, end="")
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if self.process:
            failed = self.process.poll()
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            self.reader.join(timeout=5)
            self.process.stdout.close()
            self.directory.mkdir(parents=True, exist_ok=True)
            (self.directory / "runtime.log").write_text("".join(self.logs), encoding="utf-8")
            if failed not in (None, 0):
                print("Go process exited:", failed, "".join(self.logs[-30:]))
