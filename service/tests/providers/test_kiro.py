import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from tokengrill.core.errors import ServiceError, http_error
from tokengrill.core.types import ProviderInstance, RefreshPhase, RefreshSource, SourceResult, empty_snapshot
from tokengrill.net.http import KIRO_SERVICE_HOSTS, HttpClient, is_allowed_host, service_error_reason
from tokengrill.providers import sqlite as sqlite_module
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.kiro.auth import (
    KiroAuthRecords,
    is_kiro_refreshable,
    is_kiro_token_fresh,
    kiro_credential_status,
    parse_kiro_auth_records,
)
from tokengrill.providers.kiro.collector import KiroCollector
from tokengrill.providers.kiro.endpoints import (
    SERVICE_HOSTS,
    kiro_oidc_endpoint,
    kiro_usage_request_body,
    kiro_usage_url,
)
from tokengrill.providers.kiro.normalize import normalize_kiro_usage
from tokengrill.providers.kiro.usage_policy import KiroRejectedTokens, kiro_usage_error
from tokengrill.providers.registry import create_collectors
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.balances import BalanceStore
from tokengrill.storage.checkpoints import CheckpointStore

# --- kiro.test.mjs


def test_request_urls_cover_commercial_govcloud_and_iso_partitions() -> None:
    assert kiro_oidc_endpoint("us-east-1") == "https://oidc.us-east-1.amazonaws.com/token"
    assert kiro_usage_url("us-east-1") == "https://codewhisperer.us-east-1.amazonaws.com/"
    assert kiro_usage_url("eu-central-1") == "https://q.eu-central-1.amazonaws.com/"
    assert kiro_usage_url("us-gov-west-1") == "https://q.us-gov-west-1.amazonaws.com/"
    assert kiro_usage_url("us-iso-east-1") == "https://q.us-iso-east-1.c2s.ic.gov/"
    with pytest.raises(ServiceError) as unsupported:
        kiro_usage_url("ap-south-1")
    assert unsupported.value.code == "auth-invalid"
    with pytest.raises(ServiceError) as invalid:
        kiro_oidc_endpoint("us-east-1.evil.example/")
    assert invalid.value.code == "auth-invalid"
    with pytest.raises(ServiceError):
        kiro_oidc_endpoint("us-east-1\n")


def test_every_service_host_and_oidc_host_is_allowed_by_the_client() -> None:
    assert sorted(SERVICE_HOSTS.values()) == sorted(KIRO_SERVICE_HOSTS)
    assert all(is_allowed_host(host) for host in SERVICE_HOSTS.values())
    assert is_allowed_host("oidc.eu-central-1.amazonaws.com")


def test_usage_request_sends_its_parameters_in_the_json_body() -> None:
    assert kiro_usage_request_body(None) == {"isEmailRequired": True}
    arn = "arn:aws:codewhisperer:us-east-1:1:profile/a b"
    assert kiro_usage_request_body(arn) == {"profileArn": arn, "isEmailRequired": True}


def test_feature_not_supported_becomes_an_account_error_rather_than_a_generic_auth_failure() -> None:
    mapped = kiro_usage_error(http_error(403, "FEATURE_NOT_SUPPORTED"))
    assert isinstance(mapped, ServiceError)
    assert mapped.code == "unsupported-account"
    assert mapped.message_id == "kiro.no-usage-account"
    assert mapped.info()["recovery"] == "reauthenticate"
    other = http_error(401, None)
    assert other.code == "auth-invalid"
    assert kiro_usage_error(other) is other
    assert kiro_usage_error(http_error(403, "PERMISSION_DENIED")).args == ("net.http-status",)


def test_rejections_are_remembered_per_instance_and_per_stored_token_only() -> None:
    rejected = KiroRejectedTokens()
    error = ServiceError("unsupported-account", "kiro.no-usage-account")
    assert rejected.remember("instance-c", "token-9", http_error(401, None)) is False
    assert rejected.remember("instance-a", "token-1", error) is True
    assert rejected.get("instance-a", "token-1") is error
    assert rejected.get("instance-a", "token-2") is None
    assert rejected.get("instance-b", "token-1") is None
    rejected.forget("instance-a")
    assert rejected.get("instance-a", "token-1") is None
    assert rejected.remember("instance-a", "token-3", ServiceError("offline", "net.offline")) is False


