"""Generic model-driven agents; scheduling never decides runtime correctness."""
from copy import deepcopy
from datetime import datetime, timezone
import os
import re
import threading

from .gemini import DEFAULT_MODEL, model_name
from .live_demo import FILES, safe_error

LAB_FILES = {
    **FILES,
    "backend/model.ts": "export interface User { id: number; email: string; }\n",
    "backend/api.ts": "import { User } from './model';\nexport function getUser(id: number): User { return { id, email: 'demo@example.com' }; }\n",
    "backend/serialization.ts": "import { User } from './model';\nexport function serialize(user: User) { return JSON.stringify(user); }\n",
    "frontend/types.ts": "export interface User { id: number; email: string; }\n",
    "tests/api.test.ts": "// Contract: getUser returns a user with id and email.\n",
    "migration.sql": "-- User migration changes go here.\n",
    "config.json": '{"features":{"userProfiles":true},"pagination":{"pageSize":20}}\n',
}
LAB_AGENTS = [
    {"id": "backend", "name": "Backend Agent", "task": "Inspect the repository and complete the backend user model and API to match the current schema. Choose the files you need to read and write. Finish after publishing your changes."},
    {"id": "database", "name": "Database Agent", "task": "Add account_status with active and suspended values to the user schema and migration. Inspect relevant files and publish the changes."},
    {"id": "frontend", "name": "Frontend Agent", "task": "Inspect the backend user contract and implement the frontend types and client to match it. Choose the files you need and publish your changes."},
]


def now():
    return datetime.now(timezone.utc).isoformat()


def valid_text(value, limit=20000):
    return isinstance(value, str) and bool(value.strip()) and len(value) <= limit


