"""Live Gemini scheduling and repair. All repository semantics belong to Go."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import threading

from .client import Client
from .gemini import GeminiRESTTransport, Limits, TOOLS, DEFAULT_MODEL, semantic_input, model_name

FILES = {
    "schema.sql": "CREATE TABLE users (\n  id INTEGER PRIMARY KEY,\n  email TEXT NOT NULL\n);\n",
    "api/types.ts": "// Complete this interface from schema.sql.\nexport interface User {\n  id: number;\n}\n",
    "frontend/client.ts": "// Implement userUrl(id: User['id']): string using ../api/types.\n",
}
PROMPTS = {
    "Database": "Observe schema.sql, then change User.id from INTEGER to UUID in schema.sql using write_resource. Finish after the write succeeds; no verification reread is needed.",
    "Backend": "Observe schema.sql and generate the complete api/types.ts to match it. Export interface User including all columns. Use write_resource, then finish after the write succeeds.",
    "Frontend": "Observe api/types.ts and generate frontend/client.ts to match it. Import User and export function userUrl(id: User['id']): string. Use write_resource, then finish after the write succeeds.",
}
OUTPUTS = dict(zip(PROMPTS, FILES))


def safe_error(error):
    message = str(error)
    for name in ("GEMINI_API_KEY", "AGENTVERSE_AGENT_URI", "ASI_ONE_API_KEY"):
        secret = os.getenv(name)
        if secret:
            message = message.replace(secret, "[redacted]")
    return message[:1500]


class MediatedSession:
    def __init__(self, session, role, gate=None):
        self.session, self.role, self.gate = session, role, gate

    def __getattr__(self, key):
        return getattr(self.session, key)

    def write_resource(self, path, content):
        if path != OUTPUTS[self.role]:
            return {"error": f"This task owns {OUTPUTS[self.role]}; other agents own the other files."}
        if self.gate and not self.gate["captured"]:
            intent = self.session.write_intent(path, content)
            self.gate["captured"] = True
            self.gate["status"]("held", intentId=intent["id"])
            self.gate["pending"].set()
            # Synchronization is entirely event-driven. Timeouts only bound failure.
            self.gate["release"].wait()
            self.gate["status"]("running")
            return self.session.commit_write(intent["id"])
        return self.session.write_resource(path, content)

    def retry(self):
        return MediatedSession(self.session.retry(), self.role)


class LiveDemo:
    def __init__(self, url, directory, factory=None):
        self.client = Client(url)
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.factory = factory or (lambda: GeminiRESTTransport(limits=Limits(max_calls=12, max_retries=2),
                                     tools=[t for t in TOOLS if t["name"] != "apply_patch"]))
        self.lock = threading.RLock()
        self.records = {}
        self.gates = {}
        self.jobs = ThreadPoolExecutor(max_workers=2)
        for path in self.directory.glob("*.json"):
            value = json.loads(path.read_text(encoding="utf-8"))
            if value["phase"] in ("running", "held", "repairing", "assessing"):
                value.update(phase="interrupted", error="Controller stopped. The durable Ravel trace remains available.")
            self.records[value["runId"]] = value

    def save(self, record):
        path = self.directory / (record["runId"] + ".json")
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(record, indent=2), encoding="utf-8")
        temp.replace(path)

    def update(self, run, **values):
        with self.lock:
            self.records[run].update(values)
            self.save(self.records[run])

    def status(self, run):
        with self.lock:
            return deepcopy(self.records.get(run, {"runId": run, "phase": "unmanaged", "canRepair": False}))

    def inspect(self, run):
        record = self.status(run)
        if record["phase"] == "unmanaged":
            return record
        attempts = {}
        names = {data["agentId"]: role for role, data in record["agents"].items()}
        for event in self.client.events(run):
            if event["kind"] == "TASK_ATTEMPT_START":
                value = event["payload"]["attempt"]
                attempts[value["id"]] = {"id": value["id"], "role": names.get(value["agentId"], "Agent"), "number": value["number"], "status": value["status"]}
            elif event["kind"] == "TASK_ATTEMPT_END" and event["attemptId"] in attempts:
                attempts[event["attemptId"]]["status"] = event["payload"]["status"]
        record["attempts"] = list(attempts.values())
        return record

    def start(self, config):
        if not isinstance(config, dict):
            raise ValueError("Expected live-run configuration")
        scheduler = config.get("scheduler", "controlled")
        mode = config.get("mode", "observe")
        prompts, files = config.get("prompts", PROMPTS), config.get("files", FILES)
        if scheduler not in ("natural", "controlled") or mode not in ("observe", "guard"):
            raise ValueError("Invalid scheduler or runtime mode")
        for value, template in ((prompts, PROMPTS), (files, FILES)):
            if not isinstance(value, dict) or set(value) != set(template) or any(not isinstance(v, str) or not v.strip() or len(v) > 20000 for v in value.values()):
                raise ValueError("Provide all three bounded, nonempty prompts/files")
        self.factory()  # Fail before creating a run if Gemini is unconfigured.
        agent_model = model_name(os.getenv("RAVEL_AGENT_MODEL", "").strip() or DEFAULT_MODEL)
        semantic_model = model_name(os.getenv("RAVEL_SEMANTIC_MODEL", "").strip() or DEFAULT_MODEL)
        with self.lock:
            if any(r["phase"] in ("running", "held", "repairing", "assessing") for r in self.records.values()):
                raise ValueError("A live run is already active")
            run = self.client.create_run(config.get("name", "Live Gemini run")[:120], mode, files)
            record = {"runId": run, "phase": "running", "scheduler": scheduler, "mode": mode,
                      "prompts": deepcopy(prompts), "files": deepcopy(files), "agents": {}, "results": {},
                      "error": None, "warnings": [], "canRepair": False, "repairs": [],
                      "model": agent_model, "semanticModel": semantic_model}
            self.records[run] = record
            self.save(record)
            self.jobs.submit(self.execute, run)
            return {"runId": run}

    def agent(self, run, role, gate=None, repair=False):
        record = self.status(run)
        transport = self.factory()
        if repair:
            prior = record["agents"][role]
            session = self.client.create_attempt(run, prior["agentId"], task_id=prior["taskId"])
        else:
            identity = self.client.create_agent(run, role, "gemini/" + record["model"])
            session = self.client.create_attempt(run, identity, role + " live task", record["prompts"][role])
            with self.lock:
                self.records[run]["agents"][role] = {"agentId": identity, "taskId": session.identity["taskId"], "attemptId": session.attempt_id}
                self.save(self.records[run])
        try:
            result = transport.run_agent({"name": role, "prompt": record["prompts"][role]}, MediatedSession(session, role, gate), record["model"])
            events = self.client.events(run)
            writes = sum(e["kind"] == "WRITE_COMMIT" and e["attemptId"] == result["attemptId"] for e in events)
            result["committedWrites"] = writes
            with self.lock:
                if not writes:
                    self.records[run]["warnings"].append(role + " produced no committed mutation.")
                self.records[run]["results"][role] = result
                self.save(self.records[run])
            return result
        finally:
            if gate:
                gate["pending"].set()  # Failure/no mutation must unblock the scheduler.

    def execute(self, run):
        gate = {"pending": threading.Event(), "release": threading.Event(), "captured": False,
                "status": lambda phase, **kw: self.update(run, phase=phase, **kw)}
        self.gates[run] = gate
        errors = []
        try:
            with ThreadPoolExecutor(max_workers=3) as workers:
                if self.status(run)["scheduler"] == "natural":
                    futures = [workers.submit(self.agent, run, role) for role in PROMPTS]
                else:
                    backend = workers.submit(self.agent, run, "Backend", gate)
                    backend.add_done_callback(lambda _: gate["pending"].set())
                    gate["pending"].wait()
                    try:
                        self.agent(run, "Database")
                    except Exception as error:
                        errors.append(safe_error(error))
                    finally:
                        gate["release"].set()
                    try:
                        backend.result()
                    except Exception as error:
                        errors.append(safe_error(error))
                    futures = [workers.submit(self.agent, run, "Frontend")]
                for future in futures:
                    try:
                        future.result()
                    except Exception as error:
                        errors.append(safe_error(error))
            self.client.end(run)
            self.assess(run)
            snap = self.client.snapshot(run)
            self.update(run, phase="failed" if errors else "completed", error="; ".join(errors) or None,
                        canRepair=snap["activeAffectedCount"] > 0,
                        activeAffectedCount=snap["activeAffectedCount"], hazardCount=len(snap["hazards"]))
        except Exception as error:
            self.update(run, phase="failed", error=safe_error(error))
        finally:
            gate["release"].set()
            self.gates.pop(run, None)

    def assess(self, run):
        self.update(run, phase="assessing")
        for hazard in self.client.snapshot(run)["hazards"]:
            try:
                transport = self.factory()
                result = transport.analyze(semantic_input(self.client, hazard["id"]), self.status(run)["semanticModel"])
                self.client.assess(hazard["id"], result)
            except Exception as error:
                with self.lock:
                    self.records[run]["warnings"].append("Semantic analysis failed: " + safe_error(error))
                    self.save(self.records[run])

    def repair(self, run, hazard_id):
        with self.lock:
            record = self.status(run)
            if record["phase"] not in ("completed", "failed"):
                raise ValueError("Repair requires a finished live run")
            hazard = self.client.hazard(hazard_id)
            if hazard["runId"] != run or not hazard["active"]:
                raise ValueError("Select an active hazard belonging to this run")
            self.update(run, phase="repairing", canRepair=False, error=None)
            self.jobs.submit(self.repair_work, run, hazard_id)
        return {"repairing": True}

    def analyze(self, run):
        with self.lock:
            if self.status(run)["phase"] not in ("completed", "failed"):
                raise ValueError("Analysis requires a finished live run")
            self.update(run, phase="assessing")
            def work():
                try:
                    self.assess(run)
                    self.update(run, phase="completed")
                except Exception as error:
                    self.update(run, phase="failed", error=safe_error(error))
            self.jobs.submit(work)
        return {"analyzing": True}

    def repair_work(self, run, hazard_id):
        result = {"hazardId": hazard_id, "status": "failed", "attempts": [], "replacements": []}
        final = {"phase": "failed", "canRepair": False}
        try:
            before = self.client.snapshot(run)
            # Order supported affected tasks by their actual provenance edges.
            affected = set(v for h in before["hazards"] if h["active"] for v in h["activeBlastRadius"])
            versions = {v: self.client.request("/versions/" + v + "/content") for v in affected}
            starts = {e["attemptId"]: e["payload"]["attempt"] for e in self.client.events(run) if e["kind"] == "TASK_ATTEMPT_START"}
            version_tasks = {v: starts[data["producerAttemptId"]]["taskId"] for v, data in versions.items() if data["producerAttemptId"] in starts}
            tasks = set(version_tasks.values())
            record = self.status(run)
            task_roles = {data["taskId"]: role for role, data in record["agents"].items()}
            if tasks - set(task_roles):
                raise ValueError("Affected lineage includes a task outside this live demo")
            dependencies = {task: set() for task in tasks}
            for edge in before["graph"]["edges"]:
                source, target = version_tasks.get(edge["source"]), version_tasks.get(edge["target"])
                if edge["kind"] == "DERIVED_FROM" and source and target and source != target:
                    dependencies[target].add(source)
            roles = []
            while dependencies:
                ready = sorted(task for task, parents in dependencies.items() if not parents)
                if not ready:
                    raise ValueError("Affected tasks have cyclic dependencies; automatic repair is unsupported")
                for task in ready:
                    roles.append(task_roles[task])
                    del dependencies[task]
                    for parents in dependencies.values():
                        parents.discard(task)
            if not roles:
                raise ValueError("No supported affected live task found")
            self.client.request(f"/runs/{run}/resume", {})
            try:
                for role in roles:
                    result["attempts"].append(self.agent(run, role, repair=True)["attemptId"])
            finally:
                self.client.end(run)
            self.assess(run)
            after = self.client.snapshot(run)
            result["replacements"] = [{"resourceId": p, "before": old, "after": after["heads"].get(p)} for p, old in before["heads"].items() if after["heads"].get(p) != old]
            result["activeAffectedCount"] = after["activeAffectedCount"]
            result["status"] = "clean" if after["activeAffectedCount"] == 0 and result["replacements"] else "incomplete"
            final = dict(phase="completed", canRepair=after["activeAffectedCount"] > 0, activeAffectedCount=after["activeAffectedCount"], error=None if result["status"] == "clean" else "Repair did not produce a verified clean replacement lineage.")
        except Exception as error:
            result["error"] = safe_error(error)
            final = dict(phase="failed", error="Repair failed: " + safe_error(error), canRepair=True)
        finally:
            with self.lock:
                self.records[run]["repairs"].append(result)
                self.records[run].update(final)
                self.save(self.records[run])

    def close(self):
        for gate in list(self.gates.values()):
            gate["release"].set()
        self.jobs.shutdown(wait=True)
