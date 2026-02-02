"""OpenAI-compatible proxy for GLM 4.7"""

import json
import os
import time
import uuid
from typing import Any, Dict, Generator, List, Optional, Tuple

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

from glm_cli.api_client import GLMClient

app = FastAPI()


def _load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except Exception:
        return
    # Try repo root first (cwd), then alongside this file
    load_dotenv()
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))


def _load_token() -> str:
    _load_dotenv()
    token = os.getenv("GLM_TOKEN")
    if token:
        return token
    config_path = os.path.join(os.path.expanduser("~"), ".config", "glm-cli", "config.json")
    if not os.path.exists(config_path):
        raise RuntimeError("Missing GLM token. Run: glm config --token YOUR_TOKEN")
    with open(config_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    token = data.get("token")
    if not token:
        raise RuntimeError("Missing GLM token. Run: glm config --token YOUR_TOKEN")
    return token


def _get_client() -> GLMClient:
    return GLMClient(_load_token())


_proxy_chat_id: Optional[str] = None


def _ensure_proxy_chat(client: GLMClient) -> str:
    global _proxy_chat_id
    if _proxy_chat_id:
        return _proxy_chat_id
    chat = client.create_chat(title="OpenCode Proxy", model="glm-4.7")
    _proxy_chat_id = chat.id
    return _proxy_chat_id


def _get_parent_message_id(client: GLMClient, chat_id: str) -> Optional[str]:
    try:
        return client.get_current_message_id(chat_id)
    except Exception:
        return None


@app.get("/v1/models")
@app.get("/models")
def list_models():
    return {
        "object": "list",
        "data": [
            {
                "id": "glm-4.7",
                "object": "model",
                "created": int(time.time()),
                "owned_by": "z.ai",
            }
        ],
    }


def _tool_prompt(tools: List[Dict[str, Any]]) -> str:
    lines = [
        "You are a tool-calling assistant.",
        "If you need to call a tool, respond with JSON ONLY and nothing else.",
        "If the user asks to create/modify files, run commands, or perform actions, you MUST call an appropriate tool.",
        "Do NOT answer with code-only responses for actionable requests; call tools instead.",
        "When writing files, include the FULL and COMPLETE file content (no truncation).",
        "Use one of these formats:",
        '{"tool_calls":[{"name":"<tool_name>","arguments":{...}}]}',
        '{"tool":"<tool_name>","arguments":{...}}',
        "If no tool is needed, respond normally.",
        "Allowed tools:",
    ]
    for tool in tools:
        fn = tool.get("function", {})
        name = fn.get("name")
        desc = fn.get("description")
        params = fn.get("parameters")
        lines.append(f"- {name}: {desc}")
        if params:
            lines.append(f"  parameters: {json.dumps(params, ensure_ascii=False)}")
    return "\n".join(lines)


def _convert_messages(messages: List[Dict[str, Any]], tools: List[Dict[str, Any]]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    if tools:
        out.append({"role": "system", "content": _tool_prompt(tools)})

    for msg in messages:
        role = msg.get("role", "user")
        if role == "tool":
            name = msg.get("name", "tool")
            content = msg.get("content", "")
            if isinstance(content, (dict, list)):
                content = json.dumps(content, ensure_ascii=False)
            out.append({"role": "user", "content": f"Tool result ({name}):\n{content}"})
            continue
        if role == "assistant" and msg.get("tool_calls"):
            # Preserve prior tool call context (use lightweight hint when tools are disabled)
            if tools:
                out.append({"role": "assistant", "content": json.dumps(msg.get("tool_calls"), ensure_ascii=False)})
            else:
                out.append({"role": "assistant", "content": "Assistant invoked tools."})
            continue
        content = msg.get("content", "") or ""
        out.append({"role": role, "content": content})
    return out


def _repair_json(raw: str) -> Optional[Any]:
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.strip("`\n ")
        if raw.startswith("json"):
            raw = raw[4:].strip()
    try:
        return json.loads(raw)
    except Exception:
        pass

    def _try_parse_snippet(snippet: str) -> Optional[Any]:
        try:
            return json.loads(snippet)
        except Exception:
            repaired = snippet.replace("'", "\"")
            repaired = repaired.replace(",}", "}").replace(",]", "]")
            try:
                return json.loads(repaired)
            except Exception:
                return None

    # Prefer arrays when present (common for tool call lists)
    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end != -1 and end > start:
        parsed = _try_parse_snippet(raw[start:end + 1])
        if parsed is not None:
            return parsed

    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end == -1 or end <= start:
        return None
    return _try_parse_snippet(raw[start:end + 1])


_ARG_SYNONYMS = {
    "filepath": "path",
    "file_path": "path",
    "filename": "path",
    "file": "path",
    "cmd": "command",
}

_TOOL_NAME_SYNONYMS = {
    "writefile": "write",
    "write_file": "write",
    "save_file": "write",
    "save": "write",
    "create_file": "write",
    "readfile": "read",
    "read_file": "read",
    "open_file": "read",
    "edit_file": "edit",
    "apply_patch": "patch",
}


def _normalize_tool_name(name: str) -> str:
    return name.lower().replace("_", "").replace("-", "")


def _resolve_tool_name(target: str, allowed_tools: List[str]) -> Optional[str]:
    target_norm = _normalize_tool_name(target)
    for tool in allowed_tools:
        norm = _normalize_tool_name(tool)
        if norm == target_norm:
            return tool
        if _TOOL_NAME_SYNONYMS.get(norm) == target_norm:
            return tool
    return None


def _normalize_args(args: Dict[str, Any], allowed_params: Optional[List[str]]) -> Dict[str, Any]:
    if not allowed_params:
        normalized: Dict[str, Any] = {}
        for key, value in args.items():
            key_norm = key.lower().replace("_", "").replace("-", "")
            synonym = _ARG_SYNONYMS.get(key_norm)
            if synonym:
                normalized[key] = value
                if synonym != key:
                    normalized[synonym] = value
            else:
                normalized[key] = value
        return normalized
    allowed = list(allowed_params)
    allowed_norm = {p.lower().replace("_", "").replace("-", ""): p for p in allowed}
    normalized: Dict[str, Any] = {}
    for key, value in args.items():
        key_norm = key.lower().replace("_", "").replace("-", "")
        if key_norm in allowed_norm:
            normalized[allowed_norm[key_norm]] = value
            continue
        # map path -> filePath when schema uses filePath
        if key_norm == "path" and "filepath" in allowed_norm:
            normalized[allowed_norm["filepath"]] = value
            continue
        # synonyms
        synonym = _ARG_SYNONYMS.get(key_norm)
        if synonym:
            syn_norm = synonym.lower().replace("_", "").replace("-", "")
            if syn_norm in allowed_norm:
                normalized[allowed_norm[syn_norm]] = value
                continue
        normalized[key] = value
    return normalized


def _normalize_tool_calls(
    tool_calls: List[Dict[str, Any]],
    allowed_tools: List[str],
    tool_params_by_name: Dict[str, List[str]],
) -> Optional[List[Dict[str, Any]]]:
    normalized: List[Dict[str, Any]] = []
    for call in tool_calls:
        name = call.get("name")
        if name:
            name = _TOOL_NAME_SYNONYMS.get(name, name)
        if not name or name not in allowed_tools:
            # fuzzy match common file tools
            if name in ("write", "edit"):
                match = next((t for t in allowed_tools if name in t), None)
                if match:
                    name = match
                else:
                    continue
            else:
                continue
        args = call.get("arguments", {})
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                continue
        if not isinstance(args, dict):
            continue
        args = _normalize_args(args, tool_params_by_name.get(name))
        normalized.append({"name": name, "arguments": args})
    return normalized or None


def _coerce_tool_calls(raw_calls: List[Any]) -> List[Dict[str, Any]]:
    coerced: List[Dict[str, Any]] = []
    for call in raw_calls:
        if not isinstance(call, dict):
            continue
        if "name" in call and "arguments" in call:
            coerced.append({"name": call.get("name"), "arguments": call.get("arguments", {})})
            continue
        func = call.get("function")
        if isinstance(func, dict):
            coerced.append(
                {
                    "name": func.get("name") or call.get("name"),
                    "arguments": func.get("arguments", {}),
                }
            )
            continue
    return coerced


def _extract_tool_call(
    text: str,
    allowed_tools: List[str],
    tool_params_by_name: Dict[str, List[str]],
) -> Optional[Dict[str, Any]]:
    if not text:
        return None
    data = _repair_json(text)
    if not data:
        return None

    if isinstance(data, list):
        coerced = _coerce_tool_calls(data)
        normalized = _normalize_tool_calls(coerced, allowed_tools, tool_params_by_name)
        if normalized:
            return {"tool_calls": normalized}
        return None

    if isinstance(data, dict) and "function" in data and "tool_calls" not in data and "tool" not in data:
        coerced = _coerce_tool_calls([data])
        normalized = _normalize_tool_calls(coerced, allowed_tools, tool_params_by_name)
        if normalized:
            return {"tool_calls": normalized}
        return None

    if not isinstance(data, dict):
        return None

    if "tool_calls" in data and isinstance(data["tool_calls"], list):
        coerced = _coerce_tool_calls(data["tool_calls"])
        normalized = _normalize_tool_calls(coerced, allowed_tools, tool_params_by_name)
        if normalized:
            return {"tool_calls": normalized}
        return None

    if "tool" in data and "arguments" in data:
        normalized = _normalize_tool_calls(
            [{"name": data["tool"], "arguments": data["arguments"]}],
            allowed_tools,
            tool_params_by_name,
        )
        if normalized:
            return {"tool_calls": normalized}
    return None


def _extract_partial_tool_call(
    text: str,
    allowed_tools: List[str],
    tool_params_by_name: Dict[str, List[str]],
) -> Optional[Dict[str, Any]]:
    if not text:
        return None
    scan_text = text.replace("\\\"", "\"")
    lowered = scan_text.lower()
    tool_name = None
    for candidate in [
        "write",
        "write_file",
        "writefile",
        "save_file",
        "edit",
        "edit_file",
        "apply_patch",
        "read",
        "read_file",
        "readfile",
        "open_file",
    ]:
        if candidate in lowered:
            tool_name = _TOOL_NAME_SYNONYMS.get(candidate, candidate)
            break
    if tool_name and tool_name not in allowed_tools:
        tool_name = next((t for t in allowed_tools if tool_name in t), None)
    if not tool_name:
        return None

    import re

    def _scan_quoted_value(src: str, key: str) -> Optional[str]:
        key_idx = src.lower().find(key)
        if key_idx == -1:
            return None
        after = src[key_idx + len(key):]
        m = re.search(r'[:=]\s*"', after)
        if not m:
            return None
        start = key_idx + len(key) + m.end()
        i = start
        escaped = False
        while i < len(src):
            ch = src[i]
            if ch == "\\" and not escaped:
                escaped = True
                i += 1
                continue
            if ch == '"' and not escaped:
                return src[start:i]
            escaped = False
            i += 1
        # No closing quote; return whatever is left
        return src[start:]

    path = _scan_quoted_value(scan_text, "filepath") or _scan_quoted_value(scan_text, "file_path")
    if path is None:
        path = _scan_quoted_value(scan_text, "path") or _scan_quoted_value(scan_text, "filename")

    content = _scan_quoted_value(scan_text, "content")
    if content is not None:
        content = content.rstrip().rstrip("}\" ")

    # If content is missing for write/edit, avoid partial tool call
    if tool_name in ("write", "edit") and (not path or content is None):
        return None
    if tool_name == "read" and not path:
        return None
    if tool_name == "read" and path:
        cleaned = path.strip()
        if cleaned in (".", "./") or cleaned.endswith("/") or cleaned.endswith("\\"):
            return None

    args: Dict[str, Any] = {}
    if path:
        args["path"] = path
    if content is not None:
        args["content"] = content

    args = _normalize_args(args, tool_params_by_name.get(tool_name))
    if not args:
        return None
    return {"tool_calls": [{"name": tool_name, "arguments": args}]}


def _is_valid_write_call(user_text: str, tool_calls: List[Dict[str, Any]]) -> bool:
    if not tool_calls:
        return False
    call = tool_calls[0]
    name = call.get("name")
    if name not in ("write", "edit", "read"):
        return True
    args = call.get("arguments", {})
    if name == "read":
        path = args.get("path") or args.get("filePath") or args.get("file_path")
        if not isinstance(path, str) or not path.strip():
            return False
        cleaned = path.strip()
        if cleaned in (".", "./") or cleaned.endswith("/") or cleaned.endswith("\\"):
            return False
        return True
    content = args.get("content")
    if not isinstance(content, str) or not content.strip():
        return False
    # Require a target path for file writes/edits
    if not any(k in args for k in ("path", "filePath", "file_path")):
        return False
    return True


def _fallback_tool_call(
    user_text: str,
    allowed_tools: List[str],
    tool_params_by_name: Dict[str, List[str]],
) -> Optional[Dict[str, Any]]:
    text = user_text.lower()
    list_intent = [
        "list",
        "show",
        "inspect",
        "files",
        "folders",
        "directories",
        "ls",
        "tree",
    ]
    wants_files = any(k in text for k in list_intent)
    if not wants_files:
        return None

    # Prefer glob if available
    if "glob" in allowed_tools:
        params = tool_params_by_name.get("glob", [])
        args: Dict[str, Any] = {}
        if "pattern" in params:
            args["pattern"] = "**/*"
        elif "path" in params:
            args["path"] = "."
        elif "cwd" in params:
            args["cwd"] = "."
        return {"tool_calls": [{"name": "glob", "arguments": args}]}

    # Fallback to ls/list
    for candidate in ["ls", "list", "list_dir"]:
        if candidate in allowed_tools:
            params = tool_params_by_name.get(candidate, [])
            args: Dict[str, Any] = {}
            if "path" in params:
                args["path"] = "."
            elif "cwd" in params:
                args["cwd"] = "."
            return {"tool_calls": [{"name": candidate, "arguments": args}]}

    return None


def _fallback_read_call(
    user_text_raw: str,
    allowed_tools: List[str],
    tool_params_by_name: Dict[str, List[str]],
) -> Optional[Dict[str, Any]]:
    tool_name = _resolve_tool_name("read", allowed_tools)
    if not tool_name:
        return None
    lowered = user_text_raw.lower()
    read_intent = ["read", "open", "show", "cat", "contents", "what is in", "what's in", "display"]
    if not any(k in lowered for k in read_intent):
        return None

    import re
    candidates: List[str] = []
    pattern = r'`([^`]+)`|"([^"]+)"|\'([^\']+)\'|([\w./-]+\.[A-Za-z0-9]+)'
    for match in re.finditer(pattern, user_text_raw):
        for group in match.groups():
            if group:
                candidates.append(group)
                break

    if not candidates:
        return None

    def _score(candidate: str) -> int:
        score = 0
        if "/" in candidate or "\\" in candidate:
            score += 2
        if re.search(r"\\.[A-Za-z0-9]{1,6}$", candidate):
            score += 3
        if candidate.endswith((".txt", ".md", ".json", ".py", ".yaml", ".yml", ".toml")):
            score += 2
        if len(candidate) > 2:
            score += 1
        return score

    cleaned_candidates = []
    for c in candidates:
        cleaned = c.strip().strip(".,:;!?)")
        if cleaned:
            cleaned_candidates.append(cleaned)

    if not cleaned_candidates:
        return None

    path = max(cleaned_candidates, key=_score)
    if not re.search(r"[./\\\\]", path):
        # Avoid plain words like "here"
        return None
    if not path:
        return None

    # If it's a bare filename, try to resolve it within the repo
    if not os.path.isabs(path) and "/" not in path and "\\" not in path:
        try:
            import glob
            matches = [p for p in glob.glob(f"**/{path}", recursive=True) if os.path.isfile(p)]
            if len(matches) == 1:
                path = matches[0]
            elif len(matches) > 1:
                # Prefer shortest path to reduce ambiguity
                path = sorted(matches, key=len)[0]
        except Exception:
            pass

    params = tool_params_by_name.get(tool_name)
    args: Dict[str, Any] = {"path": path}
    if not params:
        args["filePath"] = path
    else:
        args = _normalize_args(args, params)
        if "filePath" in params and "filePath" not in args:
            args["filePath"] = path
    return {"tool_calls": [{"name": tool_name, "arguments": args}]}


def _openai_response(content: Optional[str], model: str) -> Dict[str, Any]:
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
    }


def _openai_tool_response(tool_calls: List[Dict[str, Any]], model: str) -> Dict[str, Any]:
    calls = []
    for idx, call in enumerate(tool_calls):
        call_id = call.get("id") or f"call_{uuid.uuid4().hex[:8]}"
        name = call.get("name")
        args = call.get("arguments", {})
        calls.append(
            {
                "id": call_id,
                "index": idx,
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
            }
        )
    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": None, "tool_calls": calls},
                "finish_reason": "tool_calls",
            }
        ],
    }


