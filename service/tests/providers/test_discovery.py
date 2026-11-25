import json
import os
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from tokengrill.core.config import new_provider
from tokengrill.core.types import ProviderInstance
from tokengrill.providers.candidates import Candidate
from tokengrill.providers.discovery import (
    antigravity_homes,
    cli_homes,
    cursor_agent_homes,
    cursor_homes,
    find_all_candidates,
    find_candidates,
    github_cli_homes,
    home_name,
    kimi_homes,
    kiro_homes,
)

SECRET = "sk-secret-token-0123456789"


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    root = tmp_path / "home"
    root.mkdir()
    monkeypatch.setenv("HOME", str(root))
    for name in ("CONFIG", "DATA", "STATE", "CACHE"):
        monkeypatch.setenv(f"XDG_{name}_HOME", str(root / f".xdg-{name.lower()}"))
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    yield root


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def codex_auth(account_id: str) -> str:
    return json.dumps({"tokens": {"access_token": SECRET, "refresh_token": SECRET, "account_id": account_id}})


def snapshot_tree(root: Path) -> dict[str, float]:
    return {str(path): path.stat().st_mtime_ns for path in sorted(root.rglob("*"))}


def test_home_name_uses_the_suffix_of_a_second_home() -> None:
    assert home_name("codex", ".codex-work") == "Codex-work"
    assert home_name("codex", ".codex") == "Codex"
    assert home_name("claude", "elsewhere") == "Claude"


def test_cli_homes_find_prefixed_folders_with_credentials_or_history(home: Path) -> None:
    write(home / ".codex" / "auth.json", codex_auth("a"))
    write(home / ".codex-work" / "auth.json", codex_auth("b"))
    (home / ".codex-empty").mkdir()
    (home / ".codex-sessions" / "sessions").mkdir(parents=True)
    (home / ".codexfile").write_text("x", encoding="utf-8")
    found = cli_homes("codex")
    assert [item["accountHome"] for item in found] == ["~/.codex", "~/.codex-sessions", "~/.codex-work"]
    assert [item["displayName"] for item in found] == ["Codex", "Codex-sessions", "Codex-work"]
    assert all(item["app"] == "codex-cli" for item in found)


def test_cli_homes_for_claude(home: Path) -> None:
    write(home / ".claude-alt" / ".credentials.json", "{}")
    assert [item["accountHome"] for item in cli_homes("claude")] == ["~/.claude-alt"]
    assert cli_homes("codex") == []


def test_single_homes_need_their_credential_file(home: Path) -> None:
    assert kiro_homes() == kimi_homes() == cursor_homes() == cursor_agent_homes() == github_cli_homes() == []
    write(home / ".xdg-data" / "kiro-cli" / "data.sqlite3", "")
    write(home / ".kimi-code" / "credentials" / "kimi-code.json", "{}")
    write(home / ".xdg-config" / "Cursor" / "User" / "globalStorage" / "state.vscdb", "")
    write(home / ".xdg-config" / "cursor" / "auth.json", "{}")
    write(home / ".xdg-config" / "gh" / "hosts.yml", "")
    assert [item["app"] for item in kiro_homes()] == ["kiro-cli"]
    assert [item["app"] for item in kimi_homes()] == ["kimi-cli"]
    assert [item["app"] for item in cursor_homes()] == ["cursor"]
    assert [item["app"] for item in cursor_agent_homes()] == ["cursor-agent"]
    assert [item["app"] for item in github_cli_homes()] == ["github-cli"]


def test_antigravity_homes_use_the_agy_markers_and_credential_files(home: Path) -> None:
    assert antigravity_homes() == []
    write(home / ".gemini" / "antigravity-cli" / "installation_id", "x")
    write(home / ".antigravity" / "oauth_creds.json", "{}")
    (home / ".gemini" / "antigravity").mkdir(parents=True)
    assert [item["accountHome"] for item in antigravity_homes()] == [
        str(home / ".gemini" / "antigravity-cli"),
        str(home / ".antigravity"),
    ]


async def test_find_candidates_marks_added_homes_and_duplicates(home: Path) -> None:
    write(home / ".codex" / "auth.json", codex_auth("acct-1"))
    write(home / ".codex-work" / "auth.json", codex_auth("acct-1"))
    added = new_provider("codex", "codex-cli", "~/.codex")
    found = await find_candidates("codex-cli", [added])
    by_home = {item["accountHome"]: item for item in found}
    assert by_home["~/.codex"]["status"] == "already-added"
    assert by_home["~/.codex-work"]["status"] == "ready"
    assert by_home["~/.codex-work"]["duplicateOf"] == added["id"]
    assert [item["status"] for item in found] == ["ready", "already-added"]


async def test_find_candidates_reads_open_code_entries(home: Path) -> None:
    auth = {
        "openai": {"type": "oauth", "access": SECRET, "refresh": SECRET, "accountId": "acct-1"},
        "deepseek": {"type": "api", "key": SECRET},
        "other": {"type": "api", "key": SECRET},
    }
    write(home / ".xdg-data" / "opencode" / "auth.json", json.dumps(auth))
    found = await find_candidates("opencode", [])
    assert {item["label"]: item["status"] for item in found} == {
        "Codex": "ready",
        "DeepSeek": "ready",
        "other": "nothing-to-track",
    }
    assert all(item["accountHome"] == str(home / ".xdg-data" / "opencode") for item in found)


async def test_a_missing_or_broken_open_code_file_offers_nothing(home: Path) -> None:
    assert await find_candidates("opencode", []) == []
    write(home / ".xdg-data" / "opencode" / "auth.json", "not json")
    assert await find_candidates("opencode", []) == []