def test_usage_reports_the_account_email_returned_by_the_service() -> None:
    result = normalize_kiro_usage(
        {
            "usageBreakdownList": [
                {
                    "resourceType": "CREDIT",
                    "currentUsageWithPrecision": 4042.73,
                    "usageLimitWithPrecision": 5000,
                    "nextDateReset": 1793491200,
                }
            ],
            "subscriptionInfo": {"subscriptionTitle": "KIRO PRO MAX"},
            "userInfo": {"email": "someone@example.com", "userId": "d-1.abc"},
        }
    )
    assert result.account == "someone@example.com"
    assert result.plan == "KIRO PRO MAX"
    window = result.windows[0]
    assert window["id"] == "monthly-credits"
    assert window["canonicalWindow"] == "monthly"
    assert window["used"] == 4042.73
    assert window["percent"] == pytest.approx(4042.73 / 5000)
    assert window["resetAt"] == 1793491200000
    assert window["durationSeconds"] == 31 * 86400
    plain = normalize_kiro_usage(
        {"usageBreakdownList": [{"resourceType": "CREDIT", "currentUsage": 1, "usageLimit": 2}]}
    )
    assert plain.account is None
    assert plain.windows[0]["percent"] == 0.5


def test_a_zero_limit_has_no_percentage_and_other_payloads_have_no_windows() -> None:
    zero = normalize_kiro_usage(
        {"usageBreakdownList": [{"resourceType": "CREDIT", "currentUsage": 3, "usageLimit": 0}]}
    )
    assert zero.windows[0]["percent"] is None
    assert normalize_kiro_usage({"usageBreakdownList": [{"resourceType": "OTHER", "currentUsage": 3}]}).windows == []
    assert normalize_kiro_usage([]).windows == []
    assert normalize_kiro_usage({"subscriptionInfo": {"type": "FREE"}}).plan == "FREE"


def test_credential_records_parse_expiry_refresh_material_and_profile_arn() -> None:
    auth = parse_kiro_auth_records(
        KiroAuthRecords(
            token=json.dumps(
                {
                    "access_token": "access-value",
                    "refresh_token": "refresh-value",
                    "expires_at": 1800000000,
                    "region": "us-east-1",
                }
            ),
            registration=json.dumps(
                {"client_id": "client-value", "client_secret": "secret-value", "client_secret_expires_at": 1900000000}
            ),
            profile=json.dumps({"arn": "arn:aws:codewhisperer:us-east-1:1:profile/test", "profile_name": "test"}),
        )
    )
    assert auth.expires_at == 1800000000000
    assert auth.client_secret_expires_at == 1900000000000
    assert auth.profile_arn == "arn:aws:codewhisperer:us-east-1:1:profile/test"
    assert auth.region == "us-east-1"
    assert auth.service_region == "us-east-1"
    assert is_kiro_token_fresh(auth.expires_at, 1700000000000) is True
    assert is_kiro_token_fresh(1700000059999, 1700000000000) is False
    assert is_kiro_refreshable(auth, 1700000000000) is True
    assert is_kiro_refreshable(auth, 1900000000001) is False


def test_the_oidc_login_region_is_separate_from_the_profile_service_region() -> None:
    auth = parse_kiro_auth_records(
        KiroAuthRecords(
            token=json.dumps({"access_token": "access", "expires_at": 1800000000, "region": "ap-south-1"}),
            registration=None,
            profile=json.dumps({"arn": "arn:aws:codewhisperer:eu-central-1:1:profile/test"}),
        )
    )
    assert auth.region == "ap-south-1"
    assert auth.service_region == "eu-central-1"
    assert is_kiro_refreshable(auth) is False


def test_a_builder_id_sign_in_without_a_profile_is_served_from_us_east_1() -> None:
    auth = parse_kiro_auth_records(
        KiroAuthRecords(
            token=json.dumps({"access_token": "a", "expires_at": 1800000000, "region": "ap-south-1"}),
            registration=None,
            profile=None,
        )
    )
    assert auth.service_region == "us-east-1"


def test_credential_errors_never_include_stored_secret_values() -> None:
    secret = "do-not-leak-this-secret"
    with pytest.raises(ServiceError) as raised:
        parse_kiro_auth_records(KiroAuthRecords("{malformed", json.dumps({"client_secret": secret}), None))
    assert secret not in repr(raised.value.info())
    assert raised.value.code == "auth-invalid"
    with pytest.raises(ServiceError) as missing:
        parse_kiro_auth_records(KiroAuthRecords(None, None, None))
    assert missing.value.code == "auth-missing"
    with pytest.raises(ServiceError) as no_expiry:
        parse_kiro_auth_records(KiroAuthRecords(json.dumps({"access_token": "a", "region": "us-east-1"}), None, None))
    assert no_expiry.value.code == "auth-invalid"


