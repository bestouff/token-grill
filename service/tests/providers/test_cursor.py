"""Cursor usage limits."""

import base64
import json
import sqlite3
from pathlib import Path
from typing import Any

import httpx
import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, ProviderSnapshot, empty_snapshot
from tokengrill.net.http import HttpClient
from tokengrill.providers import sqlite as sqlite_module
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.cursor.auth import cursor_credential_status, read_cursor_agent_auth
from tokengrill.providers.cursor.collector import CursorCollector
from tokengrill.providers.cursor.normalize import is_jwt_like, normalize_cursor_plan, normalize_cursor_usage
from tokengrill.providers.registry import create_collectors
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.balances import BalanceStore
from tokengrill.storage.checkpoints import CheckpointStore

# --- cursor.test.mjs

# The keys of a real GetCurrentPeriodUsage response (Free plan, 2026-11-18); the numbers are changed.
USAGE: dict[str, Any] = {
    "billingCycleStart": "1792758535685",
    "billingCycleEnd": "1795436935685",
    "planUsage": {
        "remainingBonus": False,
        "bonusTooltip": "text",
        "autoPercentUsed": 40,
        "apiPercentUsed": 12.5,
        "totalPercentUsed": 30,
    },
    "spendLimitUsage": {"pooledLimit": "0", "limitType": "user", "overallLimit": 0},
    "displayThreshold": 200,
    "autoBucketModels": ["model-a", "model-b"],
}


def test_the_total_and_both_pools_reset_at_the_end_of_the_monthly_billing_cycle() -> None:
    windows = normalize_cursor_usage(USAGE)
    assert [(w["id"], w["canonicalWindow"], w["label"], w["percent"], w["resetAt"]) for w in windows] == [
        ("total", "monthly", "Monthly", 0.3, 1795436935685),
        ("cursor-models", "other", "Cursor Models - Monthly", 0.4, 1795436935685),
        ("other-models", "other", "Other Models - Monthly", 0.125, 1795436935685),
    ]


def test_a_weekly_cycle_makes_weekly_limits() -> None:
    week = 7 * 24 * 60 * 60 * 1000
    total = normalize_cursor_usage({**USAGE, "billingCycleEnd": str(1792758535685 + week)})[0]
    assert total["canonicalWindow"] == "weekly"


def test_percentages_are_clamped_and_missing_pools_are_left_out() -> None:
    windows = normalize_cursor_usage({**USAGE, "planUsage": {"totalPercentUsed": 140}})
    assert [(w["id"], w["percent"]) for w in windows] == [("total", 1)]


def test_responses_without_plan_usage_give_no_limits() -> None:
    assert normalize_cursor_usage({}) == []
    assert normalize_cursor_usage(None) == []
    assert normalize_cursor_usage({"planUsage": {"remainingBonus": False}}) == []


def test_the_plan_name_comes_from_get_plan_info() -> None:
    assert normalize_cursor_plan({"planInfo": {"planName": "Free", "price": "Free"}}) == "Free"
    assert normalize_cursor_plan({}) is None


def test_only_a_plain_jwt_counts_as_a_readable_sign_in() -> None:
    assert is_jwt_like("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln") is True
    assert is_jwt_like("cursor-safe-storage:v1:djExAAAA") is False
    assert is_jwt_like("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0") is False
    assert is_jwt_like("") is False


def test_the_billing_cycle_gives_the_length_of_every_pool_for_usage_pace() -> None:
    assert normalize_cursor_usage(USAGE)[0]["durationSeconds"] == (1795436935685 - 1792758535685) / 1000
    without_start = {k: v for k, v in USAGE.items() if k != "billingCycleStart"}
    assert normalize_cursor_usage(without_start)[0]["durationSeconds"] is None


# --- collector

FUTURE = 4102444800  # 2100-01-01


def make_jwt(sub: str = "user-1", exp: int = FUTURE) -> str:
    def part(data: dict[str, Any]) -> str:
        return base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")

    return f"{part({'alg': 'none'})}.{part({'sub': sub, 'exp': exp})}.c2ln"


def make_instance(home: Path, app: str = "cursor", live: bool = True) -> ProviderInstance:
    return {
        "schemaVersion": 2,
        "id": "acct",
        "kind": "cursor",
        "app": app,  # type: ignore[typeddict-item]
        "displayName": "x",
        "accent": "slate",
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


def write_database(home: Path, token: str | None, email: str | None = "me@example.com") -> Path:
    path = home / "User" / "globalStorage" / "state.vscdb"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)")
    if token is not None:
        connection.execute("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', ?)", (token,))
    if email is not None:
        connection.execute("INSERT INTO ItemTable VALUES ('cursorAuth/cachedEmail', ?)", (email,))
    connection.commit()
    connection.close()
    return path


