import json
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.core.paths import open_code_auth_path
from tokengrill.core.types import ProviderInstance, RefreshPhase, RefreshSource, SourceResult, empty_snapshot
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.claude.auth import load_claude_access_token
from tokengrill.providers.codex.auth import load_codex_access_token
from tokengrill.providers.opencode.auth_file import read_open_code_entries
from tokengrill.providers.opencode.entries import (
    match_open_code_entry,
    open_code_access_token,
    open_code_github_token,
    parse_open_code_auth,
)
from tokengrill.providers.opencode_go.auth import load_open_code_go_key
from tokengrill.providers.opencode_go.collector import OpenCodeGoCollector
from tokengrill.providers.opencode_go.normalize import normalize_open_code_go_usage
from tokengrill.providers.registry import create_collectors
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.balances import BalanceStore
from tokengrill.storage.checkpoints import CheckpointStore


def ms(text: str) -> int:
    return int(datetime.fromisoformat(text).timestamp() * 1000)


# --- opencode-auth.test.mjs

AUTH: dict[str, Any] = {
    "openai": {
        "type": "oauth",
        "refresh": "r-token",
        "access": "a-token",
        "expires": 1794200000000,
        "accountId": "acct-1",
    },
    "anthropic": {"type": "api", "key": "k-anthropic"},
    "kiro": {"type": "api", "key": "k-kiro"},
    "chutes": {"type": "api", "key": "k-chutes"},
    "broken": {"type": "oauth"},
    "alsoBroken": "not an entry",
}


def test_oauth_and_api_entries_parse() -> None:
    entries = parse_open_code_auth(AUTH)
    assert entries["openai"] == {
        "type": "oauth",
        "access": "a-token",
        "refresh": "r-token",
        "expires": 1794200000000,
        "accountId": "acct-1",
    }
    assert entries["chutes"] == {"type": "api", "key": "k-chutes"}


def test_unknown_shapes_are_dropped() -> None:
    entries = parse_open_code_auth(AUTH)
    assert "broken" not in entries
    assert "alsoBroken" not in entries


def test_a_chatgpt_sign_in_belongs_to_codex() -> None:
    entry = parse_open_code_auth(AUTH)["openai"]
    assert match_open_code_entry("openai", entry) == {"status": "service", "kind": "codex"}


def test_an_anthropic_api_key_is_nothing_to_track() -> None:
    assert match_open_code_entry("anthropic", {"type": "api", "key": "k"}) == {"status": "nothing-to-track"}
    oauth = {"type": "oauth", "access": "a", "refresh": None, "expires": None, "accountId": None}
    assert match_open_code_entry("anthropic", oauth) == {"status": "service", "kind": "claude"}


def test_kiro_in_opencode_uses_the_kiro_app_sign_in() -> None:
    assert match_open_code_entry("kiro", {"type": "api", "key": "k"}) == {"status": "uses-other-app", "kind": "kiro"}


def test_other_providers_are_nothing_to_track() -> None:
    assert match_open_code_entry("chutes", {"type": "api", "key": "k"}) == {"status": "nothing-to-track"}


def test_deepseek_and_kimi_keys_belong_to_their_services() -> None:
    assert match_open_code_entry("deepseek", {"type": "api", "key": "k"}) == {"status": "service", "kind": "deepseek"}
    assert match_open_code_entry("kimi-for-coding", {"type": "api", "key": "k"}) == {
        "status": "service",
        "kind": "kimi",
    }


NOW = 1794200000000


def oauth(expires: int | None) -> Any:
    return {"type": "oauth", "access": "a-token", "refresh": "r", "expires": expires, "accountId": None}


def test_a_valid_opencode_sign_in_gives_its_access_token() -> None:
    assert open_code_access_token(oauth(NOW + 60000), NOW) == "a-token"
    assert open_code_access_token(oauth(None), NOW) == "a-token"


def test_an_expired_opencode_sign_in_reports_auth_expired() -> None:
    with pytest.raises(ServiceError) as caught:
        open_code_access_token(oauth(NOW - 1), NOW)
    assert caught.value.code == "auth-expired"
    assert caught.value.message_id == "opencode.auth-expired"


