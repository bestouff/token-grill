import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, empty_snapshot
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import CollectorContext
from tokengrill.providers.deepseek import auth as auth_module
from tokengrill.providers.deepseek.auth import load_deepseek_key
from tokengrill.providers.deepseek.collector import BALANCE_URL, DeepSeekCollector
from tokengrill.providers.deepseek.normalize import deepseek_key_from_claude_settings, normalize_deepseek_balance
from tokengrill.providers.keyring import TOKEN_GRILL_KEY_SCHEMA
from tokengrill.providers.opencode import auth_file as open_code_auth_file
from tokengrill.providers.opencode.entries import match_open_code_entry
from tokengrill.providers.registry import create_collectors
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.balances import BalanceStore
from tokengrill.storage.checkpoints import CheckpointStore

# --- deepseek.test.mjs


def balance(infos: list[dict[str, Any]]) -> dict[str, Any]:
    return {"is_available": True, "balance_infos": infos}


def test_the_first_finite_balance_is_used() -> None:
    result = normalize_deepseek_balance(
        balance(
            [
                {"currency": "CNY", "total_balance": "not a number", "granted_balance": "0", "topped_up_balance": "0"},
                {"currency": "USD", "total_balance": "12.40", "granted_balance": "0.00", "topped_up_balance": "12.40"},
            ]
        )
    )
    assert result == {"amount": 12.4, "currency": "USD"}


def test_numeric_and_string_amounts_parse_and_no_balance_is_a_response_error() -> None:
    assert normalize_deepseek_balance(balance([{"currency": "CNY", "total_balance": 42.1}])) == {
        "amount": 42.1,
        "currency": "CNY",
    }
    bad: list[object] = [balance([]), {}, None, {"balance_infos": ["x"]}]
    for payload in bad:
        with pytest.raises(ServiceError) as raised:
            normalize_deepseek_balance(payload)
        assert raised.value.code == "response-shape"


def test_a_currency_that_is_not_an_iso_code_is_skipped() -> None:
    result = normalize_deepseek_balance(
        balance(
            [
                {"currency": "usd", "total_balance": "1"},
                {"currency": "USDT", "total_balance": "2"},
                {"currency": "", "total_balance": "3"},
                {"currency": "CNY", "total_balance": "4"},
            ]
        )
    )
    assert result == {"amount": 4, "currency": "CNY"}


def settings(base_url: str, token: str = "sk-deepseek") -> dict[str, object]:
    return {"env": {"ANTHROPIC_BASE_URL": base_url, "ANTHROPIC_AUTH_TOKEN": token}}


def test_claude_code_settings_count_only_when_pointed_at_deepseek() -> None:
    assert deepseek_key_from_claude_settings(settings("https://api.deepseek.com/anthropic")) == "sk-deepseek"
    assert deepseek_key_from_claude_settings(settings("https://API.DeepSeek.com:443/x")) == "sk-deepseek"
    assert deepseek_key_from_claude_settings(settings("https://api.anthropic.com")) is None
    assert deepseek_key_from_claude_settings(settings("https://deepseek.com.evil.example/anthropic")) is None
    assert deepseek_key_from_claude_settings(settings("http://api.deepseek.com")) is None
    assert deepseek_key_from_claude_settings(settings("https://api.deepseek.com/a", "")) is None
    assert deepseek_key_from_claude_settings({}) is None


def test_a_deepseek_key_in_opencode_belongs_to_deepseek() -> None:
    assert match_open_code_entry("deepseek", {"type": "api", "key": "k"}) == {
        "status": "service",
        "kind": "deepseek",
    }


# --- auth and collector


