"""API Client for chat.z.ai GLM4.7"""

import json
import time
import uuid
import re
from typing import Optional, Dict, Any, Generator, List
from datetime import datetime
from urllib.parse import urlencode

import requests

from .models import Chat
from .jwt_utils import get_user_id_from_token

USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36"

class GLMClient:
    """Client for interacting with the GLM4.7 API at chat.z.ai"""
    
    BASE_URL = "https://chat.z.ai"
    
    def __init__(self, token: str):
        """Initialize client with authentication token"""
        self.token = token
        self.session = requests.Session()
        self._setup_session()
    
    def _setup_session(self):
        """Configure session with default headers"""
        self.session.headers.update({
            "Accept": "application/json",
            "Accept-Language": "en-US",
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
            "Origin": self.BASE_URL,
            "Referer": f"{self.BASE_URL}/",
            "sec-ch-ua": '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Linux"',
        })
        self.session.cookies.set("token", self.token, domain="chat.z.ai")

    def get_chat(self, chat_id: str) -> Dict[str, Any]:
        """Fetch full chat details including history."""
        response = self.session.get(f"{self.BASE_URL}/api/v1/chats/{chat_id}")
        response.raise_for_status()
        return response.json()

    def get_current_message_id(self, chat_id: str) -> Optional[str]:
        """Get the current message id for a chat (used to thread new messages)."""
        data = self.get_chat(chat_id)
        history = data.get("chat", {}).get("history", {})
        return history.get("currentId")

    def _history_to_messages(self, history: Dict[str, Any]) -> Dict[str, Any]:
        """Convert chat history tree to a linear message list."""
        messages_map = history.get("messages", {})
        current_id = history.get("currentId")
        if not current_id or current_id not in messages_map:
            return {"messages": [], "current_id": None}

        chain_ids = []
        cursor = current_id
        while cursor and cursor in messages_map:
            chain_ids.append(cursor)
            cursor = messages_map[cursor].get("parentId")

        ordered = list(reversed(chain_ids))
        messages = []
        for msg_id in ordered:
            msg = messages_map[msg_id]
            role = msg.get("role")
            content = msg.get("content", "")
            if role and content is not None:
                messages.append({"role": role, "content": content})

        return {"messages": messages, "current_id": current_id}
    
    def _generate_signature(self, timestamp: int, prompt: str, request_id: str, user_id: str) -> str:
        """Generate X-Signature header using the latest JS algorithm."""
        from .signature_helper import build_sorted_payload, generate_signature
        sorted_payload = build_sorted_payload(timestamp, request_id, user_id)
        return generate_signature(sorted_payload, prompt, timestamp)
    
    def _generate_signature_browser(self, prompt: str, user_id: str) -> dict:
        """
        Generate signature using the local JS-equivalent helper.

        Returns dict with: signature, timestamp, request_id
        """
        from .signature_helper import get_signature_sync
        return get_signature_sync(prompt, user_id=user_id)
    
    def _build_completion_params(
        self,
        chat_id: str,
        timestamp: int,
        request_id: str,
        user_id: str
    ) -> Dict[str, str]:
        """Build query parameters for chat completions endpoint"""
        now = datetime.now()
        utc_now = datetime.utcnow()
        try:
            tz_offset_min = int(-now.astimezone().utcoffset().total_seconds() // 60)
        except Exception:
            tz_offset_min = 0

        params = {
            "timestamp": str(timestamp),
            "requestId": request_id,
            "user_id": user_id,
            "version": "0.0.1",
            "platform": "web",
            "token": self.token,
            "user_agent": USER_AGENT,
            "language": "en-US",
            "languages": "en-US,en",
            "timezone": "UTC",
            "cookie_enabled": "true",
            "screen_width": "1920",
            "screen_height": "1080",
            "screen_resolution": "1920x1080",
            "viewport_height": "927",
            "viewport_width": "1047",
            "viewport_size": "1047x927",
            "color_depth": "24",
            "pixel_ratio": "1",
            "current_url": f"https://chat.z.ai/c/{chat_id}",
            "pathname": f"/c/{chat_id}",
            "search": "",
            "hash": "",
            "host": "chat.z.ai",
            "hostname": "chat.z.ai",
            "protocol": "https:",
            "referrer": "https://chat.z.ai/",
            "title": "Z.ai Chat - Free AI powered by GLM-4.7 & GLM-4.6",
            "timezone_offset": str(tz_offset_min),
            "local_time": utc_now.isoformat(timespec="milliseconds") + "Z",
            "utc_time": utc_now.strftime("%a, %d %b %Y %H:%M:%S GMT"),
            "is_mobile": "false",
            "is_touch": "false",
            "max_touch_points": "0",
            "browser_name": "Chrome",
            "os_name": "Linux",
        }

        # Keep signature_timestamp at the end to mirror frontend behavior
        params["signature_timestamp"] = str(timestamp)
        return params
    
    def get_user_settings(self) -> Dict[str, Any]:
        """Fetch user settings"""
        response = self.session.get(f"{self.BASE_URL}/api/v1/users/user/settings")
        response.raise_for_status()
        return response.json()
    
    def list_chats(self, page: int = 1) -> List[Chat]:
        """List all chats (paginated)"""
        response = self.session.get(
            f"{self.BASE_URL}/api/v1/chats/",
            params={"page": page}
        )
        response.raise_for_status()
        data = response.json()
        
        chats = []
        for item in data if isinstance(data, list) else data.get("chats", []):
            chats.append(Chat.from_api_response(item))
        return chats
    
    def create_chat(self, title: str = "New Chat", model: str = "glm-4.7", 
                    initial_message: Optional[str] = None) -> Chat:
        """Create a new chat session"""
        timestamp = int(time.time() * 1000)
        message_id = str(uuid.uuid4())
        
        history = {"messages": {}, "currentId": None}
        
        if initial_message:
            history["messages"][message_id] = {
                "id": message_id,
                "parentId": None,
                "childrenIds": [],
                "role": "user",
                "content": initial_message,
                "timestamp": timestamp // 1000,
                "models": [model]
            }
            history["currentId"] = message_id
        
        payload = {
            "chat": {
                "id": "",
                "title": title,
                "models": [model],
                "params": {},
                "history": history,
                "tags": [],
                "flags": [],
                "features": [
                    {"type": "mcp", "server": "vibe-coding", "status": "hidden"},
                    {"type": "mcp", "server": "ppt-maker", "status": "hidden"},
                    {"type": "mcp", "server": "image-search", "status": "hidden"},
                    {"type": "mcp", "server": "deep-research", "status": "hidden"},
                    {"type": "tool_selector", "server": "tool_selector", "status": "hidden"}
                ],
                "mcp_servers": [],
                "enable_thinking": True,
                "auto_web_search": False,
                "timestamp": timestamp
            }
        }
        
        response = self.session.post(
            f"{self.BASE_URL}/api/v1/chats/new",
            json=payload
        )
        response.raise_for_status()
        data = response.json()
        return Chat.from_api_response(data)
    
    def send_message(
        self,
        chat_id: str,
        messages: List[Dict[str, str]],
        model: str = "glm-4.7",
        stream: bool = True,
        enable_thinking: bool = True,
        manual_signature: Optional[str] = None,
        manual_timestamp: Optional[int] = None,
        manual_request_id: Optional[str] = None,
        use_browser_signature: bool = True,
        include_history: bool = True,
        parent_message_id: Optional[str] = None,
        generation_params: Optional[Dict[str, Any]] = None
    ) -> Generator[Dict[str, Any], None, None]:
        """
        Send a message and stream the response.
        
        Yields dictionaries with keys:
        - type: 'thinking', 'content', 'done', 'error'
        - data: the content string
        
        If manual_signature is provided, it will be used instead of generated signature.
        If use_browser_signature is True (default), uses the JS-equivalent helper.
        """
        prompt = messages[-1]["content"] if messages else ""
        
        # Extract user_id from token (JWT payload)
        user_id = get_user_id_from_token(self.token)

        # Use manual signature if provided
        if manual_signature:
            timestamp = manual_timestamp if manual_timestamp else int(time.time() * 1000)
            request_id = manual_request_id if manual_request_id else str(uuid.uuid4())
            signature = manual_signature
        elif use_browser_signature:
            # Use JS-equivalent signature generation (most reliable)
            sig_data = self._generate_signature_browser(prompt, user_id)
            if not sig_data.get("success"):
                raise Exception(f"Failed to generate signature: {sig_data.get('error')}")
            signature = sig_data["signature"]
            timestamp = int(sig_data["timestamp"])
            request_id = sig_data["request_id"]
        else:
            # Use Python HMAC implementation (should match JS)
            timestamp = int(time.time() * 1000)
            request_id = str(uuid.uuid4())
            signature = self._generate_signature(timestamp, prompt, request_id, user_id)
        
        current_message_id = str(uuid.uuid4())

        history_messages = []
        resolved_parent_id = parent_message_id
        if include_history:
            try:
                chat_data = self.get_chat(chat_id)
                history = chat_data.get("chat", {}).get("history", {})
                history_data = self._history_to_messages(history)
                history_messages = history_data["messages"]
                if resolved_parent_id is None:
                    resolved_parent_id = history_data["current_id"]
            except Exception:
                history_messages = []
                if resolved_parent_id is None:
                    resolved_parent_id = None
        
        now = datetime.now()
        payload = {
            "stream": stream,
            "model": model,
            "messages": history_messages + messages,
            "signature_prompt": prompt,
            "params": generation_params or {},
            "extra": {},
            "features": {
                "image_generation": False,
                "web_search": False,
                "auto_web_search": False,
                "preview_mode": True,
                "flags": [],
                "enable_thinking": enable_thinking
            },
            "variables": {
                "{{USER_NAME}}": "CLI User",
                "{{USER_LOCATION}}": "Unknown",
                "{{CURRENT_DATETIME}}": now.strftime("%Y-%m-%d %H:%M:%S"),
                "{{CURRENT_DATE}}": now.strftime("%Y-%m-%d"),
                "{{CURRENT_TIME}}": now.strftime("%H:%M:%S"),
                "{{CURRENT_WEEKDAY}}": now.strftime("%A"),
                "{{CURRENT_TIMEZONE}}": "UTC",
                "{{USER_LANGUAGE}}": "en-US"
            },
            "chat_id": chat_id,
            "id": str(uuid.uuid4()),
            "current_user_message_id": current_message_id,
            "current_user_message_parent_id": resolved_parent_id
        }
        
        # Build query params
        params = self._build_completion_params(
            chat_id=chat_id,
            timestamp=timestamp,
            request_id=request_id,
            user_id=user_id
        )
        
        url = f"{self.BASE_URL}/api/v2/chat/completions?{urlencode(params)}"
        
        headers = dict(self.session.headers)
        headers["Accept"] = "*/*"
        headers["X-Signature"] = signature
        headers["X-FE-Version"] = "prod-fe-1.0.207"
        
        try:
            response = self.session.post(
                url,
                json=payload,
                headers=headers,
                stream=True
            )
            response.raise_for_status()
            
            # Parse SSE stream
            in_thinking = False
            
            for line in response.iter_lines(decode_unicode=True):
                if not line:
                    continue
                    
                if line.startswith("data: "):
                    data_str = line[6:]
                    
                    if data_str == "[DONE]":
                        yield {"type": "done", "data": ""}
                        break
                    
                    try:
                        data = json.loads(data_str)

                        if "choices" in data:
                            for choice in data["choices"]:
                                delta = choice.get("delta", {})
                                content = delta.get("content", "")
                                if content:
                                    # Check for thinking tags
                                    # Handle <think> with optional attributes
                                    think_match = re.search(r"<think(?: [^>]*)?>", content)
                                    if think_match:
                                        in_thinking = True
                                        content = content.replace(think_match.group(0), "")
                                    
                                    if "</think>" in content:
                                        in_thinking = False
                                        parts = content.split("</think>")
                                        if parts[0]:
                                            yield {"type": "thinking", "data": parts[0]}
                                        yield {"type": "thinking_end", "data": ""}
                                        if len(parts) > 1 and parts[1]:
                                            yield {"type": "content", "data": parts[1]}
                                        continue

                                    if in_thinking:
                                        yield {"type": "thinking", "data": content}
                                    else:
                                        yield {"type": "content", "data": content}
                            continue

                        # New SSE format from chat.z.ai
                        if data.get("type") == "chat:completion":
                            delta = data.get("data", {})
                            content = delta.get("delta_content", "") or delta.get("content", "")
                            phase = delta.get("phase")
                            if phase == "thinking":
                                in_thinking = True
                            elif phase in ("answer", "other", "done"):
                                if in_thinking:
                                    in_thinking = False
                                    yield {"type": "thinking_end", "data": ""}
                                if phase == "done":
                                    yield {"type": "done", "data": ""}
                                    continue

                            if content:
                                # Split on reasoning tags so content after </details> is treated as final
                                parts = re.split(r"(<details[^>]*>|</details>)", content)
                                for part in parts:
                                    if not part:
                                        continue
                                    if part.startswith("<details"):
                                        in_thinking = True
                                        continue
                                    if part == "</details>":
                                        if in_thinking:
                                            in_thinking = False
                                            yield {"type": "thinking_end", "data": ""}
                                        continue

                                    if in_thinking:
                                        yield {"type": "thinking", "data": part}
                                    else:
                                        yield {"type": "content", "data": part}
                            continue
                    except json.JSONDecodeError:
                        continue
                        
        except requests.RequestException as e:
            yield {"type": "error", "data": str(e)}
    
    def update_chat(self, chat_id: str, messages_history: Dict[str, Any]) -> bool:
        """Update chat with new messages"""
        # This would update the chat history on the server
        # Implementation depends on API requirements
        return True