def test_an_opencode_api_key_where_a_sign_in_is_needed_is_auth_invalid() -> None:
    with pytest.raises(ServiceError) as caught:
        open_code_access_token({"type": "api", "key": "k"}, NOW)
    assert caught.value.code == "auth-invalid"
    assert caught.value.message_id == "opencode.api-key-only"


def test_a_missing_opencode_sign_in_is_auth_missing() -> None:
    with pytest.raises(ServiceError) as caught:
        open_code_access_token(None, NOW)
    assert caught.value.code == "auth-missing"
    assert caught.value.message_id == "opencode.auth-missing"


def test_a_copilot_sign_in_in_opencode_belongs_to_copilot_and_reads_its_github_token() -> None:
    entry: Any = {
        "type": "oauth",
        "access": "copilot-session",
        "refresh": "gho_github",
        "expires": 1,
        "accountId": None,
    }
    assert match_open_code_entry("github-copilot", entry) == {"status": "service", "kind": "copilot"}
    assert open_code_github_token(entry) == "gho_github"
    with pytest.raises(ServiceError) as caught:
        open_code_github_token({**entry, "refresh": None})
    assert caught.value.code == "auth-missing"
    assert caught.value.message_id == "opencode.copilot-missing"
    with pytest.raises(ServiceError):
        open_code_github_token(None)


# --- opencode-go.test.mjs

USAGE = {
    "rolling": {"status": "ok", "percent": 22, "resetsAt": "2026-11-10T14:00:00.000Z"},
    "weekly": {"status": "ok", "percent": 29.5, "resetsAt": "2026-11-16T00:00:00.000Z"},
    "monthly": {"status": "ok", "percent": 41, "resetsAt": "2026-11-21T00:00:00.000Z"},
}


def test_rolling_weekly_and_monthly_become_three_limits() -> None:
    windows = normalize_open_code_go_usage(USAGE)
    assert [(w["id"], w["canonicalWindow"], w["percent"], w["resetAt"]) for w in windows] == [
        ("rolling", "five-hour", 0.22, ms("2026-11-10T14:00:00+00:00")),
        ("weekly", "weekly", 0.295, ms("2026-11-16T00:00:00+00:00")),
        ("monthly", "monthly", 0.41, ms("2026-11-21T00:00:00+00:00")),
    ]
    assert [w["durationSeconds"] for w in windows] == [5 * 3600, 7 * 86400, 31 * 86400]
    assert [w["label"] for w in windows] == ["Five-hour", "Weekly", "Monthly"]
    assert windows[0]["used"] is None
    assert windows[0]["limit"] is None
    assert windows[0]["unit"] is None


def test_a_rate_limited_window_counts_as_full() -> None:
    windows = normalize_open_code_go_usage(
        {**USAGE, "weekly": {"status": "rate-limited", "percent": 87, "resetsAt": None}}
    )
    weekly = next(w for w in windows if w["id"] == "weekly")
    assert weekly["percent"] == 1
    assert weekly["resetAt"] is None


def test_both_response_layouts_parse() -> None:
    assert len(normalize_open_code_go_usage({"usage": USAGE})) == 3
    assert normalize_open_code_go_usage({}) == []
    assert normalize_open_code_go_usage([]) == []


def test_windows_without_a_percent_are_skipped() -> None:
    assert normalize_open_code_go_usage({"rolling": {"status": "ok"}, "weekly": "x"}) == []


def test_opencode_go_keys_belong_to_opencode_go() -> None:
    key: Any = {"type": "api", "key": "k"}
    assert match_open_code_entry("opencode-go", key) == {"status": "service", "kind": "opencode-go"}
    assert match_open_code_entry("opencode", key) == {"status": "service", "kind": "opencode-go"}


# --- the auth file and the readers built on it


@pytest.fixture
def data_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / "data"
    monkeypatch.setenv("XDG_DATA_HOME", str(home))
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    return home


def write_opencode_auth(data_home: Path, payload: dict[str, Any]) -> None:
    path = Path(open_code_auth_path())
    assert str(path).startswith(str(data_home))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


