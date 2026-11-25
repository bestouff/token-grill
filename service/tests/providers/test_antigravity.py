import json
import time
from pathlib import Path
from typing import Any

import httpx
import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, RefreshSource, SourceResult, empty_snapshot
from tokengrill.net.http import HttpClient
from tokengrill.providers.antigravity import auth as auth_module
from tokengrill.providers.antigravity import keyring_auth
from tokengrill.providers.antigravity.auth import (
    antigravity_credential_status,
    resolve_antigravity_auth,
)
from tokengrill.providers.antigravity.collector import AntigravityCollector
from tokengrill.providers.antigravity.endpoints import (
    GOOGLE_OAUTH_TOKEN_URL,
    LOAD_CODE_ASSIST_URL,
    RETRIEVE_USER_QUOTA_SUMMARY_URL,
)
from tokengrill.providers.antigravity.keyring_payload import (
    AGY_KEYRING_ATTRIBUTES,
    AGY_KEYRING_SCHEMA,
    parse_agy_keyring_payload,
)
from tokengrill.providers.antigravity.normalize import (
    antigravity_plan,
    extract_quota_summary_buckets,
    normalize_quota_summary,
)
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.registry import create_collectors
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.balances import BalanceStore
from tokengrill.storage.checkpoints import CheckpointStore

# --- antigravity.test.mjs


def _ms(text: str) -> int:
    from datetime import datetime

    return int(datetime.fromisoformat(text).timestamp() * 1000)


def test_request_endpoints_point_to_the_google_cloud_code_apis() -> None:
    assert GOOGLE_OAUTH_TOKEN_URL == "https://oauth2.googleapis.com/token"
    assert LOAD_CODE_ASSIST_URL == "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
    assert RETRIEVE_USER_QUOTA_SUMMARY_URL == "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"


def test_plan_comes_from_the_current_tier_only() -> None:
    assert antigravity_plan({"currentTier": {"id": "standard-tier", "name": "Antigravity Pro"}}) == "Antigravity Pro"
    assert antigravity_plan({"allowedTiers": [], "ineligibleTiers": []}) is None
    assert antigravity_plan(None) is None


def test_cli_keyring_entry_is_addressed_by_the_go_keyring_attribute_pair() -> None:
    assert AGY_KEYRING_ATTRIBUTES == {"service": "gemini", "username": "antigravity"}
    assert AGY_KEYRING_SCHEMA == "org.freedesktop.Secret.Generic"


def test_cli_keyring_payload_parses_the_agy_token_envelope() -> None:
    payload = json.dumps(
        {
            "token": {
                "access_token": "ya29.access-token-value",
                "token_type": "Bearer",
                "refresh_token": "1//refresh-token-value",
                "expiry": "2026-09-14T21:49:50.679262266+05:30",
            },
            "auth_method": "consumer",
            "id_token": "eyJhbGciOi.payload.signature",
        }
    )
    assert parse_agy_keyring_payload(payload) == {
        "accessToken": "ya29.access-token-value",
        "refreshToken": "1//refresh-token-value",
        "expiresAt": _ms("2026-09-14T16:19:50.679+00:00"),
    }


def test_cli_keyring_payload_rejects_unusable_entries() -> None:
    assert parse_agy_keyring_payload("not json") is None
    assert parse_agy_keyring_payload("[]") is None
    assert parse_agy_keyring_payload("{}") is None
    assert parse_agy_keyring_payload(json.dumps({"token": {}})) is None
    assert parse_agy_keyring_payload(json.dumps({"token": {"refresh_token": "only-refresh"}})) is None

    no_expiry = parse_agy_keyring_payload(
        json.dumps({"token": {"access_token": "token-value", "expiry": "not-a-date"}})
    )
    assert no_expiry is not None
    assert no_expiry["expiresAt"] is None
    assert no_expiry["refreshToken"] is None


