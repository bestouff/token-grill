import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, RefreshPhase, RefreshSource, SourceResult, empty_snapshot
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.claude.auth import load_claude_access_token
from tokengrill.providers.claude.collector import ClaudeCollector
from tokengrill.providers.claude.history import claude_usage_event
from tokengrill.providers.claude.normalize import normalize_claude_usage
from tokengrill.providers.registry import create_collectors
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.checkpoints import CheckpointStore


def ms(text: str) -> int:
    return int(datetime.fromisoformat(text).timestamp() * 1000)


# --- normalizers.test.mjs


def test_oauth_usage_maps_canonical_windows_and_iso_reset_times() -> None:
    windows = normalize_claude_usage(
        {
            "five_hour": {"utilization": 68, "resets_at": "2026-08-07T12:00:00Z"},
            "seven_day": {"utilization": 12, "resets_at": "2026-08-13T12:00:00Z"},
        }
    )
    assert [w["canonicalWindow"] for w in windows] == ["five-hour", "weekly"]
    assert windows[0]["percent"] == 0.68
    assert windows[1]["percent"] == 0.12
    assert windows[0]["resetAt"] == ms("2026-08-07T12:00:00Z")
    assert [w["label"] for w in windows] == ["Five-hour", "Weekly"]


def test_utilization_is_always_percentage_points() -> None:
    windows = normalize_claude_usage({"five_hour": {"utilization": 1.0}, "seven_day": {"utilization": 0.4}})
    assert windows[0]["percent"] == 0.01
    assert round((1 - windows[0]["percent"]) * 100) == 99
    assert windows[1]["percent"] == 0.004


def test_limits_array_fills_windows_missing_from_legacy_fields() -> None:
    windows = normalize_claude_usage(
        {
            "five_hour": {"utilization": 1.0, "resets_at": "2026-10-13T13:00:00.032642+00:00"},
            "seven_day": None,
            "seven_day_opus": None,
            "limits": [
                {
                    "kind": "session",
                    "group": "session",
                    "percent": 1,
                    "resets_at": "2026-10-13T13:00:00.032642+00:00",
                    "scope": None,
                    "is_active": True,
                },
                {
                    "kind": "weekly_scoped",
                    "group": "weekly",
                    "percent": 0,
                    "resets_at": "2026-10-20T03:00:00+00:00",
                    "scope": {"model": {"id": None, "display_name": "Fable"}, "surface": None},
                    "is_active": False,
                },
            ],
        }
    )
    assert [w["canonicalWindow"] for w in windows] == ["five-hour", "weekly"]
    assert windows[0]["id"] == "five_hour"
    assert windows[0]["percent"] == 0.01
    assert windows[1]["label"] == "Weekly - Fable"
    assert windows[1]["percent"] == 0
    assert windows[1]["resetAt"] == ms("2026-10-20T03:00:00+00:00")


def test_limits_array_fills_weekly_with_the_unscoped_limit_and_keeps_the_scoped_one() -> None:
    windows = normalize_claude_usage(
        {
            "limits": [
                {
                    "kind": "weekly_scoped",
                    "group": "weekly",
                    "percent": 80,
                    "scope": {"model": {"display_name": "Fable"}},
                },
                {"kind": "weekly", "group": "weekly", "percent": 30, "scope": None},
            ]
        }
    )
    assert len(windows) == 2
    assert windows[0]["canonicalWindow"] == "weekly"
    assert windows[0]["label"] == "Weekly"
    assert windows[0]["percent"] == 0.3
    assert windows[1]["canonicalWindow"] == "other"
    assert windows[1]["label"] == "Weekly - Fable"
    assert windows[1]["percent"] == 0.8


def test_model_scoped_weekly_limit_is_kept_when_legacy_keys_give_the_weekly() -> None:
    windows = normalize_claude_usage(
        {
            "five_hour": {"utilization": 29, "resets_at": "2026-11-12T18:00:00+00:00"},
            "seven_day": {"utilization": 35, "resets_at": "2026-11-18T03:00:00+00:00"},
            "seven_day_opus": None,
            "seven_day_sonnet": None,
            "limits": [
                {
                    "group": "session",
                    "kind": "session",
                    "percent": 29,
                    "scope": None,
                    "resets_at": "2026-11-12T18:00:00+00:00",
                },
                {
                    "group": "weekly",
                    "kind": "weekly_all",
                    "percent": 35,
                    "scope": None,
                    "resets_at": "2026-11-18T03:00:00+00:00",
                },
                {
                    "group": "weekly",
                    "kind": "weekly_scoped",
                    "percent": 29,
                    "scope": {"model": {"display_name": "Fable"}, "surface": None},
                    "resets_at": "2026-11-18T03:00:00+00:00",
                },
            ],
        }
    )
    assert [[w["canonicalWindow"], w["percent"]] for w in windows] == [
        ["five-hour", 0.29],
        ["weekly", 0.35],
        ["other", 0.29],
    ]
    assert windows[2]["id"] == "limits:weekly_scoped:Fable"
    assert windows[2]["label"] == "Weekly - Fable"
    assert windows[2]["resetAt"] == ms("2026-11-18T03:00:00+00:00")