async def test_the_auth_file_is_read_from_the_opencode_data_folder(data_home: Path) -> None:
    write_opencode_auth(data_home, AUTH)
    entries = await read_open_code_entries()
    assert sorted(entries) == ["anthropic", "chutes", "kiro", "openai"]


async def test_a_missing_auth_file_is_auth_missing(data_home: Path) -> None:
    with pytest.raises(ServiceError) as caught:
        await read_open_code_entries()
    assert caught.value.code == "auth-missing"


def make_instance(kind: str, app: str, live: bool = True) -> ProviderInstance:
    return {
        "schemaVersion": 2,
        "id": "acct",
        "kind": kind,  # type: ignore[typeddict-item]
        "app": app,  # type: ignore[typeddict-item]
        "displayName": "x",
        "accent": "teal",
        "enabled": True,
        "sortOrder": 0,
        "accountHome": "",
        "authFileOverride": None,
        "sessionsDirectoryOverride": None,
        "liveUsageEnabled": live,
        "localHistoryEnabled": False,
        "topBar": {"automatic": True, "limits": []},
        "lowBalance": None,
        "showPace": True,
    }


FUTURE = int(time.time() * 1000) + 3_600_000
PAST = int(time.time() * 1000) - 3_600_000


async def test_codex_accounts_from_opencode_read_the_openai_entry(data_home: Path) -> None:
    write_opencode_auth(data_home, {"openai": oauth(FUTURE)})
    assert await load_codex_access_token(make_instance("codex", "opencode")) == "a-token"


async def test_codex_opencode_sign_in_is_never_refreshed_when_expired(data_home: Path) -> None:
    write_opencode_auth(data_home, {"openai": oauth(PAST)})
    with pytest.raises(ServiceError) as caught:
        await load_codex_access_token(make_instance("codex", "opencode"))
    assert caught.value.message_id == "opencode.auth-expired"


async def test_codex_without_an_openai_entry_is_missing(data_home: Path) -> None:
    write_opencode_auth(data_home, {"anthropic": oauth(FUTURE)})
    with pytest.raises(ServiceError) as caught:
        await load_codex_access_token(make_instance("codex", "opencode"))
    assert caught.value.message_id == "opencode.auth-missing"


async def test_claude_accounts_from_opencode_read_the_anthropic_entry(data_home: Path) -> None:
    write_opencode_auth(data_home, {"anthropic": oauth(None), "openai": {"type": "oauth", "access": "other"}})
    assert await load_claude_access_token(make_instance("claude", "opencode")) == "a-token"


async def test_claude_opencode_api_key_is_not_a_sign_in(data_home: Path) -> None:
    write_opencode_auth(data_home, {"anthropic": {"type": "api", "key": "k"}})
    with pytest.raises(ServiceError) as caught:
        await load_claude_access_token(make_instance("claude", "opencode"))
    assert caught.value.code == "auth-invalid"


async def test_claude_opencode_expired_sign_in(data_home: Path) -> None:
    write_opencode_auth(data_home, {"anthropic": oauth(PAST)})
    with pytest.raises(ServiceError) as caught:
        await load_claude_access_token(make_instance("claude", "opencode"))
    assert caught.value.code == "auth-expired"


async def test_the_go_key_prefers_the_go_entry_over_the_zen_one(data_home: Path) -> None:
    write_opencode_auth(
        data_home, {"opencode": {"type": "api", "key": "zen"}, "opencode-go": {"type": "api", "key": "go"}}
    )
    assert await load_open_code_go_key() == "go"


async def test_the_go_key_falls_back_to_the_zen_entry(data_home: Path) -> None:
    write_opencode_auth(data_home, {"opencode": {"type": "api", "key": "zen"}})
    assert await load_open_code_go_key() == "zen"


async def test_the_go_key_is_missing_without_an_api_entry(data_home: Path) -> None:
    write_opencode_auth(data_home, {"opencode-go": oauth(None)})
    with pytest.raises(ServiceError) as caught:
        await load_open_code_go_key()
    assert caught.value.code == "auth-missing"
    assert caught.value.message_id == "opencode-go.key-missing"


# --- the collector