QUOTA_SUMMARY_PAYLOAD: dict[str, Any] = {
    "groups": [
        {
            "displayName": "Gemini Models",
            "description": "Models within this group: Gemini Flash, Gemini Pro",
            "buckets": [
                {
                    "bucketId": "gemini-weekly",
                    "displayName": "Weekly Limit Remaining",
                    "window": "weekly",
                    "resetTime": "2026-09-14T16:17:29Z",
                    "remainingFraction": 0.64553386,
                },
                {
                    "bucketId": "gemini-5h",
                    "displayName": "Five Hour Limit Remaining",
                    "window": "5h",
                    "resetTime": "2026-09-14T20:42:38Z",
                    "remainingFraction": 0.9877525,
                },
            ],
        },
        {
            "displayName": "Claude and GPT models",
            "buckets": [
                {
                    "bucketId": "3p-weekly",
                    "displayName": "Weekly Limit Remaining",
                    "window": "weekly",
                    "resetTime": "2026-09-21T16:05:39Z",
                    "remainingFraction": 1,
                },
                {
                    "bucketId": "3p-5h",
                    "displayName": "Five Hour Limit Remaining",
                    "window": "5h",
                    "resetTime": "2026-09-14T21:05:39Z",
                    "remainingFraction": 1,
                },
            ],
        },
    ]
}


def test_quota_summary_flattens_every_group_bucket() -> None:
    buckets = extract_quota_summary_buckets(QUOTA_SUMMARY_PAYLOAD)
    assert len(buckets) == 4
    assert buckets[0] == {
        "canonicalWindow": "weekly",
        "remainingFraction": 0.64553386,
        "resetAt": _ms("2026-09-14T16:17:29+00:00"),
    }
    assert buckets[3]["canonicalWindow"] == "five-hour"


def test_quota_summary_reports_one_overall_window_per_canonical_window() -> None:
    windows = normalize_quota_summary(QUOTA_SUMMARY_PAYLOAD)
    assert len(windows) == 2

    five_hour = next(w for w in windows if w["canonicalWindow"] == "five-hour")
    assert five_hour["id"] == "five-hour"
    assert five_hour["label"] == "Five-hour"
    assert five_hour["percent"] is not None
    assert round(five_hour["percent"] * 10000) / 100 == 1.22
    assert five_hour["resetAt"] == _ms("2026-09-14T20:42:38+00:00")
    assert five_hour["durationSeconds"] == 5 * 3600

    weekly = next(w for w in windows if w["canonicalWindow"] == "weekly")
    assert weekly["label"] == "Weekly"
    assert weekly["percent"] is not None
    assert round(weekly["percent"] * 100) == 35
    assert weekly["resetAt"] == _ms("2026-09-14T16:17:29+00:00")
    assert weekly["durationSeconds"] == 7 * 86400
    assert weekly["used"] is None
    assert weekly["limit"] is None
    assert weekly["unit"] is None
    assert weekly["pace"] is None


def test_quota_summary_breaks_remaining_fraction_ties_on_the_earliest_reset() -> None:
    payload = {
        "groups": [
            {"buckets": [{"window": "weekly", "resetTime": "2026-09-20T00:00:00Z", "remainingFraction": 1}]},
            {"buckets": [{"window": "weekly", "resetTime": "2026-09-18T00:00:00Z", "remainingFraction": 1}]},
        ]
    }
    windows = normalize_quota_summary(payload)
    assert len(windows) == 1
    assert windows[0]["resetAt"] == _ms("2026-09-18T00:00:00+00:00")


def test_quota_summary_ignores_unknown_windows_and_malformed_payloads() -> None:
    assert extract_quota_summary_buckets(None) == []
    assert extract_quota_summary_buckets({"groups": "nope"}) == []
    assert (
        extract_quota_summary_buckets({"groups": [{"buckets": [{"window": "hourly", "remainingFraction": 1}]}]}) == []
    )
    assert (
        extract_quota_summary_buckets({"groups": [{"buckets": [{"window": "weekly", "remainingFraction": "high"}]}]})
        == []
    )
    assert normalize_quota_summary(None) == []


# --- auth and collector

FUTURE_MS = int(time.time() * 1000) + 3_600_000
PAST_MS = int(time.time() * 1000) - 3_600_000


def make_instance(home: Path, live: bool = True) -> ProviderInstance:
    return {
        "schemaVersion": 2,
        "id": "acct",
        "kind": "antigravity",
        "app": "antigravity-cli",  # type: ignore[typeddict-item]
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


def write_auth(home: Path, name: str = "acp_token.json", **fields: Any) -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / name).write_text(json.dumps(fields))


