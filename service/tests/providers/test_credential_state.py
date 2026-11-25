import json
import sqlite3
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from tokengrill.core.config import new_provider
from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, ProviderKind
from tokengrill.providers.credential_state import credential_state


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    root = tmp_path / "home"
    root.mkdir()
    monkeypatch.setenv("HOME", str(root))
    for name in ("CONFIG", "DATA", "STATE", "CACHE"):
        monkeypatch.setenv(f"XDG_{name}_HOME", str(root / f".xdg-{name.lower()}"))
    yield root


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def account(kind: ProviderKind, app: str, folder: str) -> ProviderInstance:
    return new_provider(kind, app, f"~/{folder}")  # type: ignore[arg-type]


def jwt(expiry: float) -> str:
    import base64

    def part(value: dict[str, object]) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip("=")

    return f"{part({'alg': 'none'})}.{part({'exp': expiry})}.sig"


async def test_codex_states(home: Path) -> None:
    instance = account("codex", "codex-cli", ".codex")
    assert await credential_state(instance) == "login-required"
    write(home / ".codex" / "auth.json", "not json")
    assert await credential_state(instance) == "unreadable"
    write(home / ".codex" / "auth.json", json.dumps({"tokens": {"access_token": jwt(time.time() - 100)}}))
    assert await credential_state(instance) == "expired"
    write(home / ".codex" / "auth.json", json.dumps({"tokens": {"access_token": jwt(time.time() + 1000)}}))
    assert await credential_state(instance) == "authenticated"


async def test_claude_states(home: Path) -> None:
    instance = account("claude", "claude-code", ".claude")
    assert await credential_state(instance) == "login-required"
    past = int((time.time() - 100) * 1000)
    write(
        home / ".claude" / ".credentials.json", json.dumps({"claudeAiOauth": {"accessToken": "t", "expiresAt": past}})
    )
    assert await credential_state(instance) == "expired"
    write(home / ".claude" / ".credentials.json", json.dumps({"claudeAiOauth": {"accessToken": "t"}}))
    assert await credential_state(instance) == "authenticated"


async def test_open_code_go_and_deepseek_read_the_open_code_file(home: Path) -> None:
    go = account("opencode-go", "opencode", ".x")
    deepseek = account("deepseek", "opencode", ".x")
    assert await credential_state(go) == "login-required"
    write(home / ".xdg-data" / "opencode" / "auth.json", json.dumps({"opencode-go": {"type": "api", "key": "k"}}))
    assert await credential_state(go) == "authenticated"
    assert await credential_state(deepseek) == "login-required"


async def test_deepseek_claude_settings_and_kimi(home: Path) -> None:
    deepseek = account("deepseek", "claude-settings", ".claude")
    write(
        home / ".claude" / "settings.json",
        json.dumps({"env": {"ANTHROPIC_BASE_URL": "https://api.deepseek.com/x", "ANTHROPIC_AUTH_TOKEN": "k"}}),
    )
    assert await credential_state(deepseek) == "authenticated"
    kimi = account("kimi", "kimi-cli", ".kimi-code")
    assert await credential_state(kimi) == "login-required"
    write(home / ".kimi-code" / "credentials" / "kimi-code.json", json.dumps({"access_token": "t"}))
    assert await credential_state(kimi) == "authenticated"


async def test_keyring_unavailable_maps_the_dependency_error(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def locked(*_args: object, **_kwargs: object) -> str | None:
        raise ServiceError("dependency", "deepseek.keyring-unavailable")

    monkeypatch.setattr("tokengrill.providers.deepseek.auth.lookup_secret", locked)
    instance = account("deepseek", "keyring", ".x")
    assert await credential_state(instance) == "keyring-unavailable"


async def test_kiro_and_cursor_databases(home: Path) -> None:
    kiro = account("kiro", "kiro-cli", ".xdg-data/kiro-cli")
    assert await credential_state(kiro) == "login-required"
    database = home / ".xdg-data" / "kiro-cli" / "data.sqlite3"
    database.parent.mkdir(parents=True)
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE unrelated (x TEXT)")
    connection.commit()
    connection.close()
    assert await credential_state(kiro) == "database-unreadable"

    cursor = account("cursor", "cursor", ".xdg-config/Cursor")
    assert await credential_state(cursor) == "login-required"
    state = home / ".xdg-config" / "Cursor" / "User" / "globalStorage" / "state.vscdb"
    state.parent.mkdir(parents=True)
    connection = sqlite3.connect(state)
    connection.execute("CREATE TABLE ItemTable (key TEXT, value TEXT)")
    connection.execute("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ?)", (jwt(time.time() + 1000),))
    connection.commit()
    connection.close()
    assert await credential_state(cursor) == "authenticated"


async def test_antigravity_without_credentials_needs_a_login(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def none() -> None:
        return None

    monkeypatch.setattr("tokengrill.providers.antigravity.auth.lookup_agy_keyring_token", none)
    instance = account("antigravity", "antigravity", ".gemini/antigravity-cli")
    assert await credential_state(instance) == "login-required"
