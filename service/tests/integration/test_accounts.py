import asyncio
import json
import subprocess
from pathlib import Path

import pytest
from dbus_fast import DBusError
from dbus_fast.aio import MessageBus, ProxyInterface

from conftest import IFACE, NAME, PATH, WAIT, connect
from tokengrill.core.config import default_settings, new_provider

pytestmark = pytest.mark.integration


async def proxy(bus: MessageBus) -> ProxyInterface:
    introspection = await asyncio.wait_for(bus.introspect(NAME, PATH), WAIT)
    return bus.get_proxy_object(NAME, PATH, introspection).get_interface(IFACE)


class Signals:
    def __init__(self, iface: ProxyInterface) -> None:
        self.accounts: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        self.settings: asyncio.Queue[dict[str, object]] = asyncio.Queue()
        iface.on_accounts_changed(lambda text: self.accounts.put_nowait(json.loads(text)))  # type: ignore[attr-defined]
        iface.on_settings_changed(lambda text: self.settings.put_nowait(json.loads(text)))  # type: ignore[attr-defined]


async def next_signal(queue: "asyncio.Queue[dict[str, object]]") -> dict[str, object]:
    return await asyncio.wait_for(queue.get(), WAIT)


async def add_codex(iface: ProxyInterface, home: Path, name: str = "Codex") -> str:
    reply = json.loads(
        await iface.call_add_accounts(  # type: ignore[attr-defined]
            json.dumps([{"kind": "codex", "accountHome": str(home), "displayName": name}])
        )
    )
    assert reply["schema"] == 1
    return str(reply["ids"][0])


async def test_add_invalid_account_returns_field_errors(env: dict[str, str], service: subprocess.Popen[str]) -> None:
    bus = await connect(env)
    iface = await proxy(bus)
    signals = Signals(iface)
    reply = json.loads(
        await iface.call_add_accounts(json.dumps([{"kind": "codex", "accountHome": "relative"}]))  # type: ignore[attr-defined]
    )
    assert reply["errors"] == {"0": {"accountHome": "not-absolute"}}
    assert "ids" not in reply
    state = json.loads(await iface.call_get_state())  # type: ignore[attr-defined]
    assert state["accounts"] == []
    assert signals.accounts.empty()
    with pytest.raises(DBusError) as bad:
        await iface.call_add_accounts("not json")  # type: ignore[attr-defined]
    assert bad.value.type == f"{NAME}.Error.InvalidArgs"
    bus.disconnect()


async def test_add_update_reorder_remove_emit_accounts_changed(
    env: dict[str, str], service: subprocess.Popen[str], tmp_path: Path
) -> None:
    bus = await connect(env)
    iface = await proxy(bus)
    signals = Signals(iface)
    first = await add_codex(iface, tmp_path / "one", "One")
    assert [a["id"] for a in (await next_signal(signals.accounts))["accounts"]] == [first]  # type: ignore[attr-defined]
    second = await add_codex(iface, tmp_path / "two", "Two")
    await next_signal(signals.accounts)

    updated = json.loads(
        await iface.call_update_account(json.dumps({"id": first, "displayName": "Renamed"}))  # type: ignore[attr-defined]
    )
    assert updated["errors"] == {}
    accounts = (await next_signal(signals.accounts))["accounts"]
    assert accounts[0]["displayName"] == "Renamed"  # type: ignore[index]
    clash = json.loads(
        await iface.call_update_account(json.dumps({"id": first, "accountHome": str(tmp_path / "two")}))  # type: ignore[attr-defined]
    )
    assert clash["errors"] == {"accountHome": "duplicate-home"}

    await iface.call_reorder_accounts([second, first])  # type: ignore[attr-defined]
    accounts = (await next_signal(signals.accounts))["accounts"]
    assert [a["id"] for a in accounts] == [second, first]  # type: ignore[attr-defined]

    await iface.call_remove_account(first, False)  # type: ignore[attr-defined]
    accounts = (await next_signal(signals.accounts))["accounts"]
    assert [a["id"] for a in accounts] == [second]  # type: ignore[attr-defined]
    validated = json.loads(
        await iface.call_validate_account(  # type: ignore[attr-defined]
            json.dumps({"kind": "codex", "displayName": "x", "accountHome": str(tmp_path / "two")})
        )
    )
    assert validated["errors"] == {"accountHome": "duplicate-home"}
    bus.disconnect()


