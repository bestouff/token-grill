import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, RefreshPhase, RefreshSource, SourceResult, empty_snapshot
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.codex.auth import load_codex_access_token
from tokengrill.providers.codex.collector import CodexCollector
from tokengrill.providers.codex.history import codex_usage_event
from tokengrill.providers.codex.normalize import normalize_codex_usage
from tokengrill.providers.codex.reset_credits import normalize_reset_credits
from tokengrill.providers.registry import create_collectors
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.balances import BalanceStore
from tokengrill.storage.checkpoints import CheckpointStore

# --- normalizers.test.mjs


def test_weekly_only_response_is_a_valid_weekly_window() -> None:
    result = normalize_codex_usage(
        {
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": {
                    "used_percent": 26,
                    "limit_window_seconds": 604800,
                    "reset_after_seconds": 535574,
                    "reset_at": 1786598031,
                }
            },
        }
    )
    assert result["plan"] == "plus"
    assert len(result["windows"]) == 1
    window = result["windows"][0]
    assert window["canonicalWindow"] == "weekly"
    assert window["percent"] == 0.26
    assert window["resetAt"] == 1786598031000
    assert window["durationSeconds"] == 604800


def test_duration_rather_than_primary_secondary_naming_identifies_windows() -> None:
    result = normalize_codex_usage(
        {
            "rate_limit": {
                "primary_window": {"used_percent": 40, "limit_window_seconds": 18000},
                "secondary_window": {"used_percent": 100, "limit_window_seconds": 604800},
            }
        }
    )
    assert [w["canonicalWindow"] for w in result["windows"]] == ["five-hour", "weekly"]
    assert result["windows"][0]["percent"] == 0.4
    assert result["windows"][1]["percent"] == 1


def test_percentage_point_fields_handle_values_at_and_below_one_percent() -> None:
    one = normalize_codex_usage({"rate_limit": {"primary_window": {"used_percent": 1, "limit_window_seconds": 604800}}})
    frac = normalize_codex_usage(
        {"rate_limit": {"primary_window": {"used_percent": 0.4, "limit_window_seconds": 604800}}}
    )
    one_percent = one["windows"][0]["percent"]
    assert one_percent == 0.01
    assert one_percent is not None
    assert round((1 - one_percent) * 100) == 99
    assert frac["windows"][0]["percent"] == 0.004


def test_percentage_clamping_remains_safe() -> None:
    clamped = normalize_codex_usage(
        {
            "rate_limit": {
                "primary_window": {"used_percent": -5, "limit_window_seconds": 18000},
                "secondary_window": {"used_percent": 150, "limit_window_seconds": 604800},
            }
        }
    )
    assert [w["percent"] for w in clamped["windows"]] == [0, 1]


def test_model_specific_limits_are_listed_after_the_account_limits() -> None:
    result = normalize_codex_usage(
        {
            "rate_limit": {"primary_window": {"used_percent": 10, "limit_window_seconds": 18000}},
            "additional_rate_limits": [
                {
                    "limit_name": "GPT-5.6 Sol",
                    "rate_limit": {"primary_window": {"used_percent": 50, "limit_window_seconds": 86400}},
                }
            ],
        }
    )
    assert [[w["canonicalWindow"], w["label"]] for w in result["windows"]] == [
        ["five-hour", "Five-hour"],
        ["other", "GPT-5.6 Sol"],
    ]


def _window(seconds: int, used: int) -> dict[str, int]:
    return {"used_percent": used, "limit_window_seconds": seconds, "reset_at": 1794200000}


def _payload(extra: list[dict[str, object]]) -> dict[str, object]:
    return {
        "rate_limit": {"primary_window": _window(18000, 10), "secondary_window": _window(604800, 20)},
        "additional_rate_limits": extra,
    }


def test_model_limits_stay_separate_from_the_plan_limits_with_stable_ids() -> None:
    both = normalize_codex_usage(
        _payload(
            [
                {
                    "limit_name": "Spark",
                    "rate_limit": {"primary_window": _window(18000, 30), "secondary_window": _window(604800, 40)},
                }
            ]
        )
    )
    assert [[w["id"], w["canonicalWindow"], w["label"]] for w in both["windows"]] == [
        ["five-hour-0", "five-hour", "Five-hour"],
        ["weekly-1", "weekly", "Weekly"],
        ["Spark:five-hour", "other", "Spark - Five-hour"],
        ["Spark:weekly", "other", "Spark - Weekly"],
    ]
    reordered = normalize_codex_usage(
        _payload(
            [
                {"limit_name": "Other", "rate_limit": {"primary_window": _window(86400, 5)}},
                {
                    "limit_name": "Spark",
                    "rate_limit": {"primary_window": _window(18000, 30), "secondary_window": _window(604800, 40)},
                },
            ]
        )
    )
    assert any(w["id"] == "Spark:weekly" for w in reordered["windows"])


