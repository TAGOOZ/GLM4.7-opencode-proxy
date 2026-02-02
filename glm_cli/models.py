"""Data models for GLM API"""

from dataclasses import dataclass, field
from typing import Optional, List, Dict, Any
from datetime import datetime
import uuid


@dataclass
class Message:
    """Represents a chat message"""
    role: str  # 'user' or 'assistant'
    content: str
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    parent_id: Optional[str] = None
    timestamp: Optional[int] = None
    models: List[str] = field(default_factory=lambda: ["glm-4.7"])

    def to_api_format(self) -> Dict[str, str]:
        """Convert to API message format"""
        return {"role": self.role, "content": self.content}

    def to_history_format(self) -> Dict[str, Any]:
        """Convert to chat history format"""
        return {
            "id": self.id,
            "parentId": self.parent_id,
            "childrenIds": [],
            "role": self.role,
            "content": self.content,
            "timestamp": self.timestamp or int(datetime.now().timestamp()),
            "models": self.models
        }


@dataclass
class Chat:
    """Represents a chat session"""
    id: str
    title: str
    models: List[str] = field(default_factory=lambda: ["glm-4.7"])
    created_at: Optional[int] = None
    updated_at: Optional[int] = None

    @classmethod
    def from_api_response(cls, data: Dict[str, Any]) -> "Chat":
        """Create Chat from API response"""
        return cls(
            id=data.get("id", ""),
            title=data.get("title", "New Chat"),
            models=data.get("models", ["glm-4.7"]),
            created_at=data.get("created_at"),
            updated_at=data.get("updated_at")
        )


@dataclass
class ChatCompletionRequest:
    """Request payload for chat completions"""
    chat_id: str
    messages: List[Message]
    model: str = "glm-4.7"
    stream: bool = True
    enable_thinking: bool = True
    
    def to_payload(self, current_message_id: str, parent_message_id: Optional[str] = None) -> Dict[str, Any]:
        """Convert to API request payload"""
        now = datetime.now()
        return {
            "stream": self.stream,
            "model": self.model,
            "messages": [msg.to_api_format() for msg in self.messages],
            "signature_prompt": self.messages[-1].content if self.messages else "",
            "params": {},
            "extra": {},
            "features": {
                "image_generation": False,
                "web_search": False,
                "auto_web_search": False,
                "preview_mode": True,
                "flags": [],
                "enable_thinking": self.enable_thinking
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
            "chat_id": self.chat_id,
            "id": str(uuid.uuid4()),
            "current_user_message_id": current_message_id,
            "current_user_message_parent_id": parent_message_id
        }