def make_ctx(tmp_path: Path, transport: httpx.MockTransport, manual: bool = False) -> CollectorContext:
    return CollectorContext(
        http=HttpClient(transport=transport),
        pricing={},
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
        balances=BalanceStore(tmp_path / "balances.json"),
        manual=manual,
    )


class Server:
    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.plan = "Pro"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.url.path.endswith("/GetCurrentPeriodUsage"):
            return httpx.Response(200, json=USAGE)
        return httpx.Response(200, json={"planInfo": {"planName": self.plan}})

    def calls(self, name: str) -> int:
        return sum(1 for r in self.requests if r.url.path.endswith(name))


def spy_on_opens(monkeypatch: pytest.MonkeyPatch) -> list[str]:
    opened: list[str] = []
    real = sqlite_module.open_read_only

    def spy(path: str) -> Any:
        opened.append(path)
        return real(path)

    monkeypatch.setattr(sqlite_module, "open_read_only", spy)
    return opened


def test_collector_is_registered_under_cursor() -> None:
    assert isinstance(create_collectors()["cursor"], CursorCollector)


async def test_app_collection_posts_connect_requests_and_fills_the_snapshot(tmp_path: Path) -> None:
    token = make_jwt()
    write_database(tmp_path / "home", token)
    server = Server()
    snap = await CursorCollector().collect(
        make_instance(tmp_path / "home"), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(server))
    )
    assert snap["state"] == "ready"
    assert snap["plan"] == "Pro"
    assert snap["account"] == "me@example.com"
    assert [w["id"] for w in snap["windows"]] == ["total", "cursor-models", "other-models"]
    first = server.requests[0]
    assert first.method == "POST"
    assert str(first.url) == "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
    assert first.headers["authorization"] == f"Bearer {token}"
    assert first.headers["connect-protocol-version"] == "1"
    assert first.headers["content-type"] == "application/json"
    assert first.headers["accept"] == "application/json"
    assert json.loads(first.content) == {}


async def test_live_usage_disabled_makes_no_request_and_reads_nothing(tmp_path: Path) -> None:
    server = Server()
    previous = empty_snapshot("acct")
    snap = await CursorCollector().collect(
        make_instance(tmp_path / "none", live=False), previous, make_ctx(tmp_path, httpx.MockTransport(server))
    )
    assert snap == previous
    assert server.requests == []


async def test_a_missing_database_is_not_signed_in(tmp_path: Path) -> None:
    snap = await CursorCollector().collect(
        make_instance(tmp_path / "none"), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(Server()))
    )
    assert snap["state"] == "error"
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["messageId"] == "cursor.auth-missing"


async def test_an_encrypted_sign_in_is_an_unsupported_account_and_sends_nothing(tmp_path: Path) -> None:
    write_database(tmp_path / "home", "cursor-safe-storage:v1:djExAAAA")
    server = Server()
    snap = await CursorCollector().collect(
        make_instance(tmp_path / "home"), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(server))
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "unsupported-account"
    assert snap["errorInfo"]["messageId"] == "cursor.encrypted"
    assert server.requests == []


async def test_a_database_without_the_table_is_auth_invalid_with_the_home_relative_path(tmp_path: Path) -> None:
    path = tmp_path / "home" / "User" / "globalStorage" / "state.vscdb"
    path.parent.mkdir(parents=True)
    path.write_bytes(b"garbage" * 100)
    snap = await CursorCollector().collect(
        make_instance(tmp_path / "home"), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(Server()))
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "auth-invalid"
    assert snap["errorInfo"]["messageId"] == "cursor.database-unreadable"


async def test_an_expired_token_is_auth_expired_and_sends_nothing(tmp_path: Path) -> None:
    write_database(tmp_path / "home", make_jwt(exp=1000))
    server = Server()
    snap = await CursorCollector().collect(
        make_instance(tmp_path / "home"), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(server))
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "auth-expired"
    assert server.requests == []


async def test_usage_without_windows_is_a_response_shape_error(tmp_path: Path) -> None:
    write_database(tmp_path / "home", make_jwt())
    snap = await CursorCollector().collect(
        make_instance(tmp_path / "home"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, httpx.MockTransport(lambda r: httpx.Response(200, json={}))),
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "response-shape"


async def test_the_database_is_read_again_only_after_its_stamp_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_database(tmp_path / "home", make_jwt())
    opened = spy_on_opens(monkeypatch)
    collector = CursorCollector()
    instance = make_instance(tmp_path / "home")
    transport = httpx.MockTransport(Server())
    for _ in range(3):
        await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, transport))
    assert len(opened) == 1
    write_database(tmp_path / "home", make_jwt(sub="user-2"))
    await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, transport))
    assert len(opened) == 2


