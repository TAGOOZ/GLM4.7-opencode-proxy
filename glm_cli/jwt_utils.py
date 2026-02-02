"""JWT helpers for decoding chat.z.ai tokens."""

import base64
import json
from typing import Any, Dict, Optional


def decode_jwt_payload(token: str) -> Optional[Dict[str, Any]]:
    """Decode the JWT payload, returning dict or None on failure."""
    try:
        payload_part = token.split(".")[1]
        payload_part += "=" * (4 - len(payload_part) % 4)
        return json.loads(base64.urlsafe_b64decode(payload_part))
    except Exception:
        return None


def get_user_id_from_token(token: str) -> str:
    """Extract the user id from a JWT token, or empty string."""
    payload = decode_jwt_payload(token)
    if isinstance(payload, dict):
        user_id = payload.get("id")
        if isinstance(user_id, str):
            return user_id
    return ""
