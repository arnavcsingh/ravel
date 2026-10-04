"""Deterministic Inspector tools; no provider imports or concurrency decisions."""

import json
import re
from urllib.error import URLError
from urllib.parse import quote

from .client import Client, RuntimeErrorResponse


class InspectorError(RuntimeError):
    pass


class Inspector:
    def __init__(self, client: Client):
        self.client = client

    def get_latest_run(self):
        runs = self.client.request("/runs")
        if not runs:
            raise InspectorError("No Ravel runs exist. Start a Ravel demo, then analyze again.")
        return self.get_run(runs[0]["id"])

    def get_run(self, run_id):
        return self.client.snapshot(run_id)

    def get_hazards(self, run_id):
        return self.get_run(run_id)["hazards"]

    def get_hazard(self, hazard_id):
        return self.client.hazard(hazard_id)

    def get_blast_radius(self, hazard_id):
        hazard = self.get_hazard(hazard_id)
        snapshot = self.get_run(hazard["runId"])
        nodes = {n["id"]: n for n in snapshot["graph"]["nodes"]}
        def artifacts(ids):
            return [{"versionId": identity, "resourceId": nodes[identity]["resourceId"],
                     "generation": nodes[identity]["generation"], "state": nodes[identity]["state"],
                     "currentHead": nodes[identity]["currentHead"]} for identity in ids]
        return {"hazardId": hazard_id, "runId": hazard["runId"],
                "active": artifacts(hazard["activeBlastRadius"]),
                "historical": artifacts(hazard["historicalBlastRadius"])}

    def get_replay(self, hazard_id):
        return self.client.request(f"/hazards/{quote(hazard_id, safe='')}/replay")

    def repair_hazard(self, hazard_id):
        hazard = self.get_hazard(hazard_id)
        before = self.get_run(hazard["runId"])
        if not hazard["active"]:
            return {"status": "already_resolved", "runId": hazard["runId"],
                    "activeAffectedCount": before["activeAffectedCount"], "replacements": []}
        if not before["canRepair"]:
            raise InspectorError("Ravel does not support automatic repair for this run in its current state.")
        # Never retry a mutation automatically: a timeout can have an unknown outcome.
        try:
            result = self.client.request(f"/hazards/{quote(hazard_id, safe='')}/repair", {})
        except (URLError, TimeoutError, OSError) as error:
            raise InspectorError("Repair outcome is unknown because the connection failed. Analyze the run again before retrying.") from error
        after = self.get_run(hazard["runId"])
        updated = self.get_hazard(hazard_id)
        replacements = [{"resourceId": path, "previousVersionId": old,
                         "replacementVersionId": after["heads"].get(path)}
                        for path, old in before["heads"].items() if after["heads"].get(path) != old]
        status = "in_progress" if result.get("repairing") else "incomplete"
        if not updated["active"] and after["activeAffectedCount"] == 0:
            status = "clean"
        return {"status": status, "runId": hazard["runId"],
                "activeAffectedCount": after["activeAffectedCount"], "replacements": replacements,
                "runtimeSeq": after["currentRuntimeSeq"], "hazard": updated}


TOOLS = ("get_latest_run", "get_run", "get_hazards", "get_hazard", "get_blast_radius", "get_replay", "repair_hazard")