async def test_failed_read_is_not_repeated_until_database_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_database(tmp_path / "home", "cursor-safe-storage:v1:djExAAAA")
    opened = spy_on_opens(monkeypatch)
    collector = CursorCollector()
    instance = make_instance(tmp_path / "home")
    server = Server()
    transport = httpx.MockTransport(server)
    for _ in range(3):
        snap = await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, transport))
        assert snap["errorInfo"] is not None
        assert snap["errorInfo"]["messageId"] == "cursor.encrypted"
    assert len(opened) == 1
    write_database(tmp_path / "home", make_jwt())
    snap = await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, transport))
    assert len(opened) == 2
    assert snap["state"] == "ready"


async def test_the_plan_is_asked_for_again_only_for_a_new_sign_in_cycle_or_manual_refresh(tmp_path: Path) -> None:
    write_database(tmp_path / "home", make_jwt())
    collector = CursorCollector()
    instance = make_instance(tmp_path / "home")
    server = Server()
    transport = httpx.MockTransport(server)
    for _ in range(3):
        await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, transport))
    assert server.calls("/GetPlanInfo") == 1
    assert server.calls("/GetCurrentPeriodUsage") == 3
    server.plan = "Ultra"
    snap = await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, transport, manual=True))
    assert server.calls("/GetPlanInfo") == 2
    assert snap["plan"] == "Ultra"
    write_database(tmp_path / "home", make_jwt(sub="user-2"))
    await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, transport))
    assert server.calls("/GetPlanInfo") == 3


async def test_a_switch_to_another_account_starts_from_an_empty_snapshot(tmp_path: Path) -> None:
    write_database(tmp_path / "home", make_jwt(sub="user-1"))
    collector = CursorCollector()
    instance = make_instance(tmp_path / "home")
    good = httpx.MockTransport(Server())
    previous: ProviderSnapshot = await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, good))
    assert previous["state"] == "ready"
    failing = httpx.MockTransport(lambda r: httpx.Response(500, json={}))
    same = await collector.collect(instance, previous, make_ctx(tmp_path, failing))
    assert same["state"] == "stale"
    assert same["windows"] == previous["windows"]
    write_database(tmp_path / "home", make_jwt(sub="user-2"))
    switched = await collector.collect(instance, previous, make_ctx(tmp_path, failing))
    assert switched["state"] == "error"
    assert switched["windows"] == []


async def test_the_cli_sign_in_is_read_from_auth_json(tmp_path: Path) -> None:
    home = tmp_path / "cli"
    home.mkdir()
    token = make_jwt()
    (home / "auth.json").write_text(json.dumps({"accessToken": token}))
    server = Server()
    snap = await CursorCollector().collect(
        make_instance(home, app="cursor-agent"), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(server))
    )
    assert snap["state"] == "ready"
    assert snap["account"] is None
    assert server.requests[0].headers["authorization"] == f"Bearer {token}"


async def test_the_cli_without_a_token_or_with_an_encrypted_one_is_reported(tmp_path: Path) -> None:
    path = tmp_path / "auth.json"
    path.write_text("{}")
    with pytest.raises(ServiceError) as missing:
        await read_cursor_agent_auth(str(path))
    assert missing.value.message_id == "cursor.cli-missing"
    path.write_text(json.dumps({"accessToken": "cursor-safe-storage:v1:x"}))
    with pytest.raises(ServiceError) as encrypted:
        await read_cursor_agent_auth(str(path))
    assert encrypted.value.code == "unsupported-account"


async def test_credential_status_covers_fresh_expired_encrypted_missing_and_unreadable(tmp_path: Path) -> None:
    assert await cursor_credential_status(make_instance(tmp_path / "none")) == "login-required"
    write_database(tmp_path / "fresh", make_jwt())
    assert await cursor_credential_status(make_instance(tmp_path / "fresh")) == "authenticated"
    write_database(tmp_path / "old", make_jwt(exp=1000))
    assert await cursor_credential_status(make_instance(tmp_path / "old")) == "login-required"
    write_database(tmp_path / "enc", "cursor-safe-storage:v1:x")
    assert await cursor_credential_status(make_instance(tmp_path / "enc")) == "database-unreadable"
    cli = tmp_path / "cli"
    cli.mkdir()
    (cli / "auth.json").write_text(json.dumps({"accessToken": make_jwt()}))
    assert await cursor_credential_status(make_instance(cli, app="cursor-agent")) == "authenticated"
