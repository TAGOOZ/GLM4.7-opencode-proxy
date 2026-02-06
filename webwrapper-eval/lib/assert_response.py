#!/usr/bin/env python3
import json
import sys
from typing import Any


def load(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def get_content(data: dict) -> str:
    if "content" in data and isinstance(data.get("content"), str):
        return data.get("content", "")
    choices = data.get("choices") or []
    if choices and isinstance(choices[0], dict):
        msg = choices[0].get("message") or {}
        if isinstance(msg, dict):
            content = msg.get("content")
            if isinstance(content, str):
                return content
    raise SystemExit("content missing")


def get_tool_calls(data: dict) -> list[dict]:
    if isinstance(data.get("tool_calls"), list):
        return data.get("tool_calls") or []
    choices = data.get("choices") or []
    if choices and isinstance(choices[0], dict):
        msg = choices[0].get("message") or {}
        if isinstance(msg, dict) and isinstance(msg.get("tool_calls"), list):
            return msg.get("tool_calls") or []
    return []


def check_content_nonempty(data: dict) -> None:
    content = get_content(data)
    if not content.strip():
        raise SystemExit("content missing or empty")


def check_content_contains(data: dict, needle: str) -> None:
    content = get_content(data)
    if needle not in content:
        raise SystemExit(f"content missing '{needle}'")


def check_no_tool_calls(data: dict) -> None:
    calls = get_tool_calls(data)
    if calls:
        raise SystemExit("unexpected tool_calls")


def check_has_tool_call(data: dict, names: list[str]) -> None:
    calls = get_tool_calls(data)
    if not calls:
        raise SystemExit("tool_calls missing")
    lowered = [n.strip().lower() for n in names if n.strip()]
    for call in calls:
        if not isinstance(call, dict):
            continue
        fn = (call.get("function") or {}).get("name")
        tool = call.get("tool")
        name = fn or tool
        if isinstance(name, str) and name.lower() in lowered:
            return
    raise SystemExit(f"tool_calls did not include {names}")


def check_usage_present(data: dict) -> None:
    usage = data.get("usage")
    tokens = data.get("tokens")
    if isinstance(usage, dict) and usage:
        return
    if isinstance(tokens, dict) and tokens:
        return
    raise SystemExit("usage missing")


def check_tool_output_contains(data: dict, needle: str) -> None:
    calls = get_tool_calls(data)
    if not calls:
        raise SystemExit("tool_calls missing")
    for call in calls:
        if not isinstance(call, dict):
            continue
        output = call.get("output")
        if isinstance(output, str) and needle in output:
            return
        state = call.get("state")
        if isinstance(state, dict):
            state_output = state.get("output")
            if isinstance(state_output, str) and needle in state_output:
                return
            metadata = state.get("metadata")
            if isinstance(metadata, dict):
                meta_output = metadata.get("output")
                if isinstance(meta_output, str) and needle in meta_output:
                    return
    raise SystemExit(f"tool output missing '{needle}'")


def check_tool_truncated(data: dict) -> None:
    calls = get_tool_calls(data)
    if not calls:
        raise SystemExit("tool_calls missing")
    for call in calls:
        if not isinstance(call, dict):
            continue
        state = call.get("state")
        if isinstance(state, dict):
            metadata = state.get("metadata")
            if isinstance(metadata, dict) and metadata.get("truncated") is True:
                return
            output = state.get("output")
            if isinstance(output, str):
                if "truncated" in output.lower() or "file has more lines" in output.lower():
                    return
        output = call.get("output")
        if isinstance(output, str):
            if "truncated" in output.lower() or "file has more lines" in output.lower():
                return
    raise SystemExit("no truncated tool output detected")


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit("usage: assert_response.py <json_path> <check> [args]")
    path = sys.argv[1]
    check = sys.argv[2]
    data = load(path)
    if check == "content_nonempty":
        check_content_nonempty(data)
    elif check == "content_contains":
        if len(sys.argv) < 4:
            raise SystemExit("missing substring")
        check_content_contains(data, sys.argv[3])
    elif check == "no_tool_calls":
        check_no_tool_calls(data)
    elif check == "has_tool_call":
        if len(sys.argv) < 4:
            raise SystemExit("missing tool names")
        names = sys.argv[3].split(",")
        check_has_tool_call(data, names)
    elif check == "usage_present":
        check_usage_present(data)
    elif check == "tool_output_contains":
        if len(sys.argv) < 4:
            raise SystemExit("missing substring")
        check_tool_output_contains(data, sys.argv[3])
    elif check == "tool_truncated":
        check_tool_truncated(data)
    else:
        raise SystemExit(f"unknown check {check}")


if __name__ == "__main__":
    main()
