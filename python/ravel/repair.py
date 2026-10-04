"""Plan regeneration from immutable producer attempts and complete provenance."""

REPAIR_INSTRUCTIONS = """
This is a repair regeneration of the original task. Start with fresh observations
of the current source dependencies and regenerate the complete outputs. Affected
outputs (including your own previous output) cannot be read or searched as inputs.
Do not patch or copy those outputs. Read the newly repaired upstream resource when
it is a dependency. Publish every generated output even if its content is unchanged;
Ravel records the new execution and its actual observations as an immutable version.
If fresh sources do not suffice, report the limitation instead of inventing inputs.
"""


def repair_plan(snapshot, events, agents):
    starts = {e["attemptId"]: e["payload"] for e in events if e["kind"] == "TASK_ATTEMPT_START"}
    versions = {e["payload"]["version"]["id"]: e["payload"]["version"] for e in events if "version" in e["payload"]}
    active = [h for h in snapshot["hazards"] if h["active"]]
    historical = {v for h in active for v in h["historicalBlastRadius"]}
    affected = {v for h in active for v in h["activeBlastRadius"]}
    # Include the directly stale producer even after a partial previous repair.
    roots = {h["consumerVersionId"] for h in active}
    selected = affected | roots
    def producer(version):
        attempt = versions[version].get("producerAttemptId")
        if attempt not in starts:
            raise ValueError("Affected version has no recorded producer task attempt")
        return starts[attempt]["attempt"]
    tasks = {producer(v)["taskId"] for v in selected}
    keys = {(a["agentId"], a["taskId"]): key for key, a in agents.items() if a.get("taskId")}
    parents = {}
    for edge in snapshot["graph"]["edges"]:
        if edge["kind"] == "DERIVED_FROM" and edge["source"] in historical and edge["target"] in historical:
            parents.setdefault(edge["target"], set()).add(edge["source"])
    dependencies = {task: set() for task in tasks}
    for version in selected:
        task = producer(version)["taskId"]
        pending, seen = list(parents.get(version, [])), set()
        while pending:
            parent = pending.pop()
            if parent in seen:
                continue
            seen.add(parent)
            ancestor = producer(parent)["taskId"]
            if ancestor in tasks and ancestor != task:
                dependencies[task].add(ancestor)
            pending.extend(parents.get(parent, []))
    plan = []
    while dependencies:
        ready = sorted(task for task, parents in dependencies.items() if not parents)
        if not ready:
            raise ValueError("Affected task dependencies are cyclic; regeneration is unsupported")
        for task in ready:
            candidates = [v for v in selected if producer(v)["taskId"] == task]
            source = max(candidates, key=lambda v: versions[v]["creationSeq"])
            attempt = producer(source)
            key = keys.get((attempt["agentId"], task))
            if key is None:
                raise ValueError("Affected producer task is outside this live controller")
            plan.append({"sourceAttemptId": attempt["id"], "taskId": task, "agentKey": key,
                         "prompt": starts[attempt["id"]]["task"]["prompt"],
                         "outputs": sorted({versions[v]["resourceId"] for v in affected if producer(v)["taskId"] == task})})
            del dependencies[task]
            for parents in dependencies.values():
                parents.discard(task)
    if not plan:
        raise ValueError("No affected producer task found")
    return plan
