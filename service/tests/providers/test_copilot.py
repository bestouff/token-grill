import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, empty_snapshot
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.copilot import auth as auth_module
from tokengrill.providers.copilot.auth import load_copilot_token
from tokengrill.providers.copilot.collector import USAGE_URL, CopilotCollector
from tokengrill.providers.copilot.gh_hosts import parse_gh_hosts
from tokengrill.providers.copilot.normalize import normalize_copilot_usage
from tokengrill.providers.opencode import auth_file as open_code_auth_file
from tokengrill.providers.registry import create_collectors
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.checkpoints import CheckpointStore

# --- copilot.test.mjs

RESET = 1796083200000  # 2026-12-01T00:00:00Z


def snapshot(entitlement: float, percent_remaining: float, **extra: Any) -> dict[str, Any]:
    return {
        "overage_count": 0,
        "overage_permitted": False,
        "percent_remaining": percent_remaining,
        "quota_id": "q",
        "quota_remaining": 0,
        "unlimited": False,
        "timestamp_utc": "2026-11-10T00:00:00.000Z",
        "has_quota": True,
        "quota_reset_at": 0,
        "token_based_billing": False,
        "credits_used": 0,
        "remaining": round(entitlement * percent_remaining / 100),
        "entitlement": entitlement,
        **extra,
    }


def response(snapshots: dict[str, Any], sku: str = "free_limited_copilot") -> dict[str, Any]:
    return {
        "id": 1,
        "login": "someone",
        "access_type_sku": sku,
        "copilot_plan": "individual",
        "chat_enabled": True,
        "quota_snapshots": snapshots,
        "quota_reset_date": "2026-12-01",
        "quota_reset_date_utc": "2026-12-01T00:00:00.000Z",
    }


def test_copilot_free_shows_chat_and_completions_not_premium_requests() -> None:
    windows, plan = _usage(
        response(
            {"chat": snapshot(200, 100), "completions": snapshot(2000, 75), "premium_interactions": snapshot(0, 0)}
        )
    )
    assert plan == "Copilot Free"
    assert [(w["id"], w["canonicalWindow"], w["label"], w["percent"], w["resetAt"]) for w in windows] == [
        ("chat", "other", "Chat", 0, RESET),
        ("completions", "other", "Code Completions", 0.25, RESET),
    ]


def _usage(payload: object) -> tuple[list[Any], str | None]:
    usage = normalize_copilot_usage(payload)
    return usage["windows"], usage["plan"]


def test_a_paid_plans_premium_requests_become_the_monthly_limit() -> None:
    windows, plan = _usage(
        response(
            {
                "chat": snapshot(0, 100, unlimited=True),
                "completions": snapshot(0, 100, unlimited=True),
                "premium_interactions": snapshot(300, 40),
            },
            "monthly_subscriber",
        )
    )
    assert plan == "individual"
    assert [(w["id"], w["canonicalWindow"], w["percent"]) for w in windows] == [
        ("premium_interactions", "monthly", 0.6)
    ]
    assert windows[0]["durationSeconds"] == 30 * 86400


def test_unlimited_snapshots_are_skipped_and_no_usable_snapshot_is_an_unsupported_account() -> None:
    with pytest.raises(ServiceError) as caught:
        normalize_copilot_usage(response({"chat": snapshot(0, 100, unlimited=True)}))
    assert caught.value.code == "unsupported-account"
    assert caught.value.message_id == "copilot.no-limit"
    with pytest.raises(ServiceError) as empty:
        normalize_copilot_usage({})
    assert empty.value.code == "unsupported-account"


