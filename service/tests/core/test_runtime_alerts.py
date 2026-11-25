import asyncio
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from tokengrill.core.config import Config, ConfigStore, default_settings, new_provider
from tokengrill.core.errors import InvalidRequest
from tokengrill.core.runtime import Runtime
from tokengrill.core.types import (
    Alert,
    Balance,
    ProviderInstance,
    ProviderKind,
    ProviderRuntimeState,
    ProviderSnapshot,
    Settings,
    UsageWindow,
    empty_snapshot,
)
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import Collector, CollectorContext

START = 1_800_000_000_000
RESET = START + 3 * 3600 * 1000
ACCOUNT_ID = "a"


class Events:
    def __init__(self) -> None:
        self.alerts: list[Alert] = []

    def account_changed(self, account_id: str, snapshot: ProviderSnapshot, runtime: ProviderRuntimeState) -> None:
        return None

    def accounts_changed(self, accounts: list[ProviderInstance]) -> None:
        return None

    def settings_changed(self, settings: Settings) -> None:
        return None

    def alert(self, alert: Alert) -> None:
        self.alerts.append(alert)


def limit(window_id: str, canonical: str, percent: float) -> UsageWindow:
    return {
        "id": window_id,
        "canonicalWindow": canonical,  # type: ignore[typeddict-item]
        "label": window_id,
        "used": None,
        "limit": None,
        "percent": percent,
        "resetAt": RESET,
        "durationSeconds": None,
        "unit": None,
        "pace": None,
    }


class Scripted:
    """Returns whatever the test last set, as a ready reading."""

    def __init__(self) -> None:
        self.windows: list[UsageWindow] = []
        self.balance: Balance | None = None

    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        return {
            **empty_snapshot(instance["id"]),
            "state": "ready",
            "lastUpdated": START,
            "windows": self.windows,
            "balance": self.balance,
        }


class Rig:
    def __init__(self, runtime: Runtime, events: Events, script: Scripted, clock: list[int]) -> None:
        self.runtime = runtime
        self.events = events
        self.script = script
        self.clock = clock

    async def read(self, *windows: UsageWindow, balance: Balance | None = None) -> None:
        self.script.windows = list(windows)
        self.script.balance = balance
        self.clock[0] += 120_000
        instance = next(item for item in self.runtime.state()["accounts"] if item["id"] == ACCOUNT_ID)
        await asyncio.wait_for(self.runtime._collect([{"provider": instance, "manual": True}]), 5)

    def checkpoint(self, key: str) -> object:
        return self.runtime._alerts.window(f"{ACCOUNT_ID}:{key}")


def account(**changes: object) -> ProviderInstance:
    return {**new_provider("codex", "codex-cli", "~/.codex"), "id": ACCOUNT_ID, **changes}  # type: ignore[typeddict-item]


async def build(tmp_path: Path, accounts: list[ProviderInstance], **settings: object) -> Rig:
    store = ConfigStore(tmp_path / "config" / "token-grill" / "config.json")
    config: Config = {"schema": 1, "accounts": accounts, **default_settings(), **settings}  # type: ignore[typeddict-item]
    await store.save(config)
    events = Events()
    script = Scripted()
    collectors: dict[ProviderKind, Collector] = {"codex": script}
    clock = [START]
    runtime = Runtime(store, events, HttpClient(), collectors, lambda: clock[0])
    await runtime.start()
    return Rig(runtime, events, script, clock)


@pytest.fixture(autouse=True)
def xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))


@pytest.fixture
async def rig(tmp_path: Path) -> AsyncIterator[Rig]:
    made = await build(tmp_path, [account()])
    yield made
    await made.runtime.stop()


async def test_alert_needs_shell_client(rig: Rig) -> None:
    await rig.read(limit("five", "five-hour", 0.4))
    await rig.read(limit("five", "five-hour", 0.8))
    assert rig.events.alerts == []
    assert rig.checkpoint("five-hour") is None, "no checkpoint advances while nobody can show an alert"
    rig.runtime._shell_connected = True
    await rig.read(limit("five", "five-hour", 0.4))
    await rig.read(limit("five", "five-hour", 0.8))
    assert [alert["kind"] for alert in rig.events.alerts] == ["milestone"]