async def test_toggle_limit_emits_accounts_changed(
    env: dict[str, str], service: subprocess.Popen[str], tmp_path: Path
) -> None:
    bus = await connect(env)
    iface = await proxy(bus)
    signals = Signals(iface)
    account = await add_codex(iface, tmp_path / "one")
    await next_signal(signals.accounts)
    await iface.call_toggle_limit(account, "weekly")  # type: ignore[attr-defined]
    top_bar = (await next_signal(signals.accounts))["accounts"][0]["topBar"]  # type: ignore[index]
    assert top_bar == {"automatic": False, "limits": ["weekly"]}
    await iface.call_set_automatic(account, True)  # type: ignore[attr-defined]
    top_bar = (await next_signal(signals.accounts))["accounts"][0]["topBar"]  # type: ignore[index]
    assert top_bar == {"automatic": True, "limits": []}
    with pytest.raises(DBusError) as unknown:
        await iface.call_toggle_limit("nope", "weekly")  # type: ignore[attr-defined]
    assert unknown.value.type == f"{NAME}.Error.InvalidArgs"
    bus.disconnect()


async def test_settings_out_of_range_are_rejected(env: dict[str, str], service: subprocess.Popen[str]) -> None:
    bus = await connect(env)
    iface = await proxy(bus)
    signals = Signals(iface)
    for bad in ({"refreshIntervalSeconds": 59}, {"refreshIntervalSeconds": 3601}, {"alertStepPercent": 99}):
        with pytest.raises(DBusError) as raised:
            await iface.call_set_settings(json.dumps(bad))  # type: ignore[attr-defined]
        assert raised.value.type == f"{NAME}.Error.InvalidArgs"
    state = json.loads(await iface.call_get_state())  # type: ignore[attr-defined]
    assert state["settings"]["refreshIntervalSeconds"] == default_settings()["refreshIntervalSeconds"]
    assert signals.settings.empty()
    await iface.call_set_settings(json.dumps({"refreshIntervalSeconds": 120}))  # type: ignore[attr-defined]
    changed = await next_signal(signals.settings)
    assert changed["settings"]["refreshIntervalSeconds"] == 120  # type: ignore[index]
    state = json.loads(await iface.call_get_state())  # type: ignore[attr-defined]
    assert state["settings"]["refreshIntervalSeconds"] == 120
    bus.disconnect()


def legacy_json(tmp_path: Path) -> str:
    entry = new_provider("codex", "codex-cli", str(tmp_path / "legacy"))
    return json.dumps(
        {
            "providerInstancesJson": json.dumps([entry]),
            "configurationVersion": 3,
            "activeProviderId": "",
            "refreshIntervalSeconds": 120,
            "notificationsEnabled": True,
            "notificationStepPercent": 10,
            "diagnosticsJournal": False,
        }
    )