def test_service_error_reasons_are_extracted_safely_from_aws_and_oauth_error_bodies() -> None:
    aws = '{"__type":"com.amazon.aws.codewhisperer#AccessDeniedException","message":"FEATURE_NOT_SUPPORTED","reason":"FEATURE_NOT_SUPPORTED"}'
    assert service_error_reason(aws) == "FEATURE_NOT_SUPPORTED"
    no_reason = '{"__type":"com.amazon.aws.codewhisperer#AccessDeniedException","message":"User is not authorized."}'
    assert service_error_reason(no_reason) == "AccessDeniedException"
    assert (
        service_error_reason('{"error":"invalid_grant","error_description":"Invalid refresh token"}') == "invalid_grant"
    )
    assert service_error_reason('{"reason":"contains a secret value aoaAAAA and spaces"}') is None
    assert service_error_reason("not json") is None
    assert service_error_reason("") is None


def test_http_errors_map_rate_limits_and_rejected_sign_ins_to_their_own_codes() -> None:
    assert http_error(429, None).code == "rate-limited"
    assert http_error(401, None).code == "auth-invalid"
    assert http_error(403, "PERMISSION_DENIED").code == "auth-invalid"
    assert http_error(500, None).code == "http"
    assert http_error(429, None).info()["recovery"] == "retry"


# --- database, auth and collector

KIRO_REGION = "us-east-1"
FUTURE_S = int(datetime(2100, 1, 1, tzinfo=UTC).timestamp())


def make_instance(home: Path, live: bool = True) -> ProviderInstance:
    return {
        "schemaVersion": 2,
        "id": "acct",
        "kind": "kiro",
        "app": "kiro-cli",  # type: ignore[typeddict-item]
        "displayName": "x",
        "accent": "purple",
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


def write_database(
    home: Path,
    expires_at: int = FUTURE_S,
    refreshable: bool = False,
    access: str = "access-1",
    profile: bool = True,
) -> Path:
    import sqlite3

    home.mkdir(parents=True, exist_ok=True)
    path = home / "data.sqlite3"
    path.unlink(missing_ok=True)
    token: dict[str, Any] = {"access_token": access, "expires_at": expires_at, "region": KIRO_REGION}
    if refreshable:
        token["refresh_token"] = "refresh-1"
    registration = {"client_id": "client-1", "client_secret": "secret-1", "client_secret_expires_at": FUTURE_S}
    connection = sqlite3.connect(path)
    connection.execute("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    connection.execute("CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)")
    connection.execute("INSERT INTO auth_kv VALUES ('kirocli:odic:token', ?)", (json.dumps(token),))
    connection.execute(
        "INSERT INTO auth_kv VALUES ('kirocli:odic:device-registration', ?)", (json.dumps(registration),)
    )
    if profile:
        arn = f"arn:aws:codewhisperer:{KIRO_REGION}:1:profile/p"
        connection.execute("INSERT INTO state VALUES ('api.codewhisperer.profile', ?)", (json.dumps({"arn": arn}),))
    connection.commit()
    connection.close()
    return path


class Recorder:
    def __init__(self) -> None:
        self.phases: list[RefreshPhase] = []
        self.sources: list[tuple[RefreshSource, SourceResult]] = []


def make_ctx(tmp_path: Path, transport: httpx.MockTransport, manual: bool = False) -> CollectorContext:
    recorder = Recorder()
    return CollectorContext(
        http=HttpClient(transport=transport),
        pricing={},
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
        balances=BalanceStore(tmp_path / "balances.json"),
        on_phase=recorder.phases.append,
        on_source=lambda source, result: recorder.sources.append((source, result)),
        manual=manual,
    )


USAGE = {
    "usageBreakdownList": [
        {
            "resourceType": "CREDIT",
            "currentUsageWithPrecision": 10,
            "usageLimitWithPrecision": 100,
            "nextDateReset": 1793491200,
        }
    ],
    "subscriptionInfo": {"subscriptionTitle": "KIRO PRO"},
    "userInfo": {"email": "someone@example.com"},
}


def test_collector_is_registered_under_kiro() -> None:
    assert isinstance(create_collectors()["kiro"], KiroCollector)


async def test_live_collection_posts_to_the_profile_region_and_fills_the_snapshot(tmp_path: Path) -> None:
    write_database(tmp_path / "home")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=USAGE)

    snap = await KiroCollector().collect(
        make_instance(tmp_path / "home"), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler))
    )
    assert snap["state"] == "ready"
    assert snap["plan"] == "KIRO PRO"
    assert snap["account"] == "someone@example.com"
    assert snap["windows"][0]["percent"] == 0.1
    assert len(seen) == 1
    request = seen[0]
    assert str(request.url) == "https://codewhisperer.us-east-1.amazonaws.com/"
    assert request.method == "POST"
    assert request.headers["authorization"] == "Bearer access-1"
    assert request.headers["x-amz-target"] == "AmazonCodeWhispererService.GetUsageLimits"
    assert request.headers["content-type"] == "application/x-amz-json-1.0"
    assert json.loads(request.content) == {
        "profileArn": "arn:aws:codewhisperer:us-east-1:1:profile/p",
        "isEmailRequired": True,
    }