def make_instance(home: Path, app: str = "claude-code", live: bool = True) -> ProviderInstance:
    return {
        "schemaVersion": 2,
        "id": "acct",
        "kind": "deepseek",
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


def write_settings(home: Path, base_url: str = "https://api.deepseek.com/anthropic", token: str = "sk-ds") -> None:
    home.mkdir(parents=True, exist_ok=True)
    (home / "settings.json").write_text(json.dumps(settings(base_url, token)))


def make_ctx(tmp_path: Path, transport: httpx.MockTransport, store: BalanceStore) -> CollectorContext:
    return CollectorContext(
        http=HttpClient(transport=transport),
        pricing={},
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
        balances=store,
    )


def test_collector_is_registered_under_deepseek() -> None:
    assert isinstance(create_collectors()["deepseek"], DeepSeekCollector)


async def test_the_keyring_account_reads_its_own_item(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = fake_keyring(monkeypatch, "sk-keyring")
    assert await load_deepseek_key(make_instance(tmp_path, "keyring")) == "sk-keyring"
    assert calls == [(TOKEN_GRILL_KEY_SCHEMA, {"account": "acct"}, "deepseek.keyring-unavailable")]


async def test_a_missing_keyring_item_is_reported_as_missing_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_keyring(monkeypatch, None)
    with pytest.raises(ServiceError) as raised:
        await load_deepseek_key(make_instance(tmp_path, "keyring"))
    assert (raised.value.code, raised.value.message_id) == ("auth-missing", "deepseek.key-missing")


async def test_a_locked_keyring_is_reported_as_unavailable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_keyring(monkeypatch, ServiceError("dependency", "deepseek.keyring-unavailable"))
    with pytest.raises(ServiceError) as raised:
        await load_deepseek_key(make_instance(tmp_path, "keyring"))
    assert raised.value.message_id == "deepseek.keyring-unavailable"


async def test_the_claude_settings_account_reads_the_key_from_settings(tmp_path: Path) -> None:
    write_settings(tmp_path / "home")
    assert await load_deepseek_key(make_instance(tmp_path / "home")) == "sk-ds"


async def test_settings_pointing_elsewhere_give_no_key(tmp_path: Path) -> None:
    write_settings(tmp_path / "home", "https://api.anthropic.com")
    with pytest.raises(ServiceError) as raised:
        await load_deepseek_key(make_instance(tmp_path / "home"))
    assert raised.value.message_id == "deepseek.key-missing"


async def test_the_opencode_account_reads_the_api_entry(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    auth = tmp_path / "auth.json"
    monkeypatch.setattr(open_code_auth_file, "open_code_auth_path", lambda: str(auth))
    auth.write_text(json.dumps({"deepseek": {"type": "api", "key": "sk-oc"}}))
    assert await load_deepseek_key(make_instance(tmp_path, "opencode")) == "sk-oc"
    auth.write_text(json.dumps({"deepseek": {"type": "oauth", "access": "a"}}))
    with pytest.raises(ServiceError) as raised:
        await load_deepseek_key(make_instance(tmp_path, "opencode"))
    assert raised.value.message_id == "deepseek.key-missing"


async def test_live_collection_reports_the_balance_and_stores_the_reference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_keyring(monkeypatch, "sk-secret")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=balance([{"currency": "USD", "total_balance": "7.00"}]))

    store = BalanceStore(tmp_path / "balances-v1.json")
    ctx = make_ctx(tmp_path, httpx.MockTransport(handler), store)
    snap = await DeepSeekCollector().collect(make_instance(tmp_path, "keyring"), empty_snapshot("acct"), ctx)
    assert snap["state"] == "ready"
    assert snap["balance"] == {"amount": 7.0, "currency": "USD"}
    assert [w["id"] for w in snap["windows"]] == ["balance"]
    assert snap["windows"][0]["percent"] == 0
    assert str(seen[0].url) == BALANCE_URL
    assert seen[0].headers["authorization"] == "Bearer sk-secret"
    assert store.get("acct") == {"currency": "USD", "full": 7.0, "last": 7.0}
    assert json.loads((tmp_path / "balances-v1.json").read_text())["accounts"]["acct"]["full"] == 7.0


async def test_spending_keeps_the_stored_full_amount(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_keyring(monkeypatch, "sk-secret")
    store = BalanceStore(tmp_path / "balances-v1.json")
    store.set("acct", {"currency": "USD", "full": 10.0, "last": 7.0})
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json=balance([{"currency": "USD", "total_balance": "5.00"}]))
    )
    snap = await DeepSeekCollector().collect(
        make_instance(tmp_path, "keyring"), empty_snapshot("acct"), make_ctx(tmp_path, transport, store)
    )
    assert store.get("acct") == {"currency": "USD", "full": 10.0, "last": 5.0}
    assert snap["windows"][0]["percent"] == 0.5


async def test_a_missing_key_gives_an_error_snapshot_without_a_request(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_keyring(monkeypatch, None)
    store = BalanceStore(tmp_path / "balances-v1.json")
    transport = httpx.MockTransport(lambda request: pytest.fail("no request expected"))
    snap = await DeepSeekCollector().collect(
        make_instance(tmp_path, "keyring"), empty_snapshot("acct"), make_ctx(tmp_path, transport, store)
    )
    assert snap["state"] == "error"
    assert snap["errorInfo"] is not None
    assert snap["errorInfo"]["messageId"] == "deepseek.key-missing"


async def test_an_http_failure_never_carries_the_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_keyring(monkeypatch, "sk-secret")
    transport = httpx.MockTransport(lambda request: httpx.Response(401))
    store = BalanceStore(tmp_path / "balances-v1.json")
    snap = await DeepSeekCollector().collect(
        make_instance(tmp_path, "keyring"), empty_snapshot("acct"), make_ctx(tmp_path, transport, store)
    )
    assert snap["state"] == "error"
    assert "sk-secret" not in json.dumps(snap["errorInfo"])
    assert store.get("acct") is None


async def test_live_usage_off_leaves_the_snapshot(tmp_path: Path) -> None:
    transport = httpx.MockTransport(lambda request: pytest.fail("no request expected"))
    store = BalanceStore(tmp_path / "balances-v1.json")
    start = empty_snapshot("acct")
    snap = await DeepSeekCollector().collect(
        make_instance(tmp_path, live=False), start, make_ctx(tmp_path, transport, store)
    )
    assert snap == start