def fake_keyring(
    monkeypatch: pytest.MonkeyPatch, result: str | ServiceError | None
) -> list[tuple[str, dict[str, str], str]]:
    calls: list[tuple[str, dict[str, str], str]] = []

    async def lookup(schema: str, attributes: dict[str, str], unavailable_id: str) -> str | None:
        calls.append((schema, attributes, unavailable_id))
        if isinstance(result, ServiceError):
            raise result
        return result

    monkeypatch.setattr(keyring_auth, "lookup_secret", lookup)
    return calls


def keyring_payload(access: str = "agy-access", expires_ms: int = FUTURE_MS, refresh: str = "agy-refresh") -> str:
    from datetime import UTC, datetime

    expiry = datetime.fromtimestamp(expires_ms / 1000, UTC).isoformat()
    return json.dumps({"token": {"access_token": access, "refresh_token": refresh, "expiry": expiry}})


@pytest.fixture(autouse=True)
def _no_real_keyring(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_keyring(monkeypatch, None)


class Recorder:
    def __init__(self) -> None:
        self.sources: list[tuple[RefreshSource, SourceResult]] = []


def make_ctx(tmp_path: Path, transport: httpx.MockTransport, recorder: Recorder | None = None) -> CollectorContext:
    rec = recorder or Recorder()
    return CollectorContext(
        http=HttpClient(transport=transport),
        pricing={},
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
        balances=BalanceStore(tmp_path / "balances.json"),
        on_source=lambda source, result: rec.sources.append((source, result)),
    )


def quota_handler(seen: list[httpx.Request], refresh_status: int = 200) -> Any:
    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        url = str(request.url)
        if url == GOOGLE_OAUTH_TOKEN_URL:
            if refresh_status != 200:
                return httpx.Response(refresh_status, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"access_token": "refreshed", "expires_in": 3600})
        if url == LOAD_CODE_ASSIST_URL:
            return httpx.Response(200, json={"currentTier": {"name": "Antigravity Pro"}})
        assert url == RETRIEVE_USER_QUOTA_SUMMARY_URL
        return httpx.Response(200, json=QUOTA_SUMMARY_PAYLOAD)

    return handler


async def test_a_fresh_file_token_collects_windows_and_plan(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(home, access_token="file-access", expiry_date=FUTURE_MS)
    seen: list[httpx.Request] = []
    snap = await AntigravityCollector().collect(
        make_instance(home), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(quota_handler(seen)))
    )
    assert snap["state"] == "ready"
    assert snap["plan"] == "Antigravity Pro"
    assert [w["id"] for w in snap["windows"]] == ["weekly", "five-hour"]
    assert {str(r.url) for r in seen} == {LOAD_CODE_ASSIST_URL, RETRIEVE_USER_QUOTA_SUMMARY_URL}
    assert all(r.headers["authorization"] == "Bearer file-access" for r in seen)
    assert all(r.method == "POST" and json.loads(r.content) == {} for r in seen)


async def test_live_usage_disabled_reads_nothing(tmp_path: Path) -> None:
    snapshot = empty_snapshot("acct")
    snap = await AntigravityCollector().collect(
        make_instance(tmp_path / "none", live=False),
        snapshot,
        make_ctx(tmp_path, httpx.MockTransport(lambda r: httpx.Response(500))),
    )
    assert snap is snapshot