def start_lab(manager, config):
    scheduler, mode = config.get("scheduler", "natural"), config.get("mode", "observe")
    agents, files = config.get("agents", LAB_AGENTS), config.get("files", LAB_FILES)
    if scheduler not in ("natural", "interactive") or mode not in ("observe", "guard"):
        raise ValueError("Generic agents require Natural or Interactive scheduling")
    if not isinstance(agents, list) or not 2 <= len(agents) <= 6:
        raise ValueError("Provide two to six agents")
    ids = set()
    for agent in agents:
        if not isinstance(agent, dict) or not isinstance(agent.get("id"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", agent["id"]):
            raise ValueError("Agent IDs must be short letters, digits, underscores or hyphens")
        if agent["id"] in ids or not valid_text(agent.get("name"), 80) or not valid_text(agent.get("task")):
            raise ValueError("Provide unique IDs and nonempty agent names/tasks")
        ids.add(agent["id"])
    if not isinstance(files, dict) or not 1 <= len(files) <= 40 or any(
        not valid_text(path, 240) or path.startswith(("/", "\\")) or ":" in path or "\\" in path
        or any(part in ("", ".", "..") for part in path.split("/"))
        or not isinstance(content, str) or len(content) > 20000 for path, content in files.items()
    ):
        raise ValueError("Provide bounded relative repository paths and file contents")
    goal = config.get("goal", "")
    if not isinstance(goal, str) or len(goal) > 20000:
        raise ValueError("Goal must be bounded text")
    name = config.get("name", "")
    if not isinstance(name, str) or len(name) > 120:
        raise ValueError("Run name must be bounded text")
    manager.factory()
    model = model_name(os.getenv("RAVEL_AGENT_MODEL", "").strip() or DEFAULT_MODEL)
    semantic_model = model_name(os.getenv("RAVEL_SEMANTIC_MODEL", "").strip() or DEFAULT_MODEL)
    with manager.lock:
        if manager.closing:
            raise ValueError("Controller is stopping")
        if any(r["phase"] in ("running", "held", "repairing", "assessing", "ready") for r in manager.records.values()):
            raise ValueError("A live run is already active")
        run = manager.client.create_run((name or goal or "Live Lab")[:120], mode, files)
        record = {"runId": run, "generic": True, "phase": "ready", "scheduler": scheduler,
                  "mode": mode, "goal": goal, "files": deepcopy(files), "prompts": {}, "agents": {},
                  "results": {}, "warnings": [], "repairs": [], "error": None, "canRepair": False,
                  "model": model, "semanticModel": semantic_model}
        manager.records[run] = record
        for agent in agents:
            key = agent["id"]
            identity = manager.client.create_agent(run, agent["name"], "gemini/" + model)
            record["agents"][key] = {"id": key, "name": agent["name"], "task": agent["task"],
                "agentId": identity, "state": "queued", "attempt": 0, "observed": [], "pending": None,
                "createdAt": now(), "updatedAt": now()}
            record["prompts"][key] = agent["task"]
            manager.lab_controls[(run, key)] = new_control(manager)
        manager.save(record)
        if scheduler == "natural":
            # Reserve every worker before submitting any: early completion cannot end the run.
            for key in record["agents"]:
                record["agents"][key]["state"] = "running"
            record["phase"] = "running"
            manager.save(record)
            for key in record["agents"]:
                manager.lab_workers.submit(worker, manager, run, key)
        return {"runId": run}


def new_control(manager):
    return {"condition": threading.Condition(manager.lock), "paused": False,
            "pauseAfter": False, "hold": False, "cancelled": False}


def agent_update(manager, run, key, **values):
    with manager.lock:
        manager.records[run]["agents"][key].update(updatedAt=now(), **values)
        manager.save(manager.records[run])


class ScheduledSession:
    def __init__(self, manager, run, key, session):
        self.manager, self.run, self.key, self.session = manager, run, key, session

    def __getattr__(self, name):
        return getattr(self.session, name)

    def checkpoint(self):
        manager = self.manager
        with manager.lock:
            control = manager.lab_controls[(self.run, self.key)]
            while control["paused"] and not control["cancelled"]:
                agent_update(manager, self.run, self.key, state="paused")
                control["condition"].wait()
            if control["cancelled"]:
                raise RuntimeError("Controller stopped; pending work was not published")
            agent_update(manager, self.run, self.key, state="reasoning")

    def observe_resource(self, path):
        self.checkpoint()
        agent_update(self.manager, self.run, self.key, state="observing")
        result = self.session.observe_resource(path)
        with self.manager.lock:
            agent = self.manager.records[self.run]["agents"][self.key]
            version = result["version"]
            agent["observed"].append({"path": path, "versionId": version["id"], "generation": version["generation"], "at": now()})
            control = self.manager.lab_controls[(self.run, self.key)]
            if control["pauseAfter"]:
                control["pauseAfter"] = False
                control["paused"] = True
            agent_update(self.manager, self.run, self.key, state="reasoning")
        self.checkpoint()
        return result

    def list_resources(self):
        self.checkpoint()
        return self.session.list_resources()

    def search_repository(self, query):
        self.checkpoint()
        result = self.session.search_repository(query)
        with self.manager.lock:
            control = self.manager.lab_controls[(self.run, self.key)]
            if result and control["pauseAfter"]:
                control["pauseAfter"] = False
                control["paused"] = True
        self.checkpoint()
        return result

    def write_resource(self, path, content):
        self.checkpoint()
        intent = self.session.write_intent(path, content)
        manager = self.manager
        with manager.lock:
            control = manager.lab_controls[(self.run, self.key)]
            agent_update(manager, self.run, self.key, state="pending commit", pending={"path": path, "intentId": intent["id"]})
            while (control["hold"] or control["paused"]) and not control["cancelled"]:
                agent_update(manager, self.run, self.key, state="held")
                control["condition"].wait()
            if control["cancelled"]:
                raise RuntimeError("Controller stopped; pending write intent retained without publication")
        result = self.session.commit_write(intent["id"])
        agent_update(manager, self.run, self.key, state="rejected" if result.get("rejected") else "committed", pending=None)
        return result

    def complete(self, status="completed"):
        if status == "completed":
            self.checkpoint()
        return self.session.complete(status)

    def retry(self):
        session = self.session.retry()
        agent_update(self.manager, self.run, self.key, state="retrying", attemptId=session.attempt_id,
                     attempt=session.identity["number"], observed=[], pending=None)
        return ScheduledSession(self.manager, self.run, self.key, session)


def run_agent(manager, run, key, repair=False):
    if manager.closing:
        raise RuntimeError("Controller is stopping; no new attempt was started")
    if repair:
        with manager.lock:
            manager.lab_controls[(run, key)] = new_control(manager)
    record = manager.status(run)
    prior = record["agents"][key]
    session = manager.client.create_attempt(run, prior["agentId"], prior["name"] + " task",
                                          record["prompts"][key], task_id=prior.get("taskId"))
    if repair:
        with manager.lock:
            manager.records[run].setdefault("repairAttemptIds", []).append(session.attempt_id)
    agent_update(manager, run, key, state="running", taskId=session.identity["taskId"],
                 attemptId=session.attempt_id, attempt=session.identity["number"], observed=[], pending=None, startedAt=now(), error=None)
    try:
        result = manager.factory().run_agent({"name": prior["name"], "prompt": record["prompts"][key]},
                                           ScheduledSession(manager, run, key, session), record["model"])
    except Exception:
        try:
            session.complete("failed")
        except Exception:
            pass  # Pending or already-ended work remains exactly as Go recorded it.
        raise
    result["committedWrites"] = sum(e["kind"] == "WRITE_COMMIT" and e["agentId"] == prior["agentId"]
                                    and e["attemptId"] == result["attemptId"] for e in manager.client.events(run))
    with manager.lock:
        manager.records[run]["results"][key] = result
        if not result["committedWrites"]:
            manager.records[run]["warnings"].append(prior["name"] + " produced no committed mutation.")
        agent_update(manager, run, key, state="done", completedAt=now())
    return result


def worker(manager, run, key):
    try:
        run_agent(manager, run, key)
    except Exception as error:
        agent_update(manager, run, key, state="failed", error=safe_error(error), pending=None, completedAt=now())
    finally:
        with manager.lock:
            record = manager.records[run]
            if not manager.closing and record["scheduler"] == "natural" and all(a["state"] in ("done", "failed") for a in record["agents"].values()):
                finish_lab(manager, run)


def control_agent(manager, run, key, action, data):
    with manager.lock:
        if manager.closing:
            raise ValueError("Controller is stopping")
        record = manager.records.get(run)
        if not record or not record.get("generic") or record["scheduler"] != "interactive" or record["phase"] not in ("ready", "running"):
            raise ValueError("Controls require an active Interactive Live Lab")
        if key not in record["agents"]:
            raise ValueError("Unknown agent ID")
        agent = record["agents"][key]
        control = manager.lab_controls[(run, key)]
        if action in ("start", "retry"):
            expected = ("queued",) if action == "start" else ("done", "failed")
            if agent["state"] not in expected:
                raise ValueError("Agent is not ready for this action")
            if action == "start" and "task" in data:
                if not valid_text(data["task"]):
                    raise ValueError("Provide a bounded nonempty task")
                agent["task"] = record["prompts"][key] = data["task"]
            if action == "retry":
                manager.lab_controls[(run, key)] = new_control(manager)
            agent_update(manager, run, key, state="running")
            record["phase"] = "running"
            manager.save(record)
            manager.lab_workers.submit(worker, manager, run, key)
        elif action in ("pause", "resume", "pause-after-observation", "hold", "release"):
            if agent["state"] in ("done", "failed", "interrupted"):
                raise ValueError("Agent has finished; retry to schedule new work")
            if action == "pause":
                control["paused"] = True
            elif action == "resume":
                control["paused"] = False
                control["pauseAfter"] = False
            elif action == "pause-after-observation":
                control["pauseAfter"] = True
            elif action == "hold":
                control["hold"] = True
            elif action == "release":
                control["hold"] = False
            agent_update(manager, run, key, scheduling={k: control[k] for k in ("paused", "pauseAfter", "hold")})
            control["condition"].notify_all()
        else:
            raise ValueError("Unknown scheduling action")
        return {"accepted": True}


def finish_lab(manager, run):
    with manager.lock:
        record = manager.records.get(run)
        if not record or not record.get("generic") or record["phase"] not in ("ready", "running"):
            raise ValueError("Run cannot be finished in its current phase")
        if any(a["state"] not in ("queued", "done", "failed") for a in record["agents"].values()):
            raise ValueError("Wait for running agents or release held work before finishing")
        manager.update(run, phase="assessing")
        manager.jobs.submit(finalize, manager, run)
        return {"finishing": True}


def finalize(manager, run):
    try:
        manager.client.end(run)
        manager.assess(run)
        snap = manager.client.snapshot(run)
        errors = [a["error"] for a in manager.status(run)["agents"].values() if a.get("error")]
        manager.update(run, phase="failed" if errors else "completed", error="; ".join(errors) or None,
                       canRepair=snap["activeAffectedCount"] > 0, activeAffectedCount=snap["activeAffectedCount"], hazardCount=len(snap["hazards"]))
    except Exception as error:
        manager.update(run, phase="failed", error=safe_error(error))


def trace_extras(record, events, nodes):
    """Additional timeline markers projected from Go facts, never runtime events."""
    result, observations, intents, heads = [], {}, {}, {}
    names = {agent["agentId"]: agent["name"] for agent in record["agents"].values()}
    repairs = set(record.get("repairAttemptIds", []))
    def marker(event, action, description, version=None, suffix="", state="CLEAN", resource=None):
        node = nodes.get(version, {})
        result.append({"id": event["id"] + suffix, "runtimeSeq": event["runtimeSeq"],
                       "agentId": event["agentId"], "agentName": names.get(event["agentId"], "Agent"),
                       "action": action, "description": description, "versionId": version,
                       "resourceId": resource or node.get("resourceId"), "state": state, "hazardIds": []})
    for event in events:
        payload = event["payload"]
        name = names.get(event["agentId"], "Agent")
        if "version" in payload:
            version = payload["version"]
            heads[version["resourceId"]] = version["id"]
        for observation in payload.get("observations", []) + ([payload["observation"]] if "observation" in payload else []):
            observations[observation["id"]] = observation["versionId"]
        if event["kind"] == "WRITE_INTENT":
            intents[payload["id"]] = payload
        elif event["kind"] == "SEARCH_RESULT":
            for observation in payload.get("observations", []):
                node = nodes.get(observation["versionId"])
                if node:
                    marker(event, "OBSERVE", f'{name} observed {node["resourceId"]}@{node["generation"]} through search', node["id"], ":" + observation["id"])
        elif event["kind"] == "WRITE_REJECTED":
            intent = intents.get(payload["intentId"], {})
            differences = []
            for identity in payload.get("staleObservationIds", []):
                old = nodes.get(observations.get(identity), {})
                current = nodes.get(heads.get(old.get("resourceId")), {})
                if old and current:
                    differences.append(f'{old["resourceId"]}@{old["generation"]} → @{current["generation"]}')
            marker(event, "GUARD REJECT", f'{name}: Guard rejected {intent.get("resourceId", "candidate")} · ' + "; ".join(differences), state="STALE_INPUT", resource=intent.get("resourceId"))
        elif event["kind"] == "TASK_ATTEMPT_START" and payload["attempt"]["number"] > 1:
            attempt = payload["attempt"]
            action = "REPAIR" if attempt["id"] in repairs else "RETRY"
            marker(event, action, f'{name} started {action.lower()} attempt #{attempt["number"]}')
    return result