async def test_live_usage_disabled_makes_no_request_and_reads_nothing(tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda r: httpx.Response(500))
    snapshot = empty_snapshot("acct")
    snap = await KiroCollector().collect(
        make_instance(tmp_path / "none", live=False), snapshot, make_ctx(tmp_path, transport)
    )
    assert snap is snapshot


async def test_a_missing_database_is_not_signed_in(tmp_path: Path) -> None:
    snap = await KiroCollector().collect(
        make_instance(tmp_path / "none"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, httpx.MockTransport(lambda r: httpx.Response(500))),
    )
    assert snap["state"] == "error"
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["messageId"] == "kiro.auth-missing"


async def test_an_unreadable_database_is_auth_invalid_with_the_home_relative_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    home = tmp_path / "home"
    home.mkdir()
    (home / "data.sqlite3").write_bytes(b"this is not an sqlite database at all" * 10)
    snap = await KiroCollector().collect(
        make_instance(home),
        empty_snapshot("acct"),
        make_ctx(tmp_path, httpx.MockTransport(lambda r: httpx.Response(500))),
    )
    info = snap["errorInfo"]
    assert info is not None
    assert (info["code"], info["messageId"]) == ("auth-invalid", "kiro.database-unreadable")
    assert info["params"] == {"path": "~/home/data.sqlite3"}


async def test_the_database_is_read_again_only_after_its_stamp_changes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    write_database(tmp_path / "home")
    opened: list[str] = []
    real = sqlite_module.open_read_only

    def spy(path: str) -> Any:
        opened.append(path)
        return real(path)

    monkeypatch.setattr(sqlite_module, "open_read_only", spy)
    collector = KiroCollector()
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=USAGE))
    instance = make_instance(tmp_path / "home")
    for _ in range(3):
        await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, transport))
    assert len(opened) == 1
    write_database(tmp_path / "home", access="access-2")
    await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, transport))
    assert len(opened) == 2


async def test_feature_not_supported_clears_the_numbers_and_is_not_resent_until_the_token_changes(
    tmp_path: Path,
) -> None:
    write_database(tmp_path / "home")
    calls: list[httpx.Request] = []
    body = {"__type": "com.amazon.aws.codewhisperer#AccessDeniedException", "reason": "FEATURE_NOT_SUPPORTED"}

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(403, json=body)

    collector = KiroCollector()
    instance = make_instance(tmp_path / "home")
    previous = {
        **empty_snapshot("acct"),
        "lastUpdated": 5,
        "plan": "OLD",
        "windows": normalize_kiro_usage(USAGE).windows,
    }
    snap = await collector.collect(instance, previous, make_ctx(tmp_path, httpx.MockTransport(handler)))  # type: ignore[arg-type]
    assert snap["state"] == "error"
    assert snap["windows"] == []
    assert snap["plan"] is None
    assert snap["errorInfo"] is not None
    assert (snap["errorInfo"]["code"], snap["errorInfo"]["messageId"]) == (
        "unsupported-account",
        "kiro.no-usage-account",
    )
    assert len(calls) == 1
    await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler)))
    assert len(calls) == 1
    await collector.collect(
        instance, empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler), manual=True)
    )
    assert len(calls) == 2
    write_database(tmp_path / "home", access="access-2")
    await collector.collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler)))
    assert len(calls) == 3


async def test_a_plain_401_keeps_the_last_values_stale_and_is_retried(tmp_path: Path) -> None:
    write_database(tmp_path / "home")
    calls: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(401, json={})

    collector = KiroCollector()
    instance = make_instance(tmp_path / "home")
    previous = {**empty_snapshot("acct"), "lastUpdated": 5, "plan": "OLD"}
    snap = await collector.collect(instance, previous, make_ctx(tmp_path, httpx.MockTransport(handler)))  # type: ignore[arg-type]
    assert snap["state"] == "stale"
    assert snap["plan"] == "OLD"
    await collector.collect(instance, previous, make_ctx(tmp_path, httpx.MockTransport(handler)))  # type: ignore[arg-type]
    assert len(calls) == 2


