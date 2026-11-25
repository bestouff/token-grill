from pathlib import Path

import pytest

from tokengrill.core.config import new_provider
from tokengrill.core.signin import sign_in_command
from tokengrill.core.types import AccountApp, ProviderInstance, ProviderKind


@pytest.fixture(autouse=True)
def xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", "/home/test")
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_CONFIG_HOME", "/home/test/.config")


def account(kind: ProviderKind, app: AccountApp, home: str) -> ProviderInstance:
    return new_provider(kind, app, home)


def test_the_default_home_signs_in_with_the_plain_command() -> None:
    assert sign_in_command(account("codex", "codex-cli", "~/.codex")) == (["codex", "login"], {})
    assert sign_in_command(account("claude", "claude-code", "~/.claude")) == (["claude", "auth", "login"], {})
    assert sign_in_command(account("cursor", "cursor-agent", "~/.config/cursor")) == (["agent", "login"], {})
    assert sign_in_command(account("opencode-go", "opencode", "~/.local/share/opencode")) == (
        ["opencode", "auth", "login"],
        {},
    )


def test_another_home_is_passed_through_the_clis_own_variable() -> None:
    assert sign_in_command(account("codex", "codex-cli", "~/.codex-work")) == (
        ["codex", "login"],
        {"CODEX_HOME": "/home/test/.codex-work"},
    )
    assert sign_in_command(account("claude", "claude-code", "/home/test/my claude")) == (
        ["claude", "auth", "login"],
        {"CLAUDE_CONFIG_DIR": "/home/test/my claude"},
    )
    assert sign_in_command(account("copilot", "github-cli", "~/gh-work")) == (
        ["gh", "auth", "login"],
        {"GH_CONFIG_DIR": "/home/test/gh-work"},
    )


def test_apps_that_cannot_be_pointed_at_another_home_or_have_no_login_get_no_command() -> None:
    assert sign_in_command(account("cursor", "cursor-agent", "~/other")) is None
    assert sign_in_command(account("kiro", "kiro-cli", "~/other")) is None
    assert sign_in_command(account("cursor", "cursor", "~/.config/Cursor")) is None
    assert sign_in_command(account("deepseek", "keyring", "")) is None