class Recorder:
    def __init__(self) -> None:
        self.sources: list[tuple[RefreshSource, SourceResult]] = []
        self.phases: list[RefreshPhase] = []


def make_ctx(tmp_path: Path, recorder: Recorder, transport: httpx.MockTransport) -> CollectorContext:
    return CollectorContext(
        http=HttpClient(transport=transport),
        pricing={},
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
        balances=BalanceStore(tmp_path / "balances.json"),
        on_phase=recorder.phases.append,
        on_source=lambda source, result: recorder.sources.append((source, result)),
    )


def test_collector_is_registered_under_opencode_go() -> None:
    assert isinstance(create_collectors()["opencode-go"], OpenCodeGoCollector)


async def test_live_collection_sends_the_key_and_fills_windows(tmp_path: Path, data_home: Path) -> None:
    write_opencode_auth(data_home, {"opencode-go": {"type": "api", "key": "go-key"}})
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"usage": USAGE})

    recorder = Recorder()
    snapshot = await OpenCodeGoCollector().collect(
        make_instance("opencode-go", "opencode"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, recorder, httpx.MockTransport(handler)),
    )
    assert snapshot["state"] == "ready"
    assert len(snapshot["windows"]) == 3
    assert recorder.sources == [("limits", "success")]
    assert str(seen[0].url) == "https://opencode.ai/zen/go/v1/usage"
    assert seen[0].headers["authorization"] == "Bearer go-key"
    assert seen[0].headers["accept"] == "application/json"


async def test_live_usage_disabled_reads_nothing(tmp_path: Path, data_home: Path) -> None:
    snapshot = empty_snapshot("acct")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request expected")

    result = await OpenCodeGoCollector().collect(
        make_instance("opencode-go", "opencode", live=False),
        snapshot,
        make_ctx(tmp_path, Recorder(), httpx.MockTransport(handler)),
    )
    assert result == snapshot


async def test_a_403_means_no_go_subscription(tmp_path: Path, data_home: Path) -> None:
    write_opencode_auth(data_home, {"opencode": {"type": "api", "key": "zen"}})
    recorder = Recorder()
    snapshot = await OpenCodeGoCollector().collect(
        make_instance("opencode-go", "opencode"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, recorder, httpx.MockTransport(lambda request: httpx.Response(403, json={}))),
    )
    assert snapshot["state"] == "error"
    info = snapshot["errorInfo"]
    assert info is not None
    assert info["code"] == "unsupported-account"
    assert info["messageId"] == "opencode-go.no-subscription"


async def test_a_401_stays_an_http_auth_error(tmp_path: Path, data_home: Path) -> None:
    write_opencode_auth(data_home, {"opencode": {"type": "api", "key": "zen"}})
    snapshot = await OpenCodeGoCollector().collect(
        make_instance("opencode-go", "opencode"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, Recorder(), httpx.MockTransport(lambda request: httpx.Response(401, json={}))),
    )
    info = snapshot["errorInfo"]
    assert info is not None
    assert info["code"] == "auth-invalid"
    assert info["messageId"].startswith("net.http-status")


async def test_an_empty_usage_response_is_a_shape_error(tmp_path: Path, data_home: Path) -> None:
    write_opencode_auth(data_home, {"opencode": {"type": "api", "key": "zen"}})
    snapshot = await OpenCodeGoCollector().collect(
        make_instance("opencode-go", "opencode"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, Recorder(), httpx.MockTransport(lambda request: httpx.Response(200, json={}))),
    )
    info = snapshot["errorInfo"]
    assert info is not None
    assert info["code"] == "response-shape"
    assert info["messageId"] == "net.no-usage"


async def test_a_missing_key_marks_the_snapshot_without_a_request(tmp_path: Path, data_home: Path) -> None:
    write_opencode_auth(data_home, {})

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("no request expected")

    snapshot = await OpenCodeGoCollector().collect(
        make_instance("opencode-go", "opencode"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, Recorder(), httpx.MockTransport(handler)),
    )
    info = snapshot["errorInfo"]
    assert info is not None
    assert info["messageId"] == "opencode-go.key-missing"
