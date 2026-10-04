"""Standard-library client. Concurrency decisions belong exclusively to Go."""

import json
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen


class RuntimeErrorResponse(RuntimeError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class Client:
    def __init__(self, url, timeout=30):
        self.url = url.rstrip("/") + "/api"
        self.timeout = timeout

    def request(self, path, data=None):
        request = Request(
            self.url + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=self.timeout) as response:
                return json.load(response)
        except HTTPError as error:
            body = error.read().decode()
            try:
                body = json.loads(body).get("error", body)
            except ValueError:
                pass
            raise RuntimeErrorResponse(error.code, body) from error

    def create_run(self, name, mode="observe", files=None):
        return self.request("/runs", {"name": name, "mode": mode, "files": files or {}})["runId"]

    def create_agent(self, run_id, name, adapter="python"):
        return self.request(f"/runs/{quote(run_id)}/agents", {"name": name, "adapter": adapter})["agentId"]

    def create_attempt(self, run_id, agent_id, name="", prompt="", task_id=None, repair_of=None):
        payload = {"agentId": agent_id, "name": name, "prompt": prompt}
        if task_id is not None:
            payload["taskId"] = task_id
        if repair_of is not None:
            payload["repairOf"] = repair_of
        identity = self.request(f"/runs/{quote(run_id)}/attempts", payload)
        return Session(self, run_id, identity)

    def snapshot(self, run_id, seq=None):
        return self.request(f"/runs/{quote(run_id)}/debugger" + (f"?seq={seq}" if seq else ""))

    def events(self, run_id):
        return self.request(f"/runs/{quote(run_id)}/events")

    def end(self, run_id):
        return self.request(f"/runs/{quote(run_id)}/end", {})

    def hazard(self, hazard_id):
        return self.request(f"/hazards/{quote(hazard_id, safe='')}")

    def assess(self, hazard_id, result):
        return self.request(f"/hazards/{quote(hazard_id, safe='')}/assessments", result)


class Session:
    def __init__(self, client, run_id, identity):
        self.client, self.run_id, self.identity = client, run_id, identity
        self.attempt_id = identity["id"]
        self.path = f"/runs/{quote(run_id)}/attempts/{quote(self.attempt_id)}"

    def call(self, operation, **payload):
        return self.client.request(f"{self.path}/{operation}", payload)

    def observe_resource(self, path):
        return self.call("observe_resource", path=path)

    def write_resource(self, path, content):
        return self.call("write_resource", path=path, content=content)

    def write_intent(self, path, content):
        return self.call("write_intent", path=path, content=content)

    def commit_write(self, intent_id):
        return self.call("commit_write", intentId=intent_id)

    def apply_patch(self, path, base_version_id, patch):
        return self.call("apply_patch", path=path, baseVersionId=base_version_id, patch=patch)

    def list_resources(self):
        return self.call("list_resources")

    def search_repository(self, query):
        return self.call("search_repository", query=query)

    def complete(self, status="completed"):
        return self.call("complete", status=status)

    def retry(self):
        return self.client.create_attempt(self.run_id, self.identity["agentId"], task_id=self.identity["taskId"],
                                          repair_of=self.identity.get("repairOf"))