async def test_alerts_off_decides_nothing(tmp_path: Path) -> None:
    made = await build(tmp_path, [account()], alertsEnabled=False)
    made.runtime._shell_connected = True
    await made.read(limit("five", "five-hour", 0.4))
    await made.read(limit("five", "five-hour", 0.8))
    assert made.events.alerts == []
    assert made.checkpoint("five-hour") is None
    await made.runtime.stop()


async def test_a_milestone_alert_carries_the_window_and_the_fraction(rig: Rig) -> None:
    rig.runtime._shell_connected = True
    await rig.read(limit("five", "five-hour", 0.42))
    await rig.read(limit("five", "five-hour", 0.55))
    [alert] = rig.events.alerts
    assert alert["schema"] == 1
    assert alert["kind"] == "milestone"
    assert alert["accountId"] == ACCOUNT_ID
    assert alert["window"] is not None and alert["window"]["id"] == "five"
    assert alert["fraction"] == 0.55
    assert alert["at"] == rig.clock[0]
    await rig.read(limit("five", "five-hour", 0.57))
    assert len(rig.events.alerts) == 1, "the same bucket does not alert twice"


async def test_only_shown_limits_alert(tmp_path: Path) -> None:
    made = await build(tmp_path, [account(topBar={"automatic": False, "limits": ["weekly"]})])
    made.runtime._shell_connected = True
    await made.read(limit("five", "five-hour", 0.4), limit("week", "weekly", 0.4))
    await made.read(limit("five", "five-hour", 0.8), limit("week", "weekly", 0.8))
    assert [alert["window"]["id"] for alert in made.events.alerts if alert["window"]] == ["week"]
    assert made.checkpoint("five-hour") is None
    await made.runtime.stop()


async def test_an_account_outside_the_top_bar_does_not_alert(tmp_path: Path) -> None:
    made = await build(tmp_path, [account(topBar={"automatic": False, "limits": []})])
    made.runtime._shell_connected = True
    await made.read(limit("five", "five-hour", 0.4))
    await made.read(limit("five", "five-hour", 0.8))
    assert made.events.alerts == []
    await made.runtime.stop()


async def test_low_balance_alerts_once(tmp_path: Path) -> None:
    made = await build(tmp_path, [account(topBar={"automatic": False, "limits": ["balance"]}, lowBalance=10.0)])
    made.runtime._shell_connected = True
    await made.read(limit("balance", "other", 0.1), balance={"amount": 20.0, "currency": "USD"})
    await made.read(limit("balance", "other", 0.1), balance={"amount": 8.4, "currency": "USD"})
    [alert] = made.events.alerts
    assert alert["kind"] == "low-balance"
    assert alert["balance"] == {"amount": 8.4, "currency": "USD"}
    assert alert["lowBalance"] == 10.0
    await made.read(limit("balance", "other", 0.1), balance={"amount": 4.0, "currency": "USD"})
    assert len(made.events.alerts) == 1
    await made.runtime.stop()


async def test_removing_an_account_drops_its_alert_state(rig: Rig) -> None:
    rig.runtime._shell_connected = True
    await rig.read(limit("five", "five-hour", 0.4))
    assert rig.checkpoint("five-hour") is not None
    await rig.runtime.remove_account(ACCOUNT_ID, False)
    assert rig.checkpoint("five-hour") is None


async def test_send_test_alert_uses_the_first_shown_limit(tmp_path: Path) -> None:
    made = await build(tmp_path, [account(topBar={"automatic": False, "limits": ["weekly"]})])
    await made.read(limit("five", "five-hour", 0.4), limit("week", "weekly", 0.7))
    made.runtime.send_test_alert(ACCOUNT_ID)
    [alert] = made.events.alerts
    assert alert["kind"] == "test"
    assert alert["window"] is not None and alert["window"]["id"] == "week"
    assert alert["fraction"] == 0.7
    await made.runtime.stop()


async def test_send_test_alert_without_readings_has_no_window(rig: Rig) -> None:
    rig.runtime.send_test_alert(ACCOUNT_ID)
    [alert] = rig.events.alerts
    assert alert["window"] is None
    assert alert["fraction"] is None


async def test_send_test_alert_for_an_unknown_account_is_refused(rig: Rig) -> None:
    with pytest.raises(InvalidRequest):
        rig.runtime.send_test_alert("nope")