def test_model_scoped_limit_is_not_repeated_when_a_legacy_model_key_reports_it() -> None:
    windows = normalize_claude_usage(
        {
            "seven_day_opus": {"utilization": 10},
            "limits": [
                {
                    "group": "weekly",
                    "kind": "weekly_scoped",
                    "percent": 10,
                    "scope": {"model": {"display_name": "Opus"}},
                }
            ],
        }
    )
    assert [w["id"] for w in windows] == ["seven_day_opus"]


def test_window_lengths_come_from_the_key_and_group_names() -> None:
    windows = normalize_claude_usage(
        {
            "five_hour": {"utilization": 10, "resets_at": "2026-11-24T15:00:00Z"},
            "seven_day": {"utilization": 20, "resets_at": "2026-11-28T03:00:00Z"},
            "limits": [
                {
                    "kind": "weekly_scoped",
                    "group": "weekly",
                    "percent": 5,
                    "resets_at": "2026-11-28T03:00:00Z",
                    "scope": {"model": {"display_name": "Fable"}},
                }
            ],
        }
    )
    assert [[w["id"], w["durationSeconds"]] for w in windows] == [
        ["five_hour", 5 * 3600],
        ["seven_day", 7 * 86400],
        ["limits:weekly_scoped:Fable", 7 * 86400],
    ]


def test_legacy_model_keys_are_other_windows_labelled_by_key() -> None:
    windows = normalize_claude_usage({"seven_day_sonnet": {"utilization": 5}})
    assert [(w["canonicalWindow"], w["label"]) for w in windows] == [("other", "seven day sonnet")]


def test_scope_surface_joins_the_model_name() -> None:
    windows = normalize_claude_usage(
        {
            "limits": [
                {
                    "kind": "weekly_scoped",
                    "group": "weekly",
                    "percent": 5,
                    "scope": {"model": {"id": "m1"}, "surface": "cli"},
                }
            ]
        }
    )
    assert windows[0]["id"] == "limits:weekly_scoped:m1 - cli"


def test_non_record_payload_has_no_windows() -> None:
    assert normalize_claude_usage([]) == []
    assert normalize_claude_usage(None) == []


# --- parser.test.mjs


def test_assistant_messages_yield_usage_and_model() -> None:
    line = json.dumps(
        {
            "type": "assistant",
            "timestamp": "2026-08-07T01:00:00Z",
            "message": {
                "model": "claude-sonnet",
                "usage": {
                    "input_tokens": 3,
                    "output_tokens": 7,
                    "cache_read_input_tokens": 100,
                    "cache_creation_input_tokens": 20,
                },
            },
        }
    )
    assert claude_usage_event(line) == {
        "capturedAt": ms("2026-08-07T01:00:00Z"),
        "model": "claude-sonnet",
        "totals": {"input": 3, "output": 7, "cachedInput": 100, "cacheWrite": 20, "reasoning": 0, "total": 10},
    }


def test_lines_without_usage_or_a_valid_timestamp_are_ignored() -> None:
    assert claude_usage_event(json.dumps({"type": "user", "message": {"content": "usage"}})) is None
    assert claude_usage_event(json.dumps({"timestamp": "never", "message": {"usage": {"input_tokens": 1}}})) is None
    assert claude_usage_event('{"usage": ') is None


# --- auth and collector


def make_instance(home: Path, live: bool = True, app: str = "claude-code") -> ProviderInstance:
    return {
        "schemaVersion": 2,
        "id": "acct",
        "kind": "claude",
        "app": app,  # type: ignore[typeddict-item]
        "displayName": "x",
        "accent": "orange",
        "enabled": True,
        "sortOrder": 0,
        "accountHome": str(home),
        "authFileOverride": None,
        "sessionsDirectoryOverride": None,
        "liveUsageEnabled": live,
        "localHistoryEnabled": False,
        "topBar": {"automatic": True, "limits": []},
        "lowBalance": None,
        "showPace": True,
    }


def write_auth(home: Path, oauth: dict[str, Any] | None) -> None:
    home.mkdir(parents=True, exist_ok=True)
    payload: dict[str, Any] = {} if oauth is None else {"claudeAiOauth": oauth}
    (home / ".credentials.json").write_text(json.dumps(payload))