async def test_usage_without_windows_is_a_response_shape_error(tmp_path: Path) -> None:
    write_database(tmp_path / "home")
    snap = await KiroCollector().collect(
        make_instance(tmp_path / "home"),
        empty_snapshot("acct"),
        make_ctx(tmp_path, httpx.MockTransport(lambda r: httpx.Response(200, json={}))),
    )
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "response-shape"


async def test_an_expired_token_without_refresh_material_is_auth_expired_and_sends_nothing(tmp_path: Path) -> None:
    write_database(tmp_path / "home", expires_at=1000)
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json=USAGE)

    collector = KiroCollector()
    snap = await collector.collect(
        make_instance(tmp_path / "home"), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler))
    )
    assert snap["errorInfo"] is not None
    assert (snap["errorInfo"]["code"], snap["errorInfo"]["messageId"]) == ("auth-expired", "kiro.auth-expired")
    assert calls == []
    # auth-expired depends only on the stored credentials, so it is remembered until they change.
    await collector.collect(
        make_instance(tmp_path / "home"), empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler))
    )
    assert calls == []


async def test_an_expired_token_is_refreshed_in_memory_and_the_database_is_untouched(tmp_path: Path) -> None:
    path = write_database(tmp_path / "home", expires_at=1000, refreshable=True)
    before = path.read_bytes()
    before_listing = sorted(p.name for p in path.parent.iterdir())
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if request.url.host == "oidc.us-east-1.amazonaws.com":
            return httpx.Response(
                200, json={"accessToken": "fresh-token", "expiresIn": 3600, "refreshToken": "refresh-2"}
            )
        return httpx.Response(200, json=USAGE)

    collector = KiroCollector()
    instance = make_instance(tmp_path / "home")
    for _ in range(2):
        snap = await collector.collect(
            instance, empty_snapshot("acct"), make_ctx(tmp_path, httpx.MockTransport(handler))
        )
        assert snap["state"] == "ready"
    hosts = [call.url.host for call in calls]
    assert hosts == [
        "oidc.us-east-1.amazonaws.com",
        "codewhisperer.us-east-1.amazonaws.com",
        "codewhisperer.us-east-1.amazonaws.com",
    ]
    refresh = json.loads(calls[0].content)
    assert refresh == {
        "clientId": "client-1",
        "clientSecret": "secret-1",
        "grantType": "refresh_token",
        "refreshToken": "refresh-1",
    }
    assert str(calls[0].url) == "https://oidc.us-east-1.amazonaws.com/token"
    assert calls[1].headers["authorization"] == "Bearer fresh-token"
    assert path.read_bytes() == before
    assert sorted(p.name for p in path.parent.iterdir()) == before_listing


async def test_a_refresh_the_service_rejects_is_auth_expired_but_an_outage_is_not(tmp_path: Path) -> None:
    write_database(tmp_path / "home", expires_at=1000, refreshable=True)
    instance = make_instance(tmp_path / "home")
    rejected = httpx.MockTransport(lambda r: httpx.Response(400, json={"error": "invalid_grant"}))
    snap = await KiroCollector().collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, rejected))
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "auth-expired"
    limited = httpx.MockTransport(lambda r: httpx.Response(429, json={}))
    snap = await KiroCollector().collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, limited))
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "rate-limited"
    malformed = httpx.MockTransport(lambda r: httpx.Response(200, json={"accessToken": "x"}))
    snap = await KiroCollector().collect(instance, empty_snapshot("acct"), make_ctx(tmp_path, malformed))
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["code"] == "auth-expired"


async def test_credential_status_covers_fresh_refreshable_expired_missing_and_unreadable(tmp_path: Path) -> None:
    assert await kiro_credential_status(make_instance(tmp_path / "none")) == "login-required"
    write_database(tmp_path / "fresh")
    assert await kiro_credential_status(make_instance(tmp_path / "fresh")) == "authenticated"
    write_database(tmp_path / "refresh", expires_at=1000, refreshable=True)
    assert await kiro_credential_status(make_instance(tmp_path / "refresh")) == "expired-refreshable"
    write_database(tmp_path / "old", expires_at=1000)
    assert await kiro_credential_status(make_instance(tmp_path / "old")) == "login-required"
    (tmp_path / "bad").mkdir()
    (tmp_path / "bad" / "data.sqlite3").write_bytes(b"garbage" * 100)
    assert await kiro_credential_status(make_instance(tmp_path / "bad")) == "database-unreadable"
