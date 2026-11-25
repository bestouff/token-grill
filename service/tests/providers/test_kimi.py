import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, empty_snapshot
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.kimi.auth import load_kimi_auth
from tokengrill.providers.kimi.collector import KimiCollector
from tokengrill.providers.kimi.normalize import kimi_api_host, normalize_kimi_usage
from tokengrill.providers.opencode import auth_file as open_code_auth_file
from tokengrill.providers.opencode.entries import match_open_code_entry
from tokengrill.providers.registry import create_collectors
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.checkpoints import CheckpointStore

# --- kimi.test.mjs


def ms(text: str) -> int:
    return int(datetime.fromisoformat(text).timestamp() * 1000)


# Publicly described shape: a weekly `usage` block plus `limits`, numbers as strings.
DESCRIBED: dict[str, Any] = {
    "usage": {"limit": "1000", "used": "250", "remaining": "750", "resetTime": "2026-11-16T00:00:00Z"},
    "limits": [
        {
            "window": {"duration": 300, "timeUnit": "MINUTE"},
            "detail": {"limit": "100", "remaining": "60", "resetTime": "2026-11-10T05:00:00Z"},
        },
        {"name": "Daily", "window": {"duration": 1, "timeUnit": "DAY"}, "detail": {"limit": "50", "used": "5"}},
    ],
}


def test_the_described_usage_and_limits_become_five_hour_weekly_and_other_limits() -> None:
    windows = normalize_kimi_usage(DESCRIBED)
    assert [(w["canonicalWindow"], w["label"], w["percent"], w["resetAt"]) for w in windows] == [
        ("weekly", "Weekly", 0.25, ms("2026-11-16T00:00:00Z")),
        ("five-hour", "Five-hour", 0.4, ms("2026-11-10T05:00:00Z")),
        ("other", "Daily", 0.1, None),
    ]


def test_the_ratio_layout_parses_too() -> None:
    windows = normalize_kimi_usage(
        {
            "usages": {
                "limit_5h": {"used_ratio": 0.3, "reset_time": "2026-11-10T05:00:00Z"},
                "limit_7d": {"used_ratio": 0.5},
                "limit_month_total": {"used_ratio": "0.7"},
            }
        }
    )
    assert [(w["canonicalWindow"], w["percent"]) for w in windows] == [
        ("five-hour", 0.3),
        ("weekly", 0.5),
        ("monthly", 0.7),
    ]


def test_unusable_responses_give_no_limits() -> None:
    assert normalize_kimi_usage({}) == []
    assert normalize_kimi_usage(None) == []
    assert normalize_kimi_usage({"usage": {"limit": "0", "used": "0"}}) == []


def test_the_global_host_is_the_default_the_ai_host_only_when_configured() -> None:
    assert kimi_api_host("") == "api.kimi.com"
    toml = '[providers."managed:kimi-code"]\nbase_url = "https://api.kimi.ai/coding/v1"\n'
    assert kimi_api_host(toml) == "api.kimi.ai"


def test_a_kimi_code_key_in_opencode_belongs_to_kimi_code() -> None:
    assert match_open_code_entry("kimi-for-coding", {"type": "api", "key": "k"}) == {
        "status": "service",
        "kind": "kimi",
    }


def test_a_second_kimi_window_of_the_same_type_stays_a_limit_of_its_own() -> None:
    def limit(name: str, duration: int, unit: str) -> dict[str, Any]:
        return {"name": name, "window": {"duration": duration, "timeUnit": unit}, "detail": {"limit": 100, "used": 10}}

    windows = normalize_kimi_usage({"limits": [limit("Chat", 300, "MINUTE"), limit("Agent", 5, "HOUR")]})
    assert [(w["canonicalWindow"], w["label"]) for w in windows] == [
        ("five-hour", "Five-hour"),
        ("other", "Agent - Five-hour"),
    ]


def test_window_lengths_come_from_the_reported_duration_or_the_key_names() -> None:
    assert [w["durationSeconds"] for w in normalize_kimi_usage(DESCRIBED)] == [None, 5 * 3600, 86400]
    ratio = normalize_kimi_usage(
        {
            "usages": {
                "limit_5h": {"used_ratio": 0.3},
                "limit_7d": {"used_ratio": 0.3},
                "limit_month_total": {"used_ratio": 0.3, "reset_time": "2026-12-01T00:00:00Z"},
            }
        }
    )
    assert [w["durationSeconds"] for w in ratio] == [5 * 3600, 7 * 86400, 30 * 86400]


def test_the_monthly_code_ratio_is_a_labelled_other_window() -> None:
    windows = normalize_kimi_usage({"usages": {"limit_month_code": {"used_ratio": 0.2}}})
    assert [(w["id"], w["canonicalWindow"], w["label"]) for w in windows] == [
        ("limit_month_code", "other", "Monthly Code")
    ]