def test_non_record_payload_has_no_windows() -> None:
    assert normalize_codex_usage(None) == {"windows": [], "plan": None}


# --- v4.test.mjs (reset credits)


def test_reset_credits_preserve_authoritative_count_and_earliest_expiry() -> None:
    result = normalize_reset_credits(
        {
            "available_count": 4,
            "credits": [
                {"status": "available", "title": "Full reset", "expires_at": 1784246400},
                {"status": "redeemed", "title": "Used", "expires_at": 1781000000},
                {"status": "available", "title": "Referral", "expires_at": 1783000000},
            ],
        },
        1000,
    )
    assert result is not None
    assert result["availableCount"] == 4
    assert result["credits"] == [
        {"title": "Full reset", "expiresAt": 1784246400000},
        {"title": "Referral", "expiresAt": 1783000000000},
    ]
    assert result["fetchedAt"] == 1000
    assert result["stale"] is False


def test_reset_credits_preserve_a_zero_authoritative_count_without_inventing_rows() -> None:
    result = normalize_reset_credits({"available_count": 0, "total_earned_count": 3, "credits": []}, 1000)
    assert result is not None
    assert result["availableCount"] == 0
    assert result["credits"] == []


def test_reset_credits_without_status_use_redeemed_at() -> None:
    result = normalize_reset_credits({"credits": [{"title": "a"}, {"title": "b", "redeemed_at": 1784246400}]}, 1)
    assert result is not None
    assert result["availableCount"] == 1
    assert normalize_reset_credits([], 1) is None


# --- parser.test.mjs


def _line(usage: dict[str, int]) -> str:
    return json.dumps(
        {
            "timestamp": "2026-08-07T00:00:00Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {"last_token_usage": usage, "total_token_usage": {"input_tokens": 999}},
            },
        }
    )


def test_token_count_events_yield_the_last_turn_without_retaining_content() -> None:
    event = codex_usage_event(
        _line(
            {
                "input_tokens": 10,
                "cached_input_tokens": 4,
                "output_tokens": 5,
                "reasoning_output_tokens": 2,
                "total_tokens": 15,
            }
        )
    )
    assert event == {
        "capturedAt": int(datetime(2026, 8, 7, tzinfo=UTC).timestamp() * 1000),
        "model": None,
        "totals": {"input": 10, "output": 5, "cachedInput": 4, "cacheWrite": 0, "reasoning": 2, "total": 15},
    }


def test_records_without_usage_or_a_timestamp_are_ignored() -> None:
    message = json.dumps({"type": "response_item", "payload": {"type": "message", "text": '"token_count"'}})
    no_info = json.dumps({"type": "event_msg", "payload": {"type": "token_count", "info": None}})
    assert codex_usage_event(message) is None
    assert codex_usage_event(no_info) is None
    assert codex_usage_event(_line({"input_tokens": 0, "output_tokens": 0})) is None
    assert codex_usage_event('{"token_count": truncated') is None


# --- auth and collector