async def test_import_twice_imports_once(env: dict[str, str], service: subprocess.Popen[str], tmp_path: Path) -> None:
    bus = await connect(env)
    iface = await proxy(bus)
    signals = Signals(iface)
    values = legacy_json(tmp_path)
    first = json.loads(await iface.call_import_accounts(values))  # type: ignore[attr-defined]
    assert first == {"schema": 1, "imported": 1, "refused": False}
    assert len((await next_signal(signals.accounts))["accounts"]) == 1  # type: ignore[arg-type]
    await next_signal(signals.settings)
    again = json.loads(await iface.call_import_accounts(values))  # type: ignore[attr-defined]
    assert again == {"schema": 1, "imported": 0, "refused": False}
    other = json.loads(await iface.call_import_accounts(legacy_json(tmp_path / "other")))  # type: ignore[attr-defined]
    assert other == {"schema": 1, "imported": 0, "refused": True}
    state = json.loads(await iface.call_get_state())  # type: ignore[attr-defined]
    assert len(state["accounts"]) == 1
    assert state["settings"]["refreshIntervalSeconds"] == 120
    backup = Path(env["XDG_CONFIG_HOME"]) / "token-grill" / "imported-0.4.json"
    assert backup.exists()
    with pytest.raises(DBusError) as bad:
        await iface.call_import_accounts("[]")  # type: ignore[attr-defined]
    assert bad.value.type == f"{NAME}.Error.InvalidArgs"
    bus.disconnect()


async def test_send_test_alert_emits_the_alert_signal(
    env: dict[str, str], service: subprocess.Popen[str], tmp_path: Path
) -> None:
    bus = await connect(env)
    iface = await proxy(bus)
    alerts: asyncio.Queue[dict[str, object]] = asyncio.Queue()
    iface.on_alert(lambda text: alerts.put_nowait(json.loads(text)))  # type: ignore[attr-defined]
    account = await add_codex(iface, tmp_path / "one")
    await iface.call_send_test_alert(account)  # type: ignore[attr-defined]
    alert = await next_signal(alerts)
    assert alert["kind"] == "test"
    assert alert["accountId"] == account
    assert alert["window"] is None
    with pytest.raises(DBusError) as unknown:
        await iface.call_send_test_alert("nope")  # type: ignore[attr-defined]
    assert unknown.value.type == f"{NAME}.Error.InvalidArgs"
    bus.disconnect()


async def test_discover_and_credential_state_over_the_bus(
    env: dict[str, str], service: subprocess.Popen[str], tmp_path: Path
) -> None:
    home = Path(env["HOME"])
    (home / ".codex-work").mkdir(parents=True)
    (home / ".codex-work" / "auth.json").write_text(
        json.dumps({"tokens": {"access_token": "tok-secret-1", "account_id": "acct-9"}}), encoding="utf-8"
    )
    bus = await connect(env)
    iface = await proxy(bus)
    found = json.loads(await iface.call_discover("codex-cli"))  # type: ignore[attr-defined]
    assert found["schema"] == 1
    assert [(item["app"], item["accountHome"], item["status"]) for item in found["candidates"]] == [
        ("codex-cli", "~/.codex-work", "ready")
    ]
    assert "tok-secret-1" not in json.dumps(found) and "acct-9" not in json.dumps(found)
    everything = json.loads(await iface.call_discover(""))  # type: ignore[attr-defined]
    assert any(item["app"] == "codex-cli" for item in everything["candidates"])
    with pytest.raises(DBusError) as unknown_app:
        await iface.call_discover("nonsense")  # type: ignore[attr-defined]
    assert unknown_app.value.type == f"{NAME}.Error.InvalidArgs"
    account_id = await add_codex(iface, home / ".codex-work")
    state = json.loads(await iface.call_credential_state(account_id))  # type: ignore[attr-defined]
    assert state == {"schema": 1, "state": "authenticated"}
    with pytest.raises(DBusError) as unknown_account:
        await iface.call_credential_state("missing")  # type: ignore[attr-defined]
    assert unknown_account.value.type == f"{NAME}.Error.InvalidArgs"
    with pytest.raises(DBusError) as wrong_account:
        await iface.call_save_api_key(account_id, "sk-secret")  # type: ignore[attr-defined]
    assert wrong_account.value.type == f"{NAME}.Error.InvalidArgs"
    assert "sk-secret" not in wrong_account.value.text
    bus.disconnect()