def _stream_content(content: str, model: str) -> Generator[str, None, None]:
    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}],
    }
    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
    done = {
        "id": chunk["id"],
        "object": "chat.completion.chunk",
        "created": chunk["created"],
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    yield f"data: {json.dumps(done, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


def _stream_tool_calls(tool_calls: List[Dict[str, Any]], model: str) -> Generator[str, None, None]:
    calls = []
    for idx, call in enumerate(tool_calls):
        call_id = call.get("id") or f"call_{uuid.uuid4().hex[:8]}"
        name = call.get("name")
        args = json.dumps(call.get("arguments", {}), ensure_ascii=False)
        calls.append(
            {
                "index": idx,
                "id": call_id,
                "type": "function",
                "function": {"name": name, "arguments": args},
            }
        )

    chunk = {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "tool_calls": calls},
                "finish_reason": "tool_calls",
            }
        ],
    }
    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


def _collect_glm_response(
    client: GLMClient,
    chat_id: str,
    glm_messages: List[Dict[str, str]],
    generation_params: Dict[str, Any],
    parent_message_id: Optional[str] = None,
) -> str:
    content_parts: List[str] = []
    for chunk in client.send_message(
        chat_id=chat_id,
        messages=glm_messages,
        enable_thinking=False,
        include_history=False,
        parent_message_id=parent_message_id,
        generation_params=generation_params,
    ):
        if chunk.get("type") == "content":
            content_parts.append(chunk.get("data", ""))
    return "".join(content_parts).strip()


