"""Moved provider boundaries only; no new SDK, transport, or provider work."""

from typing import Any, Protocol
from .client import Session


class GeminiTransport(Protocol):
    def run_agent(self, task: dict, environment: Session, model: str) -> None: ...
    def analyze(self, semantic_input: dict, model: str) -> dict: ...


class GeminiAgentDriver:
    name = "GeminiAgentDriver"

    def __init__(self, transport: GeminiTransport, model: str):
        self.transport, self.model = transport, model

    def run(self, task: dict, session: Session):
        return self.transport.run_agent(task, session, self.model)


class GeminiSemanticAnalyzer:
    name = "GeminiSemanticAnalyzer"

    def __init__(self, transport: GeminiTransport, model: str):
        self.transport, self.model = transport, model

    def analyze(self, semantic_input: dict):
        return self.transport.analyze(semantic_input, self.model)


class InspectorAgent(Protocol):
    def inspect_run(self, run_id: str) -> Any: ...
    def explain_hazard(self, hazard_id: str) -> Any: ...
    def request_replay(self, hazard_id: str) -> Any: ...
