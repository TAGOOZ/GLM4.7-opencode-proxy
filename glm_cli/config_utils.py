"""Shared config/env helpers for GLM CLI and proxy."""

import json
import os
from pathlib import Path
from typing import Dict

CONFIG_DIR = Path.home() / ".config" / "glm-cli"
CONFIG_FILE = CONFIG_DIR / "config.json"
LEGACY_MUTATION_ENV = "GLM_PY_LEGACY_ENABLE_MUTATIONS"
LEGACY_TOOL_ENV = "GLM_PY_LEGACY_ENABLE_TOOLS"


def _dotenv_paths() -> list[Path]:
    repo_root = Path(__file__).resolve().parent.parent
    return [repo_root / ".env", CONFIG_DIR.parent / ".env"]


def load_dotenv() -> None:
    try:
        from dotenv import load_dotenv
    except Exception:
        return
    load_dotenv()
    for path in _dotenv_paths():
        load_dotenv(str(path))


def load_config() -> Dict[str, object]:
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, encoding="utf-8") as f:
            return json.load(f)
    return {}


def save_config(config: Dict[str, object]) -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def load_token() -> str:
    load_dotenv()
    token = os.getenv("GLM_TOKEN")
    if token:
        return token
    config = load_config()
    token = config.get("token")
    if not token:
        raise RuntimeError("Missing GLM token. Run: glm config --token YOUR_TOKEN")
    return str(token)


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def legacy_mutations_enabled() -> bool:
    """Whether legacy Python mutation/auth commands are enabled."""
    load_dotenv()
    return _env_bool(LEGACY_MUTATION_ENV, default=False)


def legacy_tools_enabled() -> bool:
    """
    Whether legacy Python proxy tool-call emission is enabled.

    Tool emission is always gated by legacy mutation mode.
    """
    load_dotenv()
    return legacy_mutations_enabled() and _env_bool(LEGACY_TOOL_ENV, default=False)