async def test_an_expired_refreshable_file_token_refreshes_in_memory_and_is_reused(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(
        home, access_token="old", expiry_date=PAST_MS, refresh_token="r1", client_id="cid", client_secret="csecret"
    )
    before = (home / "acp_token.json").read_text()
    seen: list[httpx.Request] = []
    collector = AntigravityCollector()
    ctx = make_ctx(tmp_path, httpx.MockTransport(quota_handler(seen)))
    first = await collector.collect(make_instance(home), empty_snapshot("acct"), ctx)
    second = await collector.collect(make_instance(home), empty_snapshot("acct"), ctx)
    assert first["state"] == second["state"] == "ready"
    refreshes = [r for r in seen if str(r.url) == GOOGLE_OAUTH_TOKEN_URL]
    assert len(refreshes) == 1
    assert json.loads(refreshes[0].content) == {
        "client_id": "cid",
        "client_secret": "csecret",
        "refresh_token": "r1",
        "grant_type": "refresh_token",
    }
    assert refreshes[0].headers["content-type"] == "application/json"
    assert all(r.headers["authorization"] == "Bearer refreshed" for r in seen if str(r.url) != GOOGLE_OAUTH_TOKEN_URL)
    assert (home / "acp_token.json").read_text() == before


async def test_a_refreshed_token_is_not_reused_for_another_refresh_token(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(home, access_token="old", expiry_date=PAST_MS, refresh_token="r1", client_id="c", client_secret="s")
    seen: list[httpx.Request] = []
    collector = AntigravityCollector()
    ctx = make_ctx(tmp_path, httpx.MockTransport(quota_handler(seen)))
    await collector.collect(make_instance(home), empty_snapshot("acct"), ctx)
    write_auth(home, access_token="old", expiry_date=PAST_MS, refresh_token="r2", client_id="c", client_secret="s")
    await collector.collect(make_instance(home), empty_snapshot("acct"), ctx)
    assert len([r for r in seen if str(r.url) == GOOGLE_OAUTH_TOKEN_URL]) == 2


async def test_a_rejected_refresh_is_an_expired_sign_in(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(home, access_token="old", expiry_date=PAST_MS, refresh_token="r1", client_id="c", client_secret="s")
    snap = await AntigravityCollector().collect(
        make_instance(home), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(quota_handler([], 400)))
    )
    assert snap["errorInfo"] is not None
    assert (snap["errorInfo"]["code"], snap["errorInfo"]["messageId"]) == ("auth-expired", "antigravity.auth-expired")


async def test_an_offline_refresh_stays_transient(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(home, access_token="old", expiry_date=PAST_MS, refresh_token="r1", client_id="c", client_secret="s")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down")

    snap = await AntigravityCollector().collect(
        make_instance(home), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler))
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "offline"


async def test_an_expired_file_token_without_a_client_is_expired(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(home, access_token="old", expiry_date=PAST_MS)
    snap = await AntigravityCollector().collect(
        make_instance(home), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(quota_handler([])))
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["messageId"] == "antigravity.auth-expired"


async def test_the_agy_keyring_token_is_used_when_there_is_no_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = fake_keyring(monkeypatch, keyring_payload())
    seen: list[httpx.Request] = []
    snap = await AntigravityCollector().collect(
        make_instance(tmp_path / "none"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, httpx.MockTransport(quota_handler(seen))),
    )
    assert snap["state"] == "ready"
    assert all(r.headers["authorization"] == "Bearer agy-access" for r in seen)
    assert calls == [
        (
            "org.freedesktop.Secret.Generic",
            {"service": "gemini", "username": "antigravity"},
            "antigravity.keyring-unavailable",
        )
    ]


async def test_an_expired_keyring_token_is_never_refreshed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_keyring(monkeypatch, keyring_payload(expires_ms=PAST_MS))
    seen: list[httpx.Request] = []
    snap = await AntigravityCollector().collect(
        make_instance(tmp_path / "none"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, httpx.MockTransport(quota_handler(seen))),
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["messageId"] == "antigravity.agy-expired"
    assert seen == []


async def test_an_unreadable_keyring_payload_is_auth_invalid(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_keyring(monkeypatch, "not json")
    snap = await AntigravityCollector().collect(
        make_instance(tmp_path / "none"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, httpx.MockTransport(quota_handler([]))),
    )
    assert snap["errorInfo"] is not None
    assert (snap["errorInfo"]["code"], snap["errorInfo"]["messageId"]) == (
        "auth-invalid",
        "antigravity.keyring-unreadable",
    )


async def test_a_broken_keyring_explains_more_than_the_missing_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_keyring(monkeypatch, ServiceError("dependency", "antigravity.keyring-unavailable"))
    snap = await AntigravityCollector().collect(
        make_instance(tmp_path / "none"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, httpx.MockTransport(quota_handler([]))),
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["messageId"] == "antigravity.keyring-unavailable"


async def test_nothing_anywhere_is_not_signed_in(tmp_path: Path) -> None:
    snap = await AntigravityCollector().collect(
        make_instance(tmp_path / "none"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, httpx.MockTransport(quota_handler([]))),
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["messageId"] == "antigravity.auth-missing"


async def test_a_file_with_neither_token_is_not_signed_in(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(home, client_id="c")
    snap = await AntigravityCollector().collect(
        make_instance(home), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(quota_handler([])))
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["messageId"] == "antigravity.auth-missing"


async def test_the_first_existing_candidate_file_wins(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(home, "oauth_creds.json", access_token="second", expiry_date=FUTURE_MS)
    write_auth(home, "credentials.json", access_token="third", expiry_date=FUTURE_MS)
    auth = await resolve_antigravity_auth(make_instance(home))
    assert auth.access_token == "second"
    assert auth.source == "file"


async def test_a_live_keyring_token_replaces_a_stale_unrefreshable_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    write_auth(home, access_token="stale", expiry_date=PAST_MS)
    fake_keyring(monkeypatch, keyring_payload())
    auth = await resolve_antigravity_auth(make_instance(home))
    assert (auth.source, auth.access_token) == ("keyring", "agy-access")


async def test_a_refreshable_file_wins_over_the_keyring(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    write_auth(home, access_token="stale", expiry_date=PAST_MS, refresh_token="r", client_id="c", client_secret="s")
    calls = fake_keyring(monkeypatch, keyring_payload())
    auth = await resolve_antigravity_auth(make_instance(home))
    assert auth.source == "file"
    assert calls == []


async def test_a_response_without_usage_is_a_shape_error(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(home, access_token="a", expiry_date=FUTURE_MS)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    snap = await AntigravityCollector().collect(
        make_instance(home), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler))
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "response-shape"


async def test_a_failing_plan_call_does_not_hide_the_limits(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(home, access_token="a", expiry_date=FUTURE_MS)

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == LOAD_CODE_ASSIST_URL:
            return httpx.Response(500, json={})
        return httpx.Response(200, json=QUOTA_SUMMARY_PAYLOAD)

    snap = await AntigravityCollector().collect(
        make_instance(home), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler))
    )
    assert snap["state"] == "ready"
    assert snap["plan"] is None


async def test_a_rejected_token_on_the_plan_call_is_an_error(tmp_path: Path) -> None:
    home = tmp_path / "home"
    write_auth(home, access_token="a", expiry_date=FUTURE_MS)

    def handler(request: httpx.Request) -> httpx.Response:
        if str(request.url) == LOAD_CODE_ASSIST_URL:
            return httpx.Response(401, json={})
        return httpx.Response(200, json=QUOTA_SUMMARY_PAYLOAD)

    snap = await AntigravityCollector().collect(
        make_instance(home), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler))
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "auth-invalid"


async def test_credential_status(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home = tmp_path / "home"
    assert await antigravity_credential_status(make_instance(home)) == "login-required"
    write_auth(home, access_token="a", expiry_date=FUTURE_MS)
    assert await antigravity_credential_status(make_instance(home)) == "authenticated"
    write_auth(home, access_token="a", expiry_date=PAST_MS, refresh_token="r", client_id="c", client_secret="s")
    assert await antigravity_credential_status(make_instance(home)) == "expired-refreshable"
    write_auth(home, access_token="a", expiry_date=PAST_MS)
    assert await antigravity_credential_status(make_instance(home)) == "login-required"
    fake_keyring(monkeypatch, json.dumps({"token": {"access_token": "k"}}))
    (home / "acp_token.json").unlink()
    assert await antigravity_credential_status(make_instance(home)) == "expired-external"
    fake_keyring(monkeypatch, ServiceError("dependency", "antigravity.keyring-unavailable"))
    assert await antigravity_credential_status(make_instance(home)) == "dependency-missing"


def test_the_registry_creates_an_antigravity_collector() -> None:
    assert isinstance(create_collectors()["antigravity"], AntigravityCollector)


def test_module_exports_are_wired() -> None:
    assert auth_module.TOKEN_SKEW_MS == 60 * 1000
