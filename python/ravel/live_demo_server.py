"""Optional loopback controller and supervised one-command live-demo startup."""
import argparse
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import queue
import subprocess
import threading
from urllib.request import urlopen

from .client import Client
from .live_demo import FILES, PROMPTS, LiveDemo, safe_error
from .live_lab import LAB_FILES, LAB_AGENTS
from .process import ROOT, BINARY, build


def make_server(manager, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, code, value):
            data = json.dumps(value).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            try:
                if self.path == "/health":
                    client = Client(manager.client.url.removesuffix("/api"), timeout=3)
                    health = client.request("/health")
                    projection = client.request("/live")
                    inspector = False
                    try:
                        with urlopen("http://127.0.0.1:9999/health", timeout=1) as response:
                            inspector = json.load(response).get("ready", False)
                    except OSError:
                        pass
                    self.send(200, {"api": health["status"] == "ok", "gemini": bool(os.getenv("GEMINI_API_KEY", "").strip()),
                                    "spacetime": projection, "inspector": inspector, "workspace": True,
                                    "files": FILES, "prompts": PROMPTS, "labFiles": LAB_FILES, "labAgents": LAB_AGENTS})
                elif self.path.startswith("/runs/"):
                    self.send(200, manager.inspect(self.path.split("/")[2]))
                else:
                    self.send(404, {"error": "Unknown live-demo endpoint"})
            except Exception as error:
                self.send(503, {"error": safe_error(error)})

        def do_POST(self):
            origin = self.headers.get("Origin")
            api_port = manager.client.url.split(":")[-1].split("/")[0]
            if origin and origin not in (f"http://127.0.0.1:{api_port}", f"http://localhost:{api_port}"):
                self.send(403, {"error": "Cross-origin mutation is not allowed"})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size < 0 or size > 256000:
                    raise ValueError("Invalid request size")
                data = json.loads(self.rfile.read(size) or b"{}")
                if self.path == "/runs":
                    self.send(201, manager.start(data))
                elif self.path.startswith("/runs/") and self.path.endswith("/repair"):
                    self.send(202, manager.repair(self.path.split("/")[2], data["hazardId"]))
                elif self.path.startswith("/runs/") and self.path.endswith("/analyze"):
                    self.send(202, manager.analyze(self.path.split("/")[2]))
                elif self.path.startswith("/runs/") and self.path.endswith("/finish"):
                    self.send(202, manager.finish(self.path.split("/")[2]))
                elif len(self.path.split("/")) == 6 and self.path.split("/")[3] == "agents":
                    parts = self.path.split("/")
                    self.send(202, manager.control(parts[2], parts[4], parts[5], data))
                else:
                    self.send(404, {"error": "Unknown live-demo endpoint"})
            except Exception as error:
                self.send(400, {"error": safe_error(error)})
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def serve(args):
    if not BINARY.exists():
        build()
    manager = LiveDemo(args.url, Path(args.data) / "live-demo")
    controller = make_server(manager, args.controller_port)
    environment = {**os.environ, "RAVEL_DEMO_URL": f"http://127.0.0.1:{controller.server_port}"}
    port = args.url.rsplit(":", 1)[1]
    runtime = subprocess.Popen([str(BINARY), "-port", port, "-data", str(args.data), "-seed=false"],
                               cwd=ROOT, env=environment, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    messages = queue.Queue()
    def drain():
        for line in runtime.stdout:
            print(line, end="", flush=True)
            messages.put(line)
        messages.put(None)
        controller.shutdown()
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    try:
        while True:
            line = messages.get(timeout=30)
            if line is None:
                raise RuntimeError("Go failed to start. Check the port and data-directory lock shown above.")
            if "ready at " in line:
                break
        print(f"Live demo: {args.url} - New Live Run creates a fresh workspace and retains history.", flush=True)
        print("Gemini: " + ("configured" if os.getenv("GEMINI_API_KEY") else "NOT CONFIGURED: set GEMINI_API_KEY in .env"), flush=True)
        print("Inspector is optional; run pnpm inspector separately for Agentverse.", flush=True)
        controller.serve_forever(poll_interval=.2)
    except KeyboardInterrupt:
        pass
    finally:
        controller.server_close()
        manager.close()
        runtime.terminate()
        try:
            runtime.wait(timeout=10)
        except subprocess.TimeoutExpired:
            runtime.kill()
            runtime.wait()
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("serve", "start", "status", "repair", "control", "finish"))
    parser.add_argument("--url", default="http://127.0.0.1:" + os.getenv("PORT", "4317"))
    parser.add_argument("--data", default=os.getenv("RAVEL_DATA_DIR", ".ravel/v3"))
    parser.add_argument("--controller-port", type=int, default=int(os.getenv("RAVEL_DEMO_PORT", "4318")))
    parser.add_argument("--config", type=Path)
    parser.add_argument("--run")
    parser.add_argument("--hazard")
    parser.add_argument("--agent")
    parser.add_argument("--action", choices=("start", "retry", "pause", "resume", "pause-after-observation", "hold", "release"))
    parser.add_argument("--task")
    args = parser.parse_args(argv)
    if args.command == "serve":
        return serve(args)
    client = Client(args.url)
    if args.command == "start":
        result = client.request("/live-demo/runs", json.loads(args.config.read_text()) if args.config else {})
    elif args.command == "repair":
        result = client.request(f"/live-demo/runs/{args.run}/repair", {"hazardId": args.hazard})
    elif args.command == "control":
        if not args.run or not args.agent or not args.action:
            parser.error("control requires --run, --agent, and --action")
        result = client.request(f"/live-demo/runs/{args.run}/agents/{args.agent}/{args.action}", {"task": args.task} if args.task else {})
    elif args.command == "finish":
        if not args.run:
            parser.error("finish requires --run")
        result = client.request(f"/live-demo/runs/{args.run}/finish", {})
    else:
        result = client.request("/live-demo/" + ("runs/" + args.run if args.run else "health"))
    print(json.dumps(result, indent=2))
    return 0
