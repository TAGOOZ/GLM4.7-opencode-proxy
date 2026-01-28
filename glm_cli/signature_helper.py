"""
Signature Helper - Generates valid X-Signature headers for chat.z.ai

Based on reverse engineering of prod-fe-1.0.207 D7cS9ggl.js:
- Ma() builds sortedPayload: Object.entries({timestamp,requestId,user_id})
  sorted by key name and joined by ",". Each entry stringifies to "key,value".
- aE(sortedPayload, prompt, timestamp) signs:
    data = "{sortedPayload}|{base64(utf8(prompt))}|{timestamp_ms}"
    subkey = HMAC-SHA256(KEY_STRING, str(floor(timestamp_ms/300000))) -> hex string
    signature = HMAC-SHA256(subkey_hex_string, data) -> hex string
"""

import base64
import hashlib
import hmac
import time
import uuid
from typing import Any, Dict, Optional


# Static key string decoded from D7cS9ggl.js (aE)
SIGNATURE_KEY = "key-@@@@)))()((9))-xxxx&&&%%%%%"


def _hmac_sha256_hex(key: str, message: str) -> str:
    """Return hex digest for HMAC-SHA256 with string key/message."""
    return hmac.new(
        key.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()


def _prompt_b64(prompt: str) -> str:
    """Base64 of UTF-8 prompt bytes (matches TextEncoder + btoa)."""
    return base64.b64encode(prompt.encode("utf-8")).decode("utf-8")


def build_sorted_payload(
    timestamp: int,
    request_id: str,
    user_id: str
) -> str:
    """Build sortedPayload string matching the frontend implementation."""
    items = {
        "timestamp": str(timestamp),
        "requestId": request_id,
        "user_id": user_id
    }
    ordered = sorted(items.items(), key=lambda kv: kv[0])
    flat = []
    for key, value in ordered:
        flat.append(key)
        flat.append(str(value))
    return ",".join(flat)


def generate_signature(
    sorted_payload: str,
    prompt: str,
    timestamp: int
) -> str:
    """
    Generate X-Signature based on the current production JS algorithm.

    Args:
        request_id: UUID for the request
        prompt: The message prompt (signature_prompt)
        timestamp: Unix timestamp in milliseconds

    Returns:
        Hex digest of the signature
    """
    time_window = int(timestamp) // 300000  # 5 minute windows
    subkey_hex = _hmac_sha256_hex(SIGNATURE_KEY, str(time_window))
    data_to_sign = f"{sorted_payload}|{_prompt_b64(prompt)}|{timestamp}"
    return _hmac_sha256_hex(subkey_hex, data_to_sign)


def generate_request_params(
    prompt: str,
    user_id: str,
    timestamp: Optional[int] = None,
    request_id: Optional[str] = None
) -> Dict[str, Any]:
    """
    Generate all required request parameters including signature.

    Returns dict with: timestamp, request_id, signature
    """
    ts = timestamp if timestamp is not None else int(time.time() * 1000)
    rid = request_id if request_id is not None else str(uuid.uuid4())
    sorted_payload = build_sorted_payload(ts, rid, user_id)
    signature = generate_signature(sorted_payload, prompt, ts)
    return {
        "timestamp": ts,
        "request_id": rid,
        "signature": signature,
        "sorted_payload": sorted_payload,
        "success": True
    }


def get_signature_sync(prompt: str, user_id: str = "") -> Dict[str, Any]:
    """Sync helper used by GLMClient (browser signature fallback)."""
    try:
        return generate_request_params(prompt, user_id)
    except Exception as exc:
        return {"success": False, "error": str(exc)}


if __name__ == "__main__":
    import sys

    prompt = sys.argv[1] if len(sys.argv) > 1 else "hello"
    print(f"Generating signature for prompt: '{prompt}'")
    result = generate_request_params(prompt, user_id="00000000-0000-0000-0000-000000000000")

    print("✅ Generated:")
    print(f"   Timestamp: {result['timestamp']}")
    print(f"   Request ID: {result['request_id']}")
    print(f"   Signature: {result['signature']}")