def test_the_github_cli_hosts_file_gives_the_active_user_and_a_token_only_when_stored_in_plain_text() -> None:
    keyring = "github.com:\n    git_protocol: https\n    users:\n        alice:\n    user: alice\n"
    assert parse_gh_hosts(keyring) == {"user": "alice", "token": None}
    plain = "github.com:\n    oauth_token: gho_plain\n    git_protocol: https\n    user: bob\n"
    assert parse_gh_hosts(plain) == {"user": "bob", "token": "gho_plain"}
    assert parse_gh_hosts("enterprise.example:\n    user: carol\n") == {"user": None, "token": None}


def test_per_user_entries_and_crlf_line_endings_do_not_confuse_the_hosts_parser() -> None:
    nested = "github.com:\n    users:\n        alice:\n            oauth_token: nested\n    user: alice\n"
    assert parse_gh_hosts(nested) == {"user": "alice", "token": None}
    assert parse_gh_hosts("github.com:\r\n    user: dave\r\n") == {"user": "dave", "token": None}


def test_ai_credits_plans_count_credits_used_out_of_the_entitlement() -> None:
    windows, _ = _usage(
        response(
            {
                "chat": snapshot(0, 100, unlimited=True),
                "premium_interactions": snapshot(300, 99, token_based_billing=True, credits_used=120),
            },
            "monthly_subscriber",
        )
    )
    assert [(w["id"], w["percent"], w["used"], w["limit"], w["unit"]) for w in windows] == [
        ("premium_interactions", 0.4, 120, 300, "credits")
    ]


def test_request_based_plans_keep_the_percentage_the_service_reports() -> None:
    windows, _ = _usage(
        response(
            {"premium_interactions": snapshot(300, 40, token_based_billing=False, credits_used=0)}, "monthly_subscriber"
        )
    )
    assert [(w["percent"], w["unit"]) for w in windows] == [(0.6, None)]


# --- auth and collector

GENERIC = "org.freedesktop.Secret.Generic"


def make_instance(home: Path, app: str = "github-cli", live: bool = True) -> ProviderInstance:
    return {
        "schemaVersion": 2,
        "id": "acct",
        "kind": "copilot",
        "app": app,  # type: ignore[typeddict-item]
        "displayName": "x",
        "accent": "teal",
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


def write_hosts(home: Path, text: str) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "hosts.yml").write_text(text)


def fake_keyring(
    monkeypatch: pytest.MonkeyPatch, result: str | ServiceError | None
) -> list[tuple[str, dict[str, str], str]]:
    calls: list[tuple[str, dict[str, str], str]] = []

    async def lookup(schema: str, attributes: dict[str, str], unavailable_id: str) -> str | None:
        calls.append((schema, attributes, unavailable_id))
        if isinstance(result, ServiceError):
            raise result
        return result

    monkeypatch.setattr(auth_module, "lookup_secret", lookup)
    return calls


def make_ctx(tmp_path: Path, transport: httpx.MockTransport) -> CollectorContext:
    return CollectorContext(
        http=HttpClient(transport=transport),
        pricing={},
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
    )


def usage_handler(seen: list[httpx.Request]) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=response({"premium_interactions": snapshot(300, 40)}, "monthly_subscriber"))

    return handler