FUTURE_MS = int(datetime(2100, 1, 1, tzinfo=UTC).timestamp() * 1000)


async def test_access_token_is_read_from_credentials_json(tmp_path: Path) -> None:
    write_auth(tmp_path, {"accessToken": "tok", "expiresAt": FUTURE_MS})
    assert await load_claude_access_token(make_instance(tmp_path)) == "tok"


async def test_missing_token_is_auth_missing(tmp_path: Path) -> None:
    write_auth(tmp_path, {"refreshToken": "r"})
    with pytest.raises(ServiceError) as caught:
        await load_claude_access_token(make_instance(tmp_path))
    assert caught.value.code == "auth-missing"
    assert caught.value.message_id == "claude.auth-missing"


async def test_expired_token_is_auth_expired_and_never_refreshed(tmp_path: Path) -> None:
    write_auth(tmp_path, {"accessToken": "tok", "expiresAt": 1000})
    with pytest.raises(ServiceError) as caught:
        await load_claude_access_token(make_instance(tmp_path))
    assert caught.value.code == "auth-expired"
    assert caught.value.message_id == "claude.auth-expired"


async def test_token_without_expiry_is_accepted(tmp_path: Path) -> None:
    write_auth(tmp_path, {"accessToken": "tok"})
    assert await load_claude_access_token(make_instance(tmp_path)) == "tok"


async def test_opencode_accounts_are_not_wired_yet(tmp_path: Path) -> None:
    with pytest.raises(ServiceError) as caught:
        await load_claude_access_token(make_instance(tmp_path, app="opencode"))
    assert caught.value.message_id == "opencode.auth-missing"


class Recorder:
    def __init__(self) -> None:
        self.phases: list[RefreshPhase] = []
        self.sources: list[tuple[RefreshSource, SourceResult]] = []


USAGE = {"five_hour": {"utilization": 10, "resets_at": "2026-11-24T15:00:00Z"}}


def make_ctx(tmp_path: Path, recorder: Recorder, handler: httpx.MockTransport) -> CollectorContext:
    return CollectorContext(
        http=HttpClient(transport=handler),
        pricing={},
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
        on_phase=recorder.phases.append,
        on_source=lambda source, result: recorder.sources.append((source, result)),
    )


def test_collector_is_registered_under_claude() -> None:
    assert isinstance(create_collectors()["claude"], ClaudeCollector)


async def test_live_collection_fills_windows(tmp_path: Path) -> None:
    write_auth(tmp_path / "home", {"accessToken": "tok", "expiresAt": FUTURE_MS})
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=USAGE)

    recorder = Recorder()
    ctx = make_ctx(tmp_path, recorder, httpx.MockTransport(handler))
    snap = await ClaudeCollector().collect(make_instance(tmp_path / "home"), empty_snapshot("acct"), ctx)
    assert snap["state"] == "ready"
    assert [w["id"] for w in snap["windows"]] == ["five_hour"]
    assert [(r.method, str(r.url)) for r in seen] == [("GET", "https://api.anthropic.com/api/oauth/usage")]
    assert seen[0].headers["Authorization"] == "Bearer tok"
    assert recorder.sources == [("limits", "success")]


async def test_usage_without_windows_is_a_response_shape_error(tmp_path: Path) -> None:
    write_auth(tmp_path / "home", {"accessToken": "tok"})
    ctx = make_ctx(tmp_path, Recorder(), httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    snap = await ClaudeCollector().collect(make_instance(tmp_path / "home"), empty_snapshot("acct"), ctx)
    assert snap["state"] == "error"
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "response-shape"
    assert snap["errorInfo"]["messageId"] == "net.no-usage"


async def test_expired_token_sends_no_request_and_leaves_the_file_alone(tmp_path: Path) -> None:
    write_auth(tmp_path / "home", {"accessToken": "tok", "expiresAt": 1000})
    before = (tmp_path / "home" / ".credentials.json").read_text()
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=USAGE)

    ctx = make_ctx(tmp_path, Recorder(), httpx.MockTransport(handler))
    snap = await ClaudeCollector().collect(make_instance(tmp_path / "home"), empty_snapshot("acct"), ctx)
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "auth-expired"
    assert seen == []
    assert (tmp_path / "home" / ".credentials.json").read_text() == before


async def test_live_usage_disabled_makes_no_request(tmp_path: Path) -> None:
    ctx = make_ctx(tmp_path, Recorder(), httpx.MockTransport(lambda r: httpx.Response(500)))
    snap = await ClaudeCollector().collect(make_instance(tmp_path, live=False), empty_snapshot("acct"), ctx)
    assert snap["state"] == "unknown"
