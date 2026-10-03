"""Explicit Gemini commands; normal demo/start commands remain offline."""

import argparse
import json
import os
from pathlib import Path
import sys

from .client import Client, RuntimeErrorResponse
from .gemini import DEFAULT_MODEL, GeminiError, GeminiRESTTransport, Limits, model_name, semantic_input
from .integrations import GeminiAgentDriver, GeminiSemanticAnalyzer


def configured_model(name):
    return os.getenv(name, "").strip() or DEFAULT_MODEL


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="Show local configuration without calling Gemini")
    check = sub.add_parser("check", help="Make a tiny live generation request")
    agent = sub.add_parser("agent", help="Execute a coding task using mediated repository tools")
    analyze = sub.add_parser("analyze", help="Annotate a recorded hazard with Gemini")
    for command in (check, agent, analyze):
        command.add_argument("--model")
        command.add_argument("--timeout", type=int, default=45)
    for command in (agent, analyze):
        command.add_argument("--url", default=f"http://127.0.0.1:{os.getenv('PORT', '4317')}")
        command.add_argument("--max-output-tokens", type=int, default=2048)
    agent.add_argument("--prompt", required=True)
    agent.add_argument("--name", default="Gemini coding task")
    source = agent.add_mutually_exclusive_group()
    source.add_argument("--files", type=Path, help="JSON object mapping resource paths to initial text")
    source.add_argument("--run", help="Continue this recorded run using its existing mode")
    agent.add_argument("--mode", choices=("observe", "guard"), default="guard")
    agent.add_argument("--max-calls", type=int, default=12)
    agent.add_argument("--max-retries", type=int, default=1)
    analyze.add_argument("hazard_id")
    args = parser.parse_args(argv)
    run_id = None
    transport = None
    try:
        if args.command == "status":
            print(json.dumps({"configured": bool(os.getenv("GEMINI_API_KEY", "").strip()),
                              "agentModel": configured_model("RAVEL_AGENT_MODEL"),
                              "semanticModel": configured_model("RAVEL_SEMANTIC_MODEL"),
                              "runtimeBoundary": "HTTP", "automaticProviderCalls": False}, indent=2))
            return 0
        setting = "RAVEL_SEMANTIC_MODEL" if args.command == "analyze" else "RAVEL_AGENT_MODEL"
        model = model_name(args.model or configured_model(setting))
        limits = Limits(max_calls=getattr(args, "max_calls", 1),
                        max_output_tokens=getattr(args, "max_output_tokens", 64),
                        max_retries=getattr(args, "max_retries", 0), timeout=args.timeout)
        transport = GeminiRESTTransport(limits=limits)
        if args.command == "check":
            response = transport.generate(model, {
                "contents": [{"role": "user", "parts": [{"text": "Reply with exactly: RAVEL_OK"}]}],
                "generationConfig": {"maxOutputTokens": 64},
            })
            content = transport.content(response)
            reply = "".join(p.get("text", "") for p in content["parts"] if not p.get("thought"))
            result = {"ok": reply.strip() == "RAVEL_OK", "model": model, "reply": reply,
                      "usage": transport.usage}
            print(json.dumps(result, indent=2))
            return 0 if result["ok"] else 1
        client = Client(args.url)
        if args.command == "analyze":
            evidence = semantic_input(client, args.hazard_id)
            result = GeminiSemanticAnalyzer(transport, model).analyze(evidence)
            detail = client.assess(args.hazard_id, result)
            print(json.dumps({"hazardId": args.hazard_id, "assessment": detail["assessment"],
                              "usage": transport.usage}, indent=2))
            return 0
        if args.run:
            run_id = args.run
            if client.snapshot(run_id)["run"]["status"] == "completed":
                client.request(f"/runs/{run_id}/resume", {})
        else:
            files = json.loads(args.files.read_text(encoding="utf-8")) if args.files else {}
            if not isinstance(files, dict) or any(not isinstance(k, str) or not isinstance(v, str)
                                                   for k, v in files.items()):
                raise ValueError("--files must contain a JSON object mapping paths to text")
            run_id = client.create_run(args.name, args.mode, files)
        agent_id = client.create_agent(run_id, "Gemini", "gemini/" + model)
        session = client.create_attempt(run_id, agent_id, args.name, args.prompt)
        print(f"Gemini run: {run_id}; model: {model}", file=sys.stderr, flush=True)
        result = GeminiAgentDriver(transport, model).run({"name": args.name, "prompt": args.prompt}, session)
        # Do not complete another caller's run; it can contain concurrent agents.
        if not args.run:
            client.end(run_id)
        print(json.dumps(result, indent=2))
        return 0
    except (GeminiError, RuntimeErrorResponse, OSError, ValueError) as error:
        # Only configuration/model/API summaries, never credentials or transcripts.
        message = str(error)
        key = os.getenv("GEMINI_API_KEY", "").strip()
        if key:
            message = message.replace(key, "[redacted]")
        print(json.dumps({"error": message, "runId": run_id,
                          "usage": transport.usage if transport else None}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