async def test_a_plain_text_token_in_hosts_yml_is_used_without_the_keyring(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_keyring(monkeypatch, "unused")
    write_hosts(tmp_path, "github.com:\n    oauth_token: gho_plain\n    user: bob\n")
    assert await load_copilot_token(make_instance(tmp_path)) == "gho_plain"
    assert calls == []


async def test_the_github_cli_keyring_item_is_addressed_by_service_and_user(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_keyring(monkeypatch, "gho_keyring")
    write_hosts(tmp_path, "github.com:\n    user: alice\n")
    assert await load_copilot_token(make_instance(tmp_path)) == "gho_keyring"
    assert calls == [(GENERIC, {"service": "gh:github.com", "username": "alice"}, "copilot.keyring-unavailable")]


async def test_a_github_cli_without_user_or_keyring_item_is_not_signed_in(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_keyring(monkeypatch, None)
    write_hosts(tmp_path, "github.com:\n    git_protocol: https\n")
    with pytest.raises(ServiceError) as no_user:
        await load_copilot_token(make_instance(tmp_path))
    assert (no_user.value.code, no_user.value.message_id) == ("auth-missing", "copilot.github-cli-missing")
    assert calls == []
    write_hosts(tmp_path, "github.com:\n    user: alice\n")
    with pytest.raises(ServiceError) as no_item:
        await load_copilot_token(make_instance(tmp_path))
    assert no_item.value.message_id == "copilot.github-cli-missing"


async def test_a_missing_hosts_file_is_a_missing_credential(tmp_path: Path) -> None:
    with pytest.raises(ServiceError) as caught:
        await load_copilot_token(make_instance(tmp_path / "nowhere"))
    assert caught.value.code == "auth-missing"


async def test_the_copilot_cli_token_comes_from_the_copilot_cli_keyring_item(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_keyring(monkeypatch, "ghu_cli")
    assert await load_copilot_token(make_instance(tmp_path, "copilot-cli")) == "ghu_cli"
    assert calls == [(GENERIC, {"service": "copilot-cli"}, "copilot.keyring-unavailable")]
    fake_keyring(monkeypatch, None)
    with pytest.raises(ServiceError) as caught:
        await load_copilot_token(make_instance(tmp_path, "copilot-cli"))
    assert (caught.value.code, caught.value.message_id) == ("auth-missing", "copilot.cli-missing")


async def test_a_locked_keyring_is_reported_as_unavailable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_keyring(monkeypatch, ServiceError("dependency", "copilot.keyring-unavailable"))
    with pytest.raises(ServiceError) as caught:
        await load_copilot_token(make_instance(tmp_path, "copilot-cli"))
    assert (caught.value.code, caught.value.message_id) == ("dependency", "copilot.keyring-unavailable")


async def test_the_opencode_entry_supplies_the_github_token_from_its_refresh_field(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    auth = tmp_path / "data" / "opencode" / "auth.json"
    auth.parent.mkdir(parents=True)
    auth.write_text(
        json.dumps({"github-copilot": {"type": "oauth", "access": "session", "refresh": "gho_oc", "expires": 0}})
    )
    monkeypatch.setattr(open_code_auth_file, "open_code_auth_path", lambda: str(auth))
    assert await load_copilot_token(make_instance(tmp_path, "opencode")) == "gho_oc"
    auth.write_text("{}")
    with pytest.raises(ServiceError) as caught:
        await load_copilot_token(make_instance(tmp_path, "opencode"))
    assert caught.value.message_id == "opencode.copilot-missing"


async def test_the_collector_requests_usage_with_a_token_header_and_normalizes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_keyring(monkeypatch, None)
    write_hosts(tmp_path, "github.com:\n    oauth_token: gho_plain\n    user: bob\n")
    seen: list[httpx.Request] = []
    snap = await CopilotCollector().collect(
        make_instance(tmp_path), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(usage_handler(seen)))
    )
    assert USAGE_URL == "https://api.github.com/copilot_internal/user"
    assert str(seen[0].url) == USAGE_URL
    assert seen[0].headers["authorization"] == "token gho_plain"
    assert seen[0].headers["accept"] == "application/json"
    assert snap["plan"] == "individual"
    assert [w["id"] for w in snap["windows"]] == ["premium_interactions"]


async def test_the_collector_skips_the_request_when_live_usage_is_off(tmp_path: Path) -> None:
    seen: list[httpx.Request] = []
    start = empty_snapshot("acct")
    snap = await CopilotCollector().collect(
        make_instance(tmp_path, live=False), start, make_ctx(tmp_path, httpx.MockTransport(usage_handler(seen)))
    )
    assert snap == start
    assert seen == []


def test_the_registry_creates_a_copilot_collector() -> None:
    assert isinstance(create_collectors()["copilot"], CopilotCollector)
