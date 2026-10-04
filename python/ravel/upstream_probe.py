"""Native transport smoke, including the pinned SDK's real message conversion.

This is a provider diagnostic, not a benchmark execution or score.
"""

import json
import os
import secrets


def main():
    import litellm
    from openhands.sdk import Message

    marker = secrets.token_hex(4)
    tools = [{"type": "function", "function": {
        "name": "probe_echo",
        "description": "Return the supplied marker unchanged.",
        "parameters": {
            "type": "object", "properties": {"marker": {"type": "string"}},
            "required": ["marker"],
        },
    }}]
    messages = [{"role": "user", "content": f"Call probe_echo with marker {marker}. After the tool returns, include its marker in your answer."}]
    configuration = {
        "model": os.environ["LLM_MODEL"],
        "api_key": os.environ["LLM_API_KEY"],
        "api_base": os.environ["LLM_BASE_URL"],
        "timeout": 60,
        "num_retries": 0,
        "max_tokens": 1024,
    }
    response = litellm.completion(**configuration, messages=messages, tools=tools, tool_choice="required")
    # The exact conversion that previously dropped OpenAI-compatible signatures.
    converted = Message.from_llm_chat_message(response.choices[0].message).to_chat_dict(
        cache_enabled=False, vision_enabled=False, function_calling_enabled=True,
        force_string_serializer=False, send_reasoning_content=False,
    )
    calls = converted.get("tool_calls", [])
    if len(calls) != 1:
        raise RuntimeError("Provider diagnostic expected exactly one tool call")
    call = calls[0]
    if call["function"]["name"] != "probe_echo":
        raise RuntimeError("Provider diagnostic returned an unknown tool")
    arguments = json.loads(call["function"]["arguments"])
    if arguments.get("marker") != marker:
        raise RuntimeError("Provider diagnostic returned the wrong marker")
    # Execute the requested echo, then replay the converted SDK message verbatim.
    messages.extend([converted, {
        "role": "tool", "tool_call_id": call["id"], "name": "probe_echo",
        "content": arguments["marker"],
    }])
    followup = litellm.completion(**configuration, messages=messages, tools=tools, tool_choice="none")
    if marker not in (followup.choices[0].message.content or ""):
        raise RuntimeError("Provider diagnostic did not use the tool result")
    print(json.dumps({"diagnostic_only": True, "native_completion": True,
                      "tool_execution": True, "sdk_message_roundtrip": True}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
