"""Live Gemini scheduling and repair. All repository semantics belong to Go."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import threading

from .client import Client
from .gemini import GeminiRESTTransport, Limits, TOOLS, DEFAULT_MODEL, semantic_input, model_name
from .repair import repair_plan, REPAIR_INSTRUCTIONS

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
        self.lab_workers = ThreadPoolExecutor(max_workers=6)
        self.lab_controls = {}
        self.closing = False
        for path in self.directory.glob("*.json"):
            value = json.loads(path.read_text(encoding="utf-8"))
            if value["phase"] in ("running", "held", "repairing", "assessing", "ready"):
                value.update(phase="interrupted", error="Controller stopped. The durable Ravel trace remains available.")
                for agent in value.get("agents", {}).values():
                    if agent.get("state") not in ("done", "failed"):
                        agent["state"] = "interrupted"
            self.records[value["runId"]] = value

    def save(self, record):
        path = self.directory / (record["runId"] + ".json")
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(record, indent=2), encoding="utf-8")
        # Windows scanners can briefly hold the closed file during replacement.
        # This retries controller persistence only; it never schedules runtime work.
        for retry in range(10):
            try:
                temp.replace(path)
                break
            except PermissionError:
                if retry == 9:
                    raise
                threading.Event().wait(.02)

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
        names = {data["agentId"]: data.get("name", role) for role, data in record["agents"].items()}
        events = self.client.events(run)
        for event in events:
            if event["kind"] == "TASK_ATTEMPT_START":
                value = event["payload"]["attempt"]
                attempts[value["id"]] = {"id": value["id"], "role": names.get(value["agentId"], "Agent"), "number": value["number"], "status": value["status"]}
            elif event["kind"] == "TASK_ATTEMPT_END" and event["attemptId"] in attempts:
                attempts[event["attemptId"]]["status"] = event["payload"]["status"]
        record["attempts"] = list(attempts.values())
        if record.get("generic"):
            snapshot = self.client.snapshot(run)
            nodes = {node["id"]: node for node in snapshot["graph"]["nodes"]}
            from .live_lab import trace_extras
            record["timelineExtras"] = trace_extras(record, events, nodes)
            for agent in record["agents"].values():
                with self.lock:
                    control = self.lab_controls.get((run, agent["id"]))
                    if control:
                        agent["scheduling"] = {key: control[key] for key in ("paused", "pauseAfter", "hold")}
                observed = []
                for event in events:
                    if event["attemptId"] != agent.get("attemptId"):
                        continue
                    payload = event["payload"]
                    observations = payload.get("observations", [])
                    if event["kind"] == "OBSERVE_RESOURCE":
                        observations = [payload["observation"]]
                    for observation in observations:
                        node = nodes.get(observation["versionId"])
                        if node:
                            observed.append({"path": node["resourceId"], "versionId": node["id"], "generation": node["generation"], "at": event["wallTime"]})
                agent["observed"] = observed
                agent["activeHazards"] = sum(h["active"] and h["observingAgentId"] == agent["agentId"] for h in snapshot["hazards"])
        return record

    def start(self, config):
        if not isinstance(config, dict):
            raise ValueError("Expected live-run configuration")
        if "agents" in config or config.get("scheduler") == "interactive":
            from .live_lab import start_lab
            return start_lab(self, config)
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
            if any(r["phase"] in ("running", "held", "repairing", "assessing", "ready") for r in self.records.values()):
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
        if record.get("generic"):
            from .live_lab import run_agent
            return run_agent(self, run, role, repair=repair)
        transport = self.factory()
        if repair:
            prior = record["agents"][role]
            session = self.client.create_attempt(run, prior["agentId"], task_id=repair["taskId"],
                                                 repair_of=repair["sourceAttemptId"])
        else:
            identity = self.client.create_agent(run, role, "gemini/" + record["model"])
            session = self.client.create_attempt(run, identity, role + " live task", record["prompts"][role])
            with self.lock:
                self.records[run]["agents"][role] = {"agentId": identity, "taskId": session.identity["taskId"], "attemptId": session.attempt_id}
                self.save(self.records[run])
        try:
            prompt = repair["prompt"] + REPAIR_INSTRUCTIONS if repair else record["prompts"][role]
            # Regeneration uses task provenance, not deterministic role ownership.
            result = transport.run_agent({"name": role, "prompt": prompt},
                                         session if repair else MediatedSession(session, role, gate), record["model"])
            events = self.client.events(run)
            writes = sum(e["kind"] == "WRITE_COMMIT" and e["attemptId"] == result["attemptId"] for e in events)
            result["committedWrites"] = writes
            with self.lock:
                if not writes and not repair:
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
            plan = repair_plan(before, self.client.events(run), self.status(run)["agents"])
            result["plan"] = plan
            self.client.request(f"/runs/{run}/resume", {})
            try:
                for step in plan:
                    result["attempts"].append(self.agent(run, step["agentKey"], repair=step)["attemptId"])
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
        with self.lock:
            self.closing = True
            for control in self.lab_controls.values():
                control["cancelled"] = True
                control["condition"].notify_all()
            for run, record in self.records.items():
                if record.get("generic") and record["phase"] in ("ready", "running", "assessing", "repairing"):
                    self.update(run, phase="interrupted", error="Controller stopped. The durable Ravel trace remains available.")
        self.lab_workers.shutdown(wait=True)
        for gate in list(self.gates.values()):
            gate["release"].set()
        self.jobs.shutdown(wait=True)

    def control(self, run, agent, action, data=None):
        from .live_lab import control_agent
        return control_agent(self, run, agent, action, data or {})

    def finish(self, run):
        from .live_lab import finish_lab
        return finish_lab(self, run)