async def test_claude_settings_pointing_at_deepseek_become_deepseek_candidates(home: Path) -> None:
    env = {"ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic", "ANTHROPIC_AUTH_TOKEN": SECRET}
    write(home / ".claude" / "settings.json", json.dumps({"env": env}))
    write(home / ".claude" / ".credentials.json", "{}")
    write(home / ".claude-plain" / "settings.json", json.dumps({"env": {"ANTHROPIC_AUTH_TOKEN": SECRET}}))
    write(home / ".claude-plain" / ".credentials.json", "{}")
    found = await find_candidates("claude-settings", [])
    assert [(item["kind"], item["app"], item["accountHome"], item["status"]) for item in found] == [
        ("deepseek", "claude-settings", "~/.claude", "ready")
    ]
    added = new_provider("deepseek", "claude-settings", "~/.claude")
    again = await find_candidates("claude-settings", [added])
    assert [item["status"] for item in again] == ["already-added"]


async def test_copilot_cli_candidate_needs_a_readable_keyring_token(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def present() -> str:
        return SECRET

    monkeypatch.setattr("tokengrill.providers.discovery.copilot_cli_token", present)
    found = await find_candidates("copilot-cli", [])
    assert [(item["app"], item["accountHome"], item["status"]) for item in found] == [
        ("copilot-cli", "~/.copilot", "ready")
    ]
    configured = [new_provider("copilot", "copilot-cli", "~/.copilot")]
    assert [item["status"] for item in await find_candidates("copilot-cli", configured)] == ["already-added"]


async def test_copilot_cli_without_a_token_or_keyring_offers_nothing(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from tokengrill.core.errors import ServiceError

    async def locked() -> str:
        raise ServiceError("dependency", "copilot.keyring-unavailable")

    monkeypatch.setattr("tokengrill.providers.discovery.copilot_cli_token", locked)
    assert await find_candidates("copilot-cli", []) == []


async def test_keyring_app_has_nothing_to_find(home: Path) -> None:
    assert await find_candidates("keyring", []) == []


async def test_find_all_candidates_combines_apps_and_sorts_by_status(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def absent() -> str:
        from tokengrill.core.errors import ServiceError

        raise ServiceError("auth-missing", "copilot.cli-missing")

    monkeypatch.setattr("tokengrill.providers.discovery.copilot_cli_token", absent)
    write(home / ".codex" / "auth.json", codex_auth("a"))
    write(home / ".kimi-code" / "credentials" / "kimi-code.json", "{}")
    write(home / ".xdg-data" / "opencode" / "auth.json", json.dumps({"x": {"type": "api", "key": SECRET}}))
    configured: list[ProviderInstance] = [new_provider("kimi", "kimi-cli", "~/.kimi-code")]
    found = await find_all_candidates(configured)
    assert [(item["app"], item["status"]) for item in found] == [
        ("codex-cli", "ready"),
        ("kimi-cli", "already-added"),
        ("opencode", "nothing-to-track"),
    ]


async def test_discovery_never_writes(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def absent() -> str:
        from tokengrill.core.errors import ServiceError

        raise ServiceError("auth-missing", "copilot.cli-missing")

    monkeypatch.setattr("tokengrill.providers.discovery.copilot_cli_token", absent)
    write(home / ".codex" / "auth.json", codex_auth("a"))
    write(home / ".xdg-data" / "opencode" / "auth.json", json.dumps({"x": {"type": "api", "key": SECRET}}))
    database = home / ".xdg-data" / "kiro-cli" / "data.sqlite3"
    database.parent.mkdir(parents=True)
    connection = sqlite3.connect(database)
    connection.execute("CREATE TABLE auth_kv (key TEXT, value TEXT)")
    connection.commit()
    connection.close()
    before = snapshot_tree(home)
    await find_all_candidates([])
    assert snapshot_tree(home) == before
    assert not (home / ".xdg-config" / "token-grill").exists()
    assert os.listdir(home / ".xdg-data" / "kiro-cli") == ["data.sqlite3"]


async def test_candidates_never_contain_secrets(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def present() -> str:
        return SECRET

    monkeypatch.setattr("tokengrill.providers.discovery.copilot_cli_token", present)
    write(home / ".codex" / "auth.json", codex_auth("acct-1"))
    write(home / ".claude" / ".credentials.json", json.dumps({"claudeAiOauth": {"accessToken": SECRET}}))
    env = {"ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic", "ANTHROPIC_AUTH_TOKEN": SECRET}
    write(home / ".claude" / "settings.json", json.dumps({"env": env, "email": "me@example.com"}))
    write(home / ".kimi-code" / "credentials" / "kimi-code.json", json.dumps({"access_token": SECRET}))
    write(
        home / ".xdg-config" / "gh" / "hosts.yml", f"github.com:\n    user: me@example.com\n    oauth_token: {SECRET}\n"
    )
    write(
        home / ".xdg-data" / "opencode" / "auth.json",
        json.dumps(
            {
                "openai": {"type": "oauth", "access": SECRET, "refresh": SECRET, "accountId": "acct-1"},
                "deepseek": {"type": "api", "key": SECRET},
                "chutes": {"type": "api", "key": SECRET},
            }
        ),
    )
    found: list[Candidate] = await find_all_candidates([new_provider("codex", "codex-cli", "~/.codex")])
    assert len(found) >= 6
    text = json.dumps(found)
    for secret in (SECRET, "me@example.com", "acct-1"):
        assert secret not in text
