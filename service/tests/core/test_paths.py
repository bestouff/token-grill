from pathlib import Path

import pytest

from tokengrill.core.config import new_provider
from tokengrill.core.paths import (
    auth_file_candidates,
    config_dir,
    cursor_agent_home,
    data_dir,
    default_home,
    display_path,
    expand_path,
    home_is_default,
    open_code_auth_path,
    path_exists,
    provider_paths,
    runtime_dir,
    state_dir,
)
from tokengrill.core.types import ProviderInstance


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    for name in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR"):
        monkeypatch.delenv(name, raising=False)


def _instance(kind: str, app: str, home: str, **extra: object) -> ProviderInstance:
    base: dict[str, object] = {
        "schemaVersion": 2,
        "id": "a",
        "kind": kind,
        "app": app,
        "displayName": "A",
        "accent": "blue",
        "enabled": True,
        "sortOrder": 0,
        "accountHome": home,
        "authFileOverride": None,
        "sessionsDirectoryOverride": None,
        "liveUsageEnabled": True,
        "localHistoryEnabled": True,
        "topBar": {"automatic": True, "limits": []},
        "lowBalance": None,
        "showPace": True,
    }
    base.update(extra)
    return base  # type: ignore[return-value]


def test_dirs_follow_xdg(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path))
    assert state_dir() == tmp_path / "token-grill"


def test_dirs_default_to_glib_locations(tmp_path: Path) -> None:
    home = tmp_path / "home"
    assert config_dir() == home / ".config" / "token-grill"
    assert data_dir() == home / ".local" / "share" / "token-grill"
    assert state_dir() == home / ".local" / "state" / "token-grill"


def test_relative_xdg_value_is_ignored(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_DATA_HOME", "relative/dir")
    assert data_dir() == tmp_path / "home" / ".local" / "share" / "token-grill"


def test_runtime_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    assert runtime_dir() == tmp_path / "run" / "token-grill"
    monkeypatch.delenv("XDG_RUNTIME_DIR")
    assert runtime_dir() == tmp_path / "home" / ".cache" / "token-grill"
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    assert runtime_dir() == tmp_path / "cache" / "token-grill"
    monkeypatch.setenv("XDG_RUNTIME_DIR", "relative/run")
    assert runtime_dir() == tmp_path / "cache" / "token-grill"


def test_copilot_home_follows_xdg_config(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path))
    assert default_home("copilot") == str(tmp_path / "gh")


def test_default_homes(tmp_path: Path) -> None:
    home = tmp_path / "home"
    assert default_home("codex") == str(home / ".codex")
    assert default_home("claude") == str(home / ".claude")
    assert default_home("deepseek") == str(home / ".claude")
    assert default_home("antigravity") == str(home / ".gemini" / "antigravity-cli")
    assert default_home("kimi") == str(home / ".kimi-code")
    assert default_home("kiro") == str(home / ".local" / "share" / "kiro-cli")
    assert default_home("opencode-go") == str(home / ".local" / "share" / "opencode")
    assert default_home("cursor") == str(home / ".config" / "Cursor")
    assert cursor_agent_home() == str(home / ".config" / "cursor")
    assert open_code_auth_path() == str(home / ".local" / "share" / "opencode" / "auth.json")


def test_home_is_default_follows_the_sign_in_home_of_each_cli(tmp_path: Path) -> None:
    assert home_is_default(new_provider("codex", "codex-cli", "~/.codex"))
    assert home_is_default(new_provider("codex", "codex-cli", str(tmp_path / "home" / ".codex")))
    assert not home_is_default(new_provider("codex", "codex-cli", "~/.codex-work"))
    assert home_is_default(new_provider("claude", "claude-code", "~/.claude/"))
    assert not home_is_default(new_provider("claude", "claude-code", "~/claude two"))
    assert home_is_default(new_provider("copilot", "github-cli", "~/.config/gh"))
    assert not home_is_default(new_provider("copilot", "github-cli", "~/gh-work"))
    assert home_is_default(new_provider("kiro", "kiro-cli", "~/.local/share/kiro-cli"))
    assert not home_is_default(new_provider("kiro", "kiro-cli", "~/other"))
    # The Cursor CLI signs in to its own folder, not to the one of the Cursor app.
    assert home_is_default(new_provider("cursor", "cursor-agent", "~/.config/cursor"))
    assert not home_is_default(new_provider("cursor", "cursor-agent", "~/.config/Cursor"))


def test_home_is_default_for_apps_without_a_home_of_their_own() -> None:
    assert home_is_default(new_provider("opencode-go", "opencode", "~/anywhere"))
    assert home_is_default(new_provider("deepseek", "keyring", ""))
    assert home_is_default(new_provider("antigravity", "antigravity", "~/other"))


def test_expand_and_display_path(tmp_path: Path) -> None:
    home = str(tmp_path / "home")
    assert expand_path("  ~/a//b/ ") == f"{home}/a/b"
    assert expand_path("/x/./y/../z") == "/x/z"
    assert expand_path("//x") == "/x"
    assert display_path(home) == "~"
    assert display_path(f"{home}/a/b") == "~/a/b"
    assert display_path(f"{home}x/a") == f"{home}x/a"
    assert display_path("/etc") == "/etc"
    with pytest.raises(ValueError, match="A path is required."):
        expand_path("  ")
    with pytest.raises(ValueError, match="Paths must be absolute or start with ~/."):
        expand_path("rel/x")
    with pytest.raises(ValueError, match="Paths must be absolute or start with ~/."):
        expand_path("~")


def test_provider_paths(tmp_path: Path) -> None:
    home = "/acct"
    codex = provider_paths(_instance("codex", "codex-cli", home))
    assert codex == {"authFile": "/acct/auth.json", "historyDirectories": ["/acct/sessions", "/acct/archived_sessions"]}
    claude = provider_paths(_instance("claude", "claude-code", home))
    assert claude["authFile"] == "/acct/.credentials.json"
    assert claude["historyDirectories"] == ["/acct/projects"]
    assert provider_paths(_instance("cursor", "cursor-agent", home))["authFile"] == "/acct/auth.json"
    assert provider_paths(_instance("cursor", "cursor", home))["authFile"] == "/acct/User/globalStorage/state.vscdb"
    assert provider_paths(_instance("kimi", "kimi-cli", home))["authFile"] == "/acct/credentials/kimi-code.json"
    assert provider_paths(_instance("opencode-go", "opencode", home)) == {
        "authFile": open_code_auth_path(),
        "historyDirectories": [],
    }
    assert provider_paths(_instance("deepseek", "keyring", home)) == {"authFile": "", "historyDirectories": []}
    overridden = provider_paths(
        _instance("codex", "codex-cli", home, authFileOverride="~/o.json", sessionsDirectoryOverride="/s")
    )
    assert overridden == {"authFile": str(tmp_path / "home" / "o.json"), "historyDirectories": ["/s"]}


def test_auth_file_candidates() -> None:
    antigravity = _instance("antigravity", "antigravity", "/g")
    assert auth_file_candidates(antigravity) == ["/g/acp_token.json", "/g/oauth_creds.json", "/g/credentials.json"]
    pinned = _instance("antigravity", "antigravity", "/g", authFileOverride="/p.json")
    assert auth_file_candidates(pinned) == ["/p.json"]
    assert auth_file_candidates(_instance("codex", "codex-cli", "/c")) == ["/c/auth.json"]


def test_path_exists(tmp_path: Path) -> None:
    assert path_exists(str(tmp_path))
    assert not path_exists(str(tmp_path / "nope"))