# --- auth and collector


def make_instance(home: Path, app: str = "kimi-cli", live: bool = True) -> ProviderInstance:
    return {
        "schemaVersion": 2,
        "id": "acct",
        "kind": "kimi",
        "app": app,  # type: ignore[typeddict-item]
        "displayName": "x",
        "accent": "blue",
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


def write_login(home: Path, payload: dict[str, object], config: str | None = None) -> None:
    (home / "credentials").mkdir(parents=True, exist_ok=True)
    (home / "credentials" / "kimi-code.json").write_text(json.dumps(payload))
    if config is not None:
        (home / "config.toml").write_text(config)


def make_ctx(tmp_path: Path, transport: httpx.MockTransport) -> CollectorContext:
    return CollectorContext(
        http=HttpClient(transport=transport),
        pricing={},
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
    )


def test_collector_is_registered_under_kimi() -> None:
    assert isinstance(create_collectors()["kimi"], KimiCollector)


async def test_the_cli_login_gives_token_and_the_global_host(tmp_path: Path) -> None:
    write_login(tmp_path, {"access_token": "kt", "expires_at": 4102444800})
    auth = await load_kimi_auth(make_instance(tmp_path))
    assert auth == {"token": "kt", "host": "api.kimi.com"}


async def test_a_config_toml_with_the_ai_host_selects_it(tmp_path: Path) -> None:
    write_login(tmp_path, {"access_token": "kt"}, 'base_url = "https://api.kimi.ai/coding/v1"\n')
    assert (await load_kimi_auth(make_instance(tmp_path)))["host"] == "api.kimi.ai"


async def test_a_missing_token_or_an_expired_one_is_reported(tmp_path: Path) -> None:
    write_login(tmp_path, {"expires_at": 4102444800})
    with pytest.raises(ServiceError) as missing:
        await load_kimi_auth(make_instance(tmp_path))
    assert (missing.value.code, missing.value.message_id) == ("auth-missing", "kimi.auth-missing")
    write_login(tmp_path, {"access_token": "kt", "expires_at": "2020-01-01T00:00:00Z"})
    with pytest.raises(ServiceError) as expired:
        await load_kimi_auth(make_instance(tmp_path))
    assert (expired.value.code, expired.value.message_id) == ("auth-expired", "kimi.auth-expired")
    assert datetime.now(UTC).year >= 2026


async def test_a_missing_login_file_is_reported(tmp_path: Path) -> None:
    with pytest.raises(ServiceError) as raised:
        await load_kimi_auth(make_instance(tmp_path))
    assert raised.value.code == "auth-missing"


async def test_the_opencode_account_uses_the_api_key_and_the_global_host(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    auth = tmp_path / "auth.json"
    monkeypatch.setattr(open_code_auth_file, "open_code_auth_path", lambda: str(auth))
    auth.write_text(json.dumps({"kimi-for-coding": {"type": "api", "key": "sk-kimi"}}))
    assert await load_kimi_auth(make_instance(tmp_path, "opencode")) == {"token": "sk-kimi", "host": "api.kimi.com"}
    auth.write_text(json.dumps({}))
    with pytest.raises(ServiceError) as raised:
        await load_kimi_auth(make_instance(tmp_path, "opencode"))
    assert raised.value.message_id == "kimi.opencode-key-missing"


async def test_live_collection_requests_the_configured_host(tmp_path: Path) -> None:
    write_login(tmp_path, {"access_token": "kt"}, "api.kimi.ai")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"usages": {"limit_5h": {"used_ratio": 0.25}}})

    snap = await KimiCollector().collect(
        make_instance(tmp_path), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler))
    )
    assert snap["state"] == "ready"
    assert [w["percent"] for w in snap["windows"]] == [0.25]
    assert str(seen[0].url) == "https://api.kimi.ai/coding/v1/usages"
    assert seen[0].headers["authorization"] == "Bearer kt"


async def test_a_response_without_limits_is_a_shape_error(tmp_path: Path) -> None:
    write_login(tmp_path, {"access_token": "kt"})
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json={}))
    snap = await KimiCollector().collect(make_instance(tmp_path), empty_snapshot("acct"), make_ctx(tmp_path, transport))
    assert snap["state"] == "error"
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "response-shape"
    assert snap["errorInfo"]["messageId"] == "net.no-usage"


async def test_live_usage_off_leaves_the_snapshot(tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda request: pytest.fail("no request expected"))
    start = empty_snapshot("acct")
    snap = await KimiCollector().collect(make_instance(tmp_path, live=False), start, make_ctx(tmp_path, transport))
    assert snap == start