class Conversation:
    """One conversation's selection. Explicit tool JSON is also supported by A2A.

    Free text recognizes a deliberately bounded vocabulary. Unrecognized text
    cannot mutate Ravel. Repository content is never interpreted as instructions.
    """
    def __init__(self, inspector):
        self.inspector = inspector
        self.run_id = None
        self.hazard_id = None

    def respond(self, message):
        try:
            tool, args = self._command(message)
            result = getattr(self.inspector, tool)(**args)
            if tool in ("get_latest_run", "get_run"):
                self.run_id = result["run"]["id"]
                hazards = result["hazards"]
                chosen = next((h for h in hazards if h["active"]), hazards[0] if hazards else None)
                self.hazard_id = chosen["id"] if chosen else None
            elif tool == "get_hazard":
                self.hazard_id, self.run_id = result["id"], result["runId"]
            return {"ok": True, "tool": tool, "facts": result, "text": self._describe(tool, result)}
        except RuntimeErrorResponse as error:
            return {"ok": False, "text": f"Ravel API returned HTTP {error.status}: {error}", "error": "ravel_api"}
        except (URLError, TimeoutError, OSError):
            return {"ok": False, "text": "Ravel is unavailable. Check RAVEL_API_BASE and start the Go server.", "error": "unavailable"}
        except (InspectorError, ValueError, TypeError) as error:
            return {"ok": False, "text": str(error), "error": "request"}
        except (KeyError, IndexError):
            return {"ok": False, "text": "Ravel returned an unexpected response; no success can be confirmed.", "error": "invalid_response"}

    def _command(self, message):
        text = message.strip()
        if text.startswith("{"):
            request = json.loads(text)
            tool, args = request.get("tool"), request.get("arguments", {})
            if tool not in TOOLS or not isinstance(args, dict):
                raise InspectorError("Use a documented Inspector tool and an arguments object.")
            return tool, args
        text = re.sub(r"[.!?]+$", "", text.lower()).strip()
        text = re.sub(r"^please\s+", "", text)
        if text in ("analyze my latest ravel run", "analyze my latest run", "analyze latest run", "latest run", "get latest run"):
            return "get_latest_run", {}
        if text in ("get hazards", "show hazards") and self.run_id:
            return "get_hazards", {"run_id": self.run_id}
        intents = {"show the blast radius": "get_blast_radius", "show blast radius": "get_blast_radius",
                   "blast radius": "get_blast_radius", "replay the race": "get_replay", "replay": "get_replay",
                   "repair it": "repair_hazard", "repair the hazard": "repair_hazard", "repair": "repair_hazard",
                   "explain the hazard": "get_hazard", "show the hazard": "get_hazard"}
        if text in intents:
            if not self.hazard_id:
                raise InspectorError("No hazard selected. Analyze my latest Ravel run first; a run without hazards needs no repair.")
            return intents[text], {"hazard_id": self.hazard_id}
        raise InspectorError('Say "Analyze my latest Ravel run", "Show the blast radius", "Replay the race", or "Repair it". You can also send JSON with tool and arguments to select an explicit run/hazard ID.')

    @staticmethod
    def _hazard(h):
        observed, invalidating, consumer = h["observed"], h["invalidating"], h["consumer"]
        return (f"Hazard {h['id']}: {h['observerName']} observed {observed['resourceId']}@{observed['generation']} "
                f"({observed['id']}); {h['invalidatorName']} changed it to @{invalidating['generation']} "
                f"({invalidating['id']}) before {consumer['resourceId']}@{consumer['generation']} was committed. "
                f"The write used a stale dependency. Active affected versions: {len(h['activeBlastRadius'])}; "
                f"historical: {len(h['historicalBlastRadius'])}. Semantic conflict is only confirmed by a separate assessment.")

    def _describe(self, tool, data):
        if tool in ("get_latest_run", "get_run"):
            h = next((h for h in data["hazards"] if h["id"] == self.hazard_id), None)
            return (f"Run {data['run']['id']} ({data['run']['name']}), mode {data['run']['mode']}, "
                    f"sequence {data['currentRuntimeSeq']}. {len(data['hazards'])} recorded hazards. " +
                    (self._hazard(h) if h else "No stale hazards were recorded."))
        if tool == "get_hazard":
            return self._hazard(data)
        if tool == "get_hazards":
            return "\n".join(self._hazard(h) for h in data) or "No stale hazards were recorded."
        if tool == "get_blast_radius":
            return "\n".join(f"{label}: " + (", ".join(f"{n['resourceId']}@{n['generation']} ({n['versionId']})" for n in data[key]) or "none")
                             for label, key in (("Active affected artifacts", "active"), ("Historical affected artifacts", "historical")))
        if tool == "get_replay":
            return "Focused ordered replay:\n" + "\n".join(f"#{s['runtimeSeq']} {s['agent']}: {s['action']} — {s['description']} {s['annotation']}" for s in data["steps"])
        if tool == "repair_hazard":
            return (f"Repair status: {data['status']}. Active affected versions in the run: {data['activeAffectedCount']}.\n" +
                    "\n".join(f"{r['resourceId']}: {r['previousVersionId']} → {r['replacementVersionId']}" for r in data["replacements"]) +
                    "\nImmutable historical versions and hazards remain available for replay.")
        raise InspectorError("Unsupported tool")
