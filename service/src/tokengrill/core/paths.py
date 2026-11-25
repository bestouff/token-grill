"""Account folders and the XDG locations of Token Grill, as GLib names them."""

import os
import posixpath
import re
from pathlib import Path

from tokengrill.core.types import ProviderInstance, ProviderKind, ProviderPaths

_DEFAULT_HOMES: dict[ProviderKind, list[str]] = {
    "codex": [".codex"],
    "claude": [".claude"],
    "kiro": [],
    "antigravity": [".gemini", "antigravity-cli"],
    "copilot": [],
    "opencode-go": [],
    "deepseek": [".claude"],
    "kimi": [".kimi-code"],
    "cursor": [],
}

# Antigravity tools have written their OAuth credentials under each of these names.
_ANTIGRAVITY_AUTH_FILES = ["acp_token.json", "oauth_creds.json", "credentials.json"]

_AUTH_FILES: dict[ProviderKind, str] = {
    "codex": "auth.json",
    "claude": ".credentials.json",
    "kiro": "data.sqlite3",
    "antigravity": "acp_token.json",
    "copilot": "hosts.yml",
    "opencode-go": "auth.json",
    "deepseek": "settings.json",
    "kimi": "credentials/kimi-code.json",
    "cursor": "User/globalStorage/state.vscdb",
}

_HISTORY_DIRECTORIES: dict[ProviderKind, list[str]] = {
    "codex": ["sessions", "archived_sessions"],
    "claude": ["projects"],
    "kiro": [],
    "antigravity": [],
    "copilot": [],
    "opencode-go": [],
    "deepseek": [],
    "kimi": [],
    "cursor": [],
}

_APP_DIRECTORY = "token-grill"


def _home() -> str:
    return str(Path.home())


def _build(*parts: str) -> str:
    """g_build_filenamev: join and collapse repeated separators, keep dots."""
    joined = re.sub(r"/+", "/", "/".join(part for part in parts if part))
    return joined if joined == "/" else joined.rstrip("/")


def _xdg(name: str, fallback: tuple[str, ...]) -> str:
    value = os.environ.get(name, "")
    return value if value.startswith("/") else _build(_home(), *fallback)


def _user_config_dir() -> str:
    return _xdg("XDG_CONFIG_HOME", (".config",))


def _user_data_dir() -> str:
    return _xdg("XDG_DATA_HOME", (".local", "share"))


def config_dir() -> Path:
    return Path(_user_config_dir()) / _APP_DIRECTORY


def data_dir() -> Path:
    return Path(_user_data_dir()) / _APP_DIRECTORY


def state_dir() -> Path:
    return Path(_xdg("XDG_STATE_HOME", (".local", "state"))) / _APP_DIRECTORY


def runtime_dir() -> Path:
    """GLib falls back to the user cache folder, which is private to the user."""
    base = os.environ.get("XDG_RUNTIME_DIR", "")
    return Path(base if base.startswith("/") else _xdg("XDG_CACHE_HOME", (".cache",))) / _APP_DIRECTORY


def expand_path(value: str) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("A path is required.")
    if trimmed.startswith("~/"):
        return _build(_home(), trimmed[2:])
    if not trimmed.startswith("/"):
        raise ValueError("Paths must be absolute or start with ~/.")
    return _build(posixpath.normpath(trimmed))


def display_path(value: str) -> str:
    home = _home()
    if value == home:
        return "~"
    if value.startswith(f"{home}/"):
        return f"~/{value[len(home) + 1 :]}"
    return value


def default_home(kind: ProviderKind) -> str:
    if kind == "kiro":
        return _build(_user_data_dir(), "kiro-cli")
    if kind == "opencode-go":
        return _build(_user_data_dir(), "opencode")
    if kind == "cursor":
        return _build(_user_config_dir(), "Cursor")
    # The GitHub CLI follows XDG_CONFIG_HOME.
    if kind == "copilot":
        return _build(_user_config_dir(), "gh")
    return _build(_home(), *_DEFAULT_HOMES[kind])


def cursor_agent_home() -> str:
    """The Cursor CLI keeps its sign-in apart from the Cursor app, in a lower-case folder."""
    return _build(_user_config_dir(), "cursor")


def open_code_auth_path() -> str:
    return _build(_user_data_dir(), "opencode", "auth.json")


def provider_paths(instance: ProviderInstance) -> ProviderPaths:
    """Normalized providers always hold valid paths, so this never raises for them."""
    if instance["app"] == "opencode":
        return {"authFile": open_code_auth_path(), "historyDirectories": []}
    # A pasted key lives in the keyring; there is no file to read.
    if instance["app"] == "keyring":
        return {"authFile": "", "historyDirectories": []}
    home = expand_path(instance["accountHome"])
    auth_name = "auth.json" if instance["app"] == "cursor-agent" else _AUTH_FILES[instance["kind"]]
    auth_override = instance["authFileOverride"]
    auth_file = expand_path(auth_override) if auth_override else _build(home, auth_name)
    sessions_override = instance["sessionsDirectoryOverride"]
    history = (
        [expand_path(sessions_override)]
        if sessions_override
        else [_build(home, name) for name in _HISTORY_DIRECTORIES[instance["kind"]]]
    )
    return {"authFile": auth_file, "historyDirectories": history}


def auth_file_candidates(instance: ProviderInstance) -> list[str]:
    """The files tried for an account's credentials, in order of preference."""
    if instance["kind"] != "antigravity" or instance["authFileOverride"]:
        return [provider_paths(instance)["authFile"]]
    home = expand_path(instance["accountHome"])
    return [_build(home, name) for name in _ANTIGRAVITY_AUTH_FILES]


def path_exists(path: str) -> bool:
    return os.path.exists(path)