def _stream_glm_response(
    client: GLMClient,
    chat_id: str,
    glm_messages: List[Dict[str, str]],
    generation_params: Dict[str, Any],
    model: str,
    parent_message_id: Optional[str] = None,
) -> Generator[str, None, None]:
    msg_id = f"chatcmpl-{uuid.uuid4().hex}"
    created = int(time.time())
    sent_role = False
    for chunk in client.send_message(
        chat_id=chat_id,
        messages=glm_messages,
        enable_thinking=False,
        include_history=False,
        parent_message_id=parent_message_id,
        generation_params=generation_params,
    ):
        if chunk.get("type") == "content":
            delta: Dict[str, Any] = {"content": chunk.get("data", "")}
            if not sent_role:
                delta["role"] = "assistant"
                sent_role = True
            data = {
                "id": msg_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": delta,
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
        elif chunk.get("type") == "error":
            err = {
                "error": {
                    "message": chunk.get("data", "Unknown error"),
                    "type": "server_error",
                }
            }
            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"
    done = {
        "id": msg_id,
        "object": "chat.completion.chunk",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }
    yield f"data: {json.dumps(done, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()
    model = body.get("model") or "glm-4.7"
    messages = body.get("messages", [])
    tools = body.get("tools", [])
    tool_choice = body.get("tool_choice")
    stream = bool(body.get("stream"))
    client = _get_client()
    chat_id = _ensure_proxy_chat(client)

    # If tool usage is explicitly disabled, skip tool handling
    if tool_choice == "none":
        tools = []

    # If last message is a tool result, disable tools for the final response
    last_role = messages[-1].get("role") if messages else None
    post_tool_response = False
    if last_role in ("tool", "function") or (messages and messages[-1].get("tool_call_id")):
        tools = []
        tool_choice = "none"
        post_tool_response = True

    glm_messages = _convert_messages(messages, tools)
    if post_tool_response:
        glm_messages = [
            {
                "role": "system",
                "content": "Use the tool results above to answer the user. Provide a final response and do not call tools.",
            }
        ] + glm_messages

    last_user = ""
    last_user_raw = ""
    for msg in reversed(messages):
        if msg.get("role") == "user":
            last_user_raw = msg.get("content") or ""
            last_user = last_user_raw.lower()
            break

    generation_params: Dict[str, Any] = {}
    for key in ["temperature", "top_p", "max_tokens", "presence_penalty", "frequency_penalty"]:
        if key in body:
            generation_params[key] = body[key]

    allowed_tools = [t.get("function", {}).get("name") for t in tools]
    tool_params_by_name: Dict[str, List[str]] = {}
    for t in tools:
        fn = t.get("function", {})
        name = fn.get("name")
        params = fn.get("parameters", {}).get("properties", {})
        if name:
            tool_params_by_name[name] = list(params.keys())
    if tool_choice and isinstance(tool_choice, dict):
        forced = tool_choice.get("function", {}).get("name")
        if forced and forced in allowed_tools:
            allowed_tools = [forced]

    import re

    actionable = any(
        kw in last_user
        for kw in [
            "create",
            "write",
            "edit",
            "modify",
            "delete",
            "remove",
            "save",
            "file",
            "run",
            "execute",
            "install",
            "search",
            "find",
            "list",
            "open",
            "read",
            "patch",
            "apply",
            "inspect",
            "show",
            "contents",
        ]
    )
    mentions_file = bool(re.search(r"[\w./-]+\.[A-Za-z0-9]{1,6}\b", last_user_raw))
    actionable = actionable or mentions_file

    # Short-circuit obvious file read/listing/inspection requests
    if tools:
        fallback = _fallback_read_call(last_user_raw, allowed_tools, tool_params_by_name)
        if not fallback and actionable:
            fallback = _fallback_tool_call(last_user, allowed_tools, tool_params_by_name)
        if fallback:
            if stream:
                return StreamingResponse(
                    _stream_tool_calls(fallback["tool_calls"], model),
                    media_type="text/event-stream",
                )
            return JSONResponse(_openai_tool_response(fallback["tool_calls"], model))

    parent_id = _get_parent_message_id(client, chat_id)

    if stream:
        if tools:
            # Tool calls need full content to decide; buffer first.
            attempt_messages = list(glm_messages)
            if actionable:
                attempt_messages = [
                    {
                        "role": "system",
                        "content": (
                            "Return ONLY valid JSON for a tool call, with fully closed strings. "
                            "No extra text."
                        ),
                    }
                ] + attempt_messages

            full_text = _collect_glm_response(client, chat_id, attempt_messages, generation_params, parent_id)
            tool_call = _extract_tool_call(full_text, allowed_tools, tool_params_by_name)
            if not tool_call:
                tool_call = _extract_partial_tool_call(full_text, allowed_tools, tool_params_by_name)

            if tool_call and not _is_valid_write_call(last_user, tool_call["tool_calls"]):
                repaired = _fallback_read_call(last_user_raw, allowed_tools, tool_params_by_name)
                if repaired:
                    tool_call = repaired
                else:
                    tool_call = None

            if tool_call and _is_valid_write_call(last_user, tool_call["tool_calls"]):
                return StreamingResponse(
                    _stream_tool_calls(tool_call["tool_calls"], model),
                    media_type="text/event-stream",
                )
            fallback = _fallback_tool_call(last_user, allowed_tools, tool_params_by_name) if actionable else None
            if fallback:
                return StreamingResponse(_stream_tool_calls(fallback["tool_calls"], model), media_type="text/event-stream")
            # fallback to content (or error)
            return StreamingResponse(_stream_content(full_text or "Unable to generate tool call. Please retry.", model), media_type="text/event-stream")
        return StreamingResponse(
            _stream_glm_response(client, chat_id, glm_messages, generation_params, model, parent_id),
            media_type="text/event-stream",
        )

    if tools:
        attempt_messages = list(glm_messages)
        if actionable:
            attempt_messages = [
                {
                    "role": "system",
                    "content": (
                        "Return ONLY valid JSON for a tool call, with fully closed strings. "
                        "No extra text."
                    ),
                }
            ] + attempt_messages

        full_text = _collect_glm_response(client, chat_id, attempt_messages, generation_params, parent_id)
        tool_call = _extract_tool_call(full_text, allowed_tools, tool_params_by_name)
        if not tool_call:
            tool_call = _extract_partial_tool_call(full_text, allowed_tools, tool_params_by_name)
        if tool_call and not _is_valid_write_call(last_user, tool_call["tool_calls"]):
            repaired = _fallback_read_call(last_user_raw, allowed_tools, tool_params_by_name)
            if repaired:
                tool_call = repaired
            else:
                tool_call = None
        if tool_call and _is_valid_write_call(last_user, tool_call["tool_calls"]):
            return JSONResponse(_openai_tool_response(tool_call["tool_calls"], model))

        fallback = _fallback_tool_call(last_user, allowed_tools, tool_params_by_name) if actionable else None
        if fallback:
            return JSONResponse(_openai_tool_response(fallback["tool_calls"], model))
        return JSONResponse(_openai_response(full_text, model))

    full_text = _collect_glm_response(client, chat_id, glm_messages, generation_params, parent_id)
    return JSONResponse(_openai_response(full_text, model))


@app.get("/")
def root():
    return {"status": "ok", "message": "GLM proxy is running"}
