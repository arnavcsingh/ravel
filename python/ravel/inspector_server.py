"""Optional A2A server, bridged to ACP by Agentverse's mailbox SDK."""

import argparse
import asyncio
from collections import OrderedDict
import json
import os
import time
import logging
from contextlib import asynccontextmanager
from uuid import uuid4


def create_app(base_url, port=9999, initialized=False):
    # Imported after agentverse_init: the SDK patches the route constructors.
    from a2a.server.agent_execution import AgentExecutor
    from a2a.server.request_handlers import DefaultRequestHandler
    from a2a.server.routes import create_agent_card_routes, create_jsonrpc_routes
    from a2a.server.tasks import InMemoryTaskStore
    from a2a.types import AgentCard, AgentCapabilities, AgentInterface, AgentSkill, Message, Part, Role
    from starlette.applications import Starlette
    from starlette.responses import JSONResponse
    from starlette.routing import Route
    from .client import Client
    from .inspector import Conversation, Inspector, TOOLS

    class Executor(AgentExecutor):
        def __init__(self):
            self.sessions = OrderedDict()
            self.lock = asyncio.Lock()

        async def execute(self, context, event_queue):
            # Bounded session memory. A global async lock serializes Inspector
            # messages only; Go concurrency is unaffected. HTTP runs off-loop.
            async with self.lock:
                identity = context.context_id or str(uuid4())
                user = context.call_context.user
                key = (user.user_name if user else "local", identity)
                now = time.monotonic()
                for stale in [k for k, (_, touched) in self.sessions.items() if now - touched > 3600]:
                    del self.sessions[stale]
                conversation = self.sessions.pop(key, (Conversation(Inspector(Client(base_url))), now))[0]
                self.sessions[key] = (conversation, now)
                while len(self.sessions) > 256:
                    self.sessions.popitem(last=False)
                text = "\n".join(p.text for p in context.message.parts if p.WhichOneof("content") == "text")
                result = await asyncio.to_thread(conversation.respond, text)
                await event_queue.enqueue_event(Message(
                    message_id=str(uuid4()), context_id=identity, role=Role.ROLE_AGENT,
                    parts=[Part(text=result["text"]), Part(text="Ravel tool result:\n" + json.dumps(result, ensure_ascii=False))],
                ))

        async def cancel(self, context, event_queue):
            from a2a.utils.errors import TaskNotCancelableError
            raise TaskNotCancelableError("Immediate Inspector requests cannot be canceled after dispatch.")

    card = AgentCard(
        name="Ravel Inspector", description="@ravel-inspector: inspect deterministic Ravel concurrency facts, blast radius, replay and repair.",
        version="0.4.0", supported_interfaces=[AgentInterface(protocol_binding="JSONRPC", url=f"http://localhost:{port}/")],
        default_input_modes=["text/plain"], default_output_modes=["text/plain"],
        capabilities=AgentCapabilities(streaming=False),
        skills=[AgentSkill(id=name, name=name.replace("_", " "), description=f"Ravel HTTP tool: {name}", tags=["ravel", "debugger"],
                          examples=["Analyze my latest Ravel run", "Show the blast radius", "Replay the race", "Repair it"]) for name in TOOLS],
    )
    handler = DefaultRequestHandler(agent_card=card, agent_executor=Executor(), task_store=InMemoryTaskStore())
    readiness = {"initialized": initialized, "registered": False, "mailboxActive": False,
                 "relayAuthenticated": False, "authErrors": 0}
    mailbox_services = []

    @asynccontextmanager
    async def lifespan(app):
        state = getattr(app.state, "_agentverse_sdk", None)
        readiness["registered"] = any(route.path == "/av/chat" for route in app.routes)
        if state:
            for service in state.services:
                if type(service).__name__ == "MailboxClient":
                    mailbox_services.append(service)
                    readiness["mailboxActive"] = bool(service._poll_task and not service._poll_task.done())
                    async def observe_response(response):
                        if "/mailbox" in response.request.url.path:
                            if response.status_code == 200:
                                if not readiness["relayAuthenticated"]:
                                    print("Mailbox relay authenticated and polling", flush=True)
                                readiness["relayAuthenticated"] = True
                            elif response.status_code in (401, 403):
                                readiness["relayAuthenticated"] = False
                                readiness["authErrors"] += 1
                    service._http.event_hooks["response"].append(observe_response)
        yield
        readiness["mailboxActive"] = False

    async def health(_request):
        readiness["mailboxActive"] = any(s._poll_task and not s._poll_task.done() for s in mailbox_services)
        readiness["ready"] = all(readiness[k] for k in ("initialized", "registered", "mailboxActive", "relayAuthenticated"))
        return JSONResponse(readiness)
    return Starlette(routes=[*create_agent_card_routes(card), *create_jsonrpc_routes(handler, rpc_url="/"),
                             Route("/health", health)], lifespan=lifespan)


def main(args=None):
    parser = argparse.ArgumentParser(description="Ravel Inspector ACP / A2A mailbox agent")
    parser.add_argument("--local", action="store_true", help="Test A2A locally without Agentverse registration")
    parser.add_argument("--port", type=int, default=9999)
    options = parser.parse_args(args)
    if not options.local:
        uri = os.environ.get("AGENTVERSE_AGENT_URI", "").strip()
        if not uri:
            parser.error("Set AGENTVERSE_AGENT_URI from the @ravel-inspector Agentverse registration, or use --local.")
        from agentverse_sdk.a2a import init as agentverse_init
        from agentverse_sdk._common.logger import configure, logger
        class Redact(logging.Filter):
            def filter(self, record):
                if record.levelno < logging.INFO:
                    return False
                text = record.getMessage()
                for key in ("AGENTVERSE_AGENT_URI", "ASI_ONE_API_KEY", "GEMINI_API_KEY"):
                    secret = os.environ.get(key)
                    if secret:
                        text = text.replace(secret, "[redacted]")
                record.msg, record.args = text, ()
                return True
        logger.addFilter(Redact())
        configure(logging.INFO)
        agentverse_init(uri, mailbox=True)
        configure(logging.INFO)
    import uvicorn
    uvicorn.run(create_app(os.environ.get("RAVEL_API_BASE", "http://localhost:4317"), options.port, initialized=not options.local), host="127.0.0.1", port=options.port)
    return 0


if __name__ == "__main__":
    main()
