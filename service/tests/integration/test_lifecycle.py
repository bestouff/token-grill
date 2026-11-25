import asyncio
import base64
import json
import logging
import os
import signal
import subprocess
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from dbus_fast import DBusError
from dbus_fast.aio import MessageBus, ProxyInterface

import tokengrill.core.runtime as runtime_module
import tokengrill.providers.deepseek.auth as deepseek_auth
import tokengrill.service as service_module
from conftest import IFACE, NAME, PATH, WAIT, connect, wait_for_name
from tokengrill.core.config import ConfigStore, default_settings, new_provider
from tokengrill.core.errors import ServiceError
from tokengrill.core.types import ProviderInstance, ProviderKind, ProviderSnapshot
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import Collector, CollectorContext
from tokengrill.service import run_service

pytestmark = pytest.mark.integration


async def proxy(bus: MessageBus) -> ProxyInterface:
    introspection = await asyncio.wait_for(bus.introspect(NAME, PATH), WAIT)
    return bus.get_proxy_object(NAME, PATH, introspection).get_interface(IFACE)


@pytest.fixture
def in_process(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """The service runs inside the test, on the private bus, with every folder under the temp dir."""
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    return env


@pytest.fixture
def service_log() -> Iterator[list[logging.LogRecord]]:
    records: list[logging.LogRecord] = []

    class Capture(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    handler = Capture(logging.DEBUG)
    logger = logging.getLogger("tokengrill")
    logger.addHandler(handler)
    yield records
    logger.removeHandler(handler)


async def save_accounts(env: dict[str, str], accounts: list[ProviderInstance]) -> None:
    await ConfigStore(Path(env["XDG_CONFIG_HOME"]) / "token-grill" / "config.json").save(
        {"schema": 1, "accounts": accounts, **default_settings()}
    )


class Sleeper:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.cancelled = False

    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        ctx.record("sign-in", "test")
        self.started.set()
        try:
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return snapshot


async def test_cancel_in_flight_collection_on_stop(in_process: dict[str, str], tmp_path: Path) -> None:
    await save_accounts(in_process, [new_provider("codex", "codex-cli", str(tmp_path / "codex"))])
    sleeper = Sleeper()
    collectors: dict[ProviderKind, Collector] = {"codex": sleeper}
    server = asyncio.create_task(run_service(60, collectors=collectors))
    client = await connect(in_process)
    try:
        await wait_for_name(client)
        await (await proxy(client)).call_hello("shell")  # type: ignore[attr-defined]
        await asyncio.wait_for(sleeper.started.wait(), WAIT)
        os.kill(os.getpid(), signal.SIGTERM)
        assert await asyncio.wait_for(server, WAIT) == 0
    finally:
        client.disconnect()
    assert sleeper.cancelled
    state = Path(in_process["XDG_STATE_HOME"]) / "token-grill"
    entries = json.loads((state / "diagnostics-v1.json").read_text())
    assert any(entry["step"] == "sign-in" for entry in entries["entries"])


class Crasher:
    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        raise RuntimeError("kaboom")


class Fine:
    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        return {**snapshot, "state": "ready", "plan": "Pro", "lastUpdated": 1_800_000_000_000}


async def test_crash_in_one_collector_does_not_stop_others(
    in_process: dict[str, str], tmp_path: Path, service_log: list[logging.LogRecord]
) -> None:
    broken = new_provider("codex", "codex-cli", str(tmp_path / "codex"))
    healthy = new_provider("claude", "claude-code", str(tmp_path / "claude"))
    await save_accounts(in_process, [broken, healthy])
    collectors: dict[ProviderKind, Collector] = {"codex": Crasher(), "claude": Fine()}
    server = asyncio.create_task(run_service(0.5, collectors=collectors))
    client = await connect(in_process)
    try:
        await wait_for_name(client)
        iface = await proxy(client)
        done: dict[str, dict[str, object]] = {}
        arrived = asyncio.Event()

        def seen(account_id: str, text: str) -> None:
            payload = json.loads(text)
            if payload["runtime"]["outcome"] is not None:
                done[account_id] = payload
                if len(done) == 2:
                    arrived.set()

        iface.on_account_changed(seen)  # type: ignore[attr-defined]
        await iface.call_hello("shell")  # type: ignore[attr-defined]
        await asyncio.wait_for(arrived.wait(), WAIT)
    finally:
        client.disconnect()
    assert await asyncio.wait_for(server, WAIT) == 0
    crashed = done[broken["id"]]
    assert crashed["snapshot"]["state"] == "error"  # type: ignore[index]
    assert crashed["snapshot"]["errorInfo"]["messageId"] == "service.internal"  # type: ignore[index]
    assert crashed["runtime"]["outcome"] == "failed"  # type: ignore[index]
    assert done[healthy["id"]]["snapshot"]["plan"] == "Pro"  # type: ignore[index]
    assert done[healthy["id"]]["runtime"]["outcome"] == "changed"  # type: ignore[index]
    errors = [record for record in service_log if record.levelno >= logging.ERROR]
    assert len(errors) == 1
    assert errors[0].exc_info is not None
    assert "kaboom" in "".join(logging.Formatter().formatException(errors[0].exc_info))


async def test_dbus_args_with_bad_json_return_error(env: dict[str, str], service: subprocess.Popen[str]) -> None:
    bus = await connect(env)
    iface = await proxy(bus)
    for call in (
        iface.call_import_accounts,  # type: ignore[attr-defined]
        iface.call_add_accounts,  # type: ignore[attr-defined]
        iface.call_update_account,  # type: ignore[attr-defined]
        iface.call_validate_account,  # type: ignore[attr-defined]
        iface.call_set_settings,  # type: ignore[attr-defined]
    ):
        for text in ("{not json", "", "NaN", "[" * 5000):
            with pytest.raises(DBusError) as bad:
                await asyncio.wait_for(call(text), WAIT)
            assert bad.value.type == f"{NAME}.Error.InvalidArgs"
    # Valid JSON of the wrong shape is a refused request too, never a crash.
    for call in (iface.call_import_accounts, iface.call_add_accounts, iface.call_set_settings):  # type: ignore[attr-defined]
        for text in ("null", "5", '"x"', "[1]", '{"a": 1}'):
            try:
                await asyncio.wait_for(call(text), WAIT)
            except DBusError as error:
                assert error.type == f"{NAME}.Error.InvalidArgs"
    assert service.poll() is None
    assert json.loads(await iface.call_get_state())["schema"] == 1  # type: ignore[attr-defined]
    bus.disconnect()


TOKEN_OK = "tg-secret-token-ok-4f9a1c"
TOKEN_BAD = "tg-secret-token-denied-7b2e5d"
API_KEY = "sk-tg-secret-apikey-9d3c71"
SAVED_KEY = "sk-tg-secret-saved-5a8e02"


def jwt_with(secret: str) -> str:
    exp = int(datetime(2100, 1, 1, tzinfo=UTC).timestamp())
    body = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    return f"{secret}.{body}.{secret}"


async def test_no_secret_in_any_signal(
    in_process: dict[str, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch, service_log: list[logging.LogRecord]
) -> None:
    good_token, bad_token = jwt_with(TOKEN_OK), jwt_with(TOKEN_BAD)
    Path(in_process["HOME"]).mkdir(parents=True, exist_ok=True)
    homes = {"ok": tmp_path / "codex-ok", "bad": tmp_path / "codex-bad"}
    for name, token in (("ok", good_token), ("bad", bad_token)):
        homes[name].mkdir()
        (homes[name] / "auth.json").write_text(json.dumps({"tokens": {"access_token": token, "refresh_token": token}}))
        sessions = homes[name] / "sessions"
        sessions.mkdir()
        (sessions / "rollout.jsonl").write_text(json.dumps({"note": token}) + "\n")

    echoed: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent = request.headers.get("authorization", "")
        if API_KEY in sent:
            echoed.append(sent)
            return httpx.Response(401, json={"error": "denied", "echo": sent, "key": API_KEY})
        if TOKEN_BAD in sent:
            # A hostile or sloppy server that echoes the credential back.
            return httpx.Response(401, json={"error": "denied", "echo": sent})
        usage = {
            "plan_type": "pro",
            "rate_limit": {"primary_window": {"used_percent": 10, "limit_window_seconds": 18000}},
        }
        return httpx.Response(200, json=usage)

    monkeypatch.setattr(service_module, "HttpClient", lambda: HttpClient(httpx.MockTransport(handler)))
    accounts = [new_provider("codex", "codex-cli", str(homes[name])) for name in ("ok", "bad")]
    keyed = new_provider("deepseek", "keyring", "")
    accounts.append(keyed)
    stored: list[tuple[str, str]] = []

    async def lookup(schema: str, attributes: dict[str, str], unavailable_id: str) -> str:
        return API_KEY

    async def store(account_id: str, key: str) -> None:
        stored.append((account_id, key))

    monkeypatch.setattr(deepseek_auth, "lookup_secret", lookup)
    monkeypatch.setattr(runtime_module, "store_api_key", store)
    await save_accounts(in_process, accounts)

    captured: list[str] = []
    server = asyncio.create_task(run_service(0.5))
    client = await connect(in_process)
    try:
        await wait_for_name(client)
        iface = await proxy(client)
        finished: set[str] = set()
        arrived = asyncio.Event()

        def account(account_id: str, text: str) -> None:
            captured.append(text)
            if json.loads(text)["runtime"]["outcome"] is not None:
                finished.add(account_id)
                if len(finished) == 3:
                    arrived.set()

        iface.on_account_changed(account)  # type: ignore[attr-defined]
        iface.on_accounts_changed(captured.append)  # type: ignore[attr-defined]
        iface.on_settings_changed(captured.append)  # type: ignore[attr-defined]
        iface.on_alert(captured.append)  # type: ignore[attr-defined]
        captured.append(await iface.call_hello("shell"))  # type: ignore[attr-defined]
        await asyncio.wait_for(arrived.wait(), WAIT)
        captured.append(await iface.call_get_state())  # type: ignore[attr-defined]
        captured.append(await iface.call_diagnostics_report())  # type: ignore[attr-defined]
        captured.append(await iface.call_discover(""))  # type: ignore[attr-defined]
        for entry in accounts:
            captured.append(await iface.call_credential_state(entry["id"]))  # type: ignore[attr-defined]
            await iface.call_send_test_alert(entry["id"])  # type: ignore[attr-defined]
        await iface.call_save_api_key(keyed["id"], SAVED_KEY)  # type: ignore[attr-defined]
    finally:
        client.disconnect()
    assert await asyncio.wait_for(server, WAIT) == 0
    assert len(captured) > 8
    assert echoed, "the DeepSeek collector never sent the key"
    assert stored == [(keyed["id"], SAVED_KEY)]
    formatter = logging.Formatter()
    logged = [
        record.getMessage() + (formatter.formatException(record.exc_info) if record.exc_info else "")
        for record in service_log
    ]
    everything = "\n".join([*captured, *logged])
    for secret in (TOKEN_OK, TOKEN_BAD, good_token, bad_token, API_KEY, SAVED_KEY):
        assert secret not in everything
    assert "Bearer" not in everything
    state = Path(in_process["XDG_STATE_HOME"]) / "token-grill"
    for written in state.glob("*.json"):
        for secret in (TOKEN_OK, TOKEN_BAD, API_KEY, SAVED_KEY):
            assert secret not in written.read_text()


async def test_goodbye_ends_the_shell_client_on_a_live_connection(in_process: dict[str, str]) -> None:
    server = asyncio.create_task(run_service(0.5, collectors={}))
    client = await connect(in_process)
    try:
        await wait_for_name(client)
        iface = await proxy(client)
        await iface.call_hello("shell")  # type: ignore[attr-defined]
        await asyncio.sleep(0.8)
        assert not server.done()
        await iface.call_goodbye()  # type: ignore[attr-defined]
        assert await asyncio.wait_for(server, WAIT) == 0
    finally:
        client.disconnect()


async def test_add_accounts_stores_a_pasted_key_first_and_maps_a_refusal(
    in_process: dict[str, str], monkeypatch: pytest.MonkeyPatch, service_log: list[logging.LogRecord]
) -> None:
    stored: list[str] = []
    refuse = True

    async def store(account_id: str, key: str) -> None:
        if refuse:
            raise ServiceError("dependency", "deepseek.keyring-unavailable")
        stored.append(account_id)

    monkeypatch.setattr(runtime_module, "store_api_key", store)
    draft = json.dumps([{"kind": "deepseek", "app": "keyring", "accountHome": "", "apiKey": SAVED_KEY}])
    captured: list[str] = []
    server = asyncio.create_task(run_service(0.5, collectors={}))
    client = await connect(in_process)
    try:
        await wait_for_name(client)
        iface = await proxy(client)
        iface.on_accounts_changed(captured.append)  # type: ignore[attr-defined]
        await iface.call_hello("prefs")  # type: ignore[attr-defined]
        with pytest.raises(DBusError) as refused:
            await iface.call_add_accounts(draft)  # type: ignore[attr-defined]
        assert refused.value.type == f"{NAME}.Error.KeyringUnavailable"
        assert json.loads(await iface.call_get_state())["accounts"] == []  # type: ignore[attr-defined]
        refuse = False
        reply = json.loads(await iface.call_add_accounts(draft))  # type: ignore[attr-defined]
        assert stored == reply["ids"]
        state = await iface.call_get_state()  # type: ignore[attr-defined]
        assert [account["app"] for account in json.loads(state)["accounts"]] == ["keyring"]
        captured.append(state)
        await iface.call_goodbye()  # type: ignore[attr-defined]
    finally:
        client.disconnect()
    assert await asyncio.wait_for(server, WAIT) == 0
    logged = "\n".join(record.getMessage() for record in service_log)
    assert SAVED_KEY not in "\n".join([*captured, logged, str(refused.value)])