def make_instance(home: Path, live: bool = True) -> ProviderInstance:
    return {
        "schemaVersion": 2,
        "id": "acct",
        "kind": "codex",
        "app": "codex-cli",
        "displayName": "x",
        "accent": "green",
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


def jwt(exp: int) -> str:
    import base64

    body = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"h.{body}.s"


def write_auth(home: Path, token: str | None) -> None:
    home.mkdir(parents=True, exist_ok=True)
    tokens = {} if token is None else {"access_token": token}
    (home / "auth.json").write_text(json.dumps({"tokens": tokens}))


FUTURE = int(datetime(2100, 1, 1, tzinfo=UTC).timestamp())


async def test_access_token_is_read_from_auth_json(tmp_path: Path) -> None:
    token = jwt(FUTURE)
    write_auth(tmp_path, token)
    assert await load_codex_access_token(make_instance(tmp_path)) == token


async def test_missing_token_is_auth_missing(tmp_path: Path) -> None:
    write_auth(tmp_path, None)
    with pytest.raises(ServiceError) as caught:
        await load_codex_access_token(make_instance(tmp_path))
    assert caught.value.code == "auth-missing"
    assert caught.value.message_id == "codex.auth-missing"


async def test_expired_token_is_auth_expired_and_never_refreshed(tmp_path: Path) -> None:
    write_auth(tmp_path, jwt(1))
    with pytest.raises(ServiceError) as caught:
        await load_codex_access_token(make_instance(tmp_path))
    assert caught.value.code == "auth-expired"
    assert caught.value.message_id == "codex.auth-expired"


async def test_token_without_expiry_claim_is_accepted(tmp_path: Path) -> None:
    write_auth(tmp_path, "opaque")
    assert await load_codex_access_token(make_instance(tmp_path)) == "opaque"


class Recorder:
    def __init__(self) -> None:
        self.phases: list[RefreshPhase] = []
        self.sources: list[tuple[RefreshSource, SourceResult]] = []


USAGE = {"plan_type": "pro", "rate_limit": {"primary_window": {"used_percent": 10, "limit_window_seconds": 18000}}}
CREDITS = {"available_count": 1, "credits": [{"status": "available", "title": "T", "expires_at": 1784246400}]}


def make_ctx(tmp_path: Path, recorder: Recorder, handler: httpx.MockTransport) -> CollectorContext:
    return CollectorContext(
        http=HttpClient(transport=handler),
        pricing={},
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
        balances=BalanceStore(tmp_path / "balances.json"),
        on_phase=recorder.phases.append,
        on_source=lambda source, result: recorder.sources.append((source, result)),
    )


def test_collector_is_registered_under_codex() -> None:
    assert isinstance(create_collectors()["codex"], CodexCollector)


async def test_live_collection_fills_windows_plan_and_reset_credits(tmp_path: Path) -> None:
    write_auth(tmp_path / "home", jwt(FUTURE))
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=CREDITS if request.url.path.endswith("reset-credits") else USAGE)

    recorder = Recorder()
    ctx = make_ctx(tmp_path, recorder, httpx.MockTransport(handler))
    instance = make_instance(tmp_path / "home")
    snap = await CodexCollector().collect(instance, empty_snapshot("acct"), ctx)
    assert snap["state"] == "ready"
    assert snap["plan"] == "pro"
    assert [w["id"] for w in snap["windows"]] == ["five-hour-0"]
    assert snap["resetCredits"] is not None
    assert snap["resetCredits"]["availableCount"] == 1
    assert [r.url.host for r in seen] == ["chatgpt.com", "chatgpt.com"]
    assert all(r.headers["Authorization"].startswith("Bearer ") for r in seen)
    assert recorder.phases == ["fetching-reset-credits"]
    assert recorder.sources == [("limits", "success"), ("reset-credits", "success")]


async def test_failed_reset_credits_keep_the_cached_list_stale(tmp_path: Path) -> None:
    write_auth(tmp_path / "home", jwt(FUTURE))

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("reset-credits"):
            return httpx.Response(500, json={})
        return httpx.Response(200, json=USAGE)

    recorder = Recorder()
    ctx = make_ctx(tmp_path, recorder, httpx.MockTransport(handler))
    previous = empty_snapshot("acct")
    previous["resetCredits"] = {"availableCount": 2, "credits": [], "fetchedAt": 5, "stale": False, "error": None}
    snap = await CodexCollector().collect(make_instance(tmp_path / "home"), previous, ctx)
    assert snap["state"] == "ready"
    credits = snap["resetCredits"]
    assert credits is not None
    assert credits["availableCount"] == 2
    assert credits["stale"] is True
    assert credits["error"] is not None
    assert recorder.sources[-1] == ("reset-credits", "failed")


async def test_usage_without_windows_is_a_response_shape_error(tmp_path: Path) -> None:
    write_auth(tmp_path / "home", jwt(FUTURE))
    ctx = make_ctx(tmp_path, Recorder(), httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    snap = await CodexCollector().collect(make_instance(tmp_path / "home"), empty_snapshot("acct"), ctx)
    assert snap["state"] == "error"
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "response-shape"
    assert snap["errorInfo"]["messageId"] == "net.no-usage"


async def test_expired_token_sends_no_request(tmp_path: Path) -> None:
    write_auth(tmp_path / "home", jwt(1))
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=USAGE)

    ctx = make_ctx(tmp_path, Recorder(), httpx.MockTransport(handler))
    snap = await CodexCollector().collect(make_instance(tmp_path / "home"), empty_snapshot("acct"), ctx)
    assert snap["state"] == "error"
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "auth-expired"
    assert seen == []
    assert (tmp_path / "home" / "auth.json").read_text().count(jwt(1)) == 1


async def test_live_usage_disabled_makes_no_request(tmp_path: Path) -> None:
    ctx = make_ctx(tmp_path, Recorder(), httpx.MockTransport(lambda r: httpx.Response(500)))
    snap = await CodexCollector().collect(make_instance(tmp_path, live=False), empty_snapshot("acct"), ctx)
    assert snap["state"] == "unknown"
