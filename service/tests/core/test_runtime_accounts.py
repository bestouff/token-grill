import asyncio
import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from tokengrill.core.config import Config, ConfigStore, LegacySettings, default_settings, new_provider
from tokengrill.core.errors import InvalidRequest, ServiceError
from tokengrill.core.runtime import Runtime
from tokengrill.core.types import (
    Alert,
    ProviderInstance,
    ProviderKind,
    ProviderRuntimeState,
    ProviderSnapshot,
    Settings,
    TokenTotals,
)
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import Collector, CollectorContext

WAIT = 5.0


class Events:
    def __init__(self) -> None:
        self.account_lists: list[list[ProviderInstance]] = []
        self.settings: list[Settings] = []

    def account_changed(self, account_id: str, snapshot: ProviderSnapshot, runtime: ProviderRuntimeState) -> None:
        return None

    def accounts_changed(self, accounts: list[ProviderInstance]) -> None:
        self.account_lists.append(accounts)

    def settings_changed(self, settings: Settings) -> None:
        self.settings.append(settings)

    def alert(self, alert: Alert) -> None:
        return None


class CountingCollector:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        self.calls.append(instance["id"])
        return snapshot


class Rig:
    def __init__(self, runtime: Runtime, events: Events, collector: CountingCollector, store: ConfigStore) -> None:
        self.runtime = runtime
        self.events = events
        self.collector = collector
        self.store = store


def account(account_id: str, home: str, **changes: object) -> ProviderInstance:
    return {**new_provider("codex", "codex-cli", home), "id": account_id, **changes}  # type: ignore[typeddict-item]


async def build(tmp_path: Path, accounts: list[ProviderInstance]) -> Rig:
    store = ConfigStore(tmp_path / "config" / "token-grill" / "config.json")
    await store.save({"schema": 1, "accounts": accounts, **default_settings()})
    events = Events()
    collector = CountingCollector()
    collectors: dict[ProviderKind, Collector] = {"codex": collector}
    runtime = Runtime(store, events, HttpClient(), collectors)
    await runtime.start()
    return Rig(runtime, events, collector, store)


async def settle(rig: Rig) -> None:
    """Waits for the readings an edit started in the background."""
    pending = list(rig.runtime._tasks)
    if pending:
        await asyncio.wait_for(asyncio.gather(*pending), WAIT)


@pytest.fixture(autouse=True)
def xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))


@pytest.fixture
async def rig(tmp_path: Path) -> AsyncIterator[Rig]:
    made = await build(tmp_path, [account("a", "~/.codex-a"), account("b", "~/.codex-b", sortOrder=1)])
    yield made
    await made.runtime.stop()


async def test_add_saves_orders_signals_and_refreshes(rig: Rig) -> None:
    ids, errors = await rig.runtime.add_accounts([{"kind": "codex", "accountHome": "~/.codex-c"}])
    assert errors == {} and len(ids) == 1
    saved = rig.store.load()["accounts"]
    assert [item["id"] for item in saved] == ["a", "b", ids[0]]
    assert [item["sortOrder"] for item in saved] == [0, 1, 2]
    assert rig.events.account_lists[-1] == saved
    await settle(rig)
    assert rig.collector.calls == [ids[0]]


async def test_add_invalid_account_returns_field_errors_and_saves_nothing(rig: Rig) -> None:
    ids, errors = await rig.runtime.add_accounts(
        [{"kind": "codex", "accountHome": "~/.codex-c"}, {"kind": "codex", "accountHome": "~/.codex-a"}]
    )
    assert ids == []
    assert errors == {"1": {"accountHome": "duplicate-home"}}
    assert len(rig.store.load()["accounts"]) == 2
    assert rig.events.account_lists == []
    _ids, relative = await rig.runtime.add_accounts([{"kind": "codex", "accountHome": "relative"}])
    assert relative == {"0": {"accountHome": "not-absolute"}}
    with pytest.raises(InvalidRequest):
        await rig.runtime.add_accounts([{"kind": "nope", "accountHome": "~/x"}])


async def test_update_replaces_and_refreshes_only_when_reading_changes(rig: Rig) -> None:
    assert await rig.runtime.update_account({"id": "a", "displayName": "Work", "accent": "blue"}) == {}
    await settle(rig)
    assert rig.collector.calls == []
    assert rig.store.load()["accounts"][0]["displayName"] == "Work"
    assert await rig.runtime.update_account({"id": "a", "accountHome": "~/.codex-new"}) == {}
    await settle(rig)
    assert rig.collector.calls == ["a"]
    assert rig.events.account_lists[-1][0]["accountHome"] == "~/.codex-new"


async def test_update_reports_field_errors_and_unknown_accounts(rig: Rig) -> None:
    assert await rig.runtime.update_account({"id": "a", "displayName": "  "}) == {"displayName": "required"}
    assert await rig.runtime.update_account({"id": "a", "accountHome": "~/.codex-b"}) == {
        "accountHome": "duplicate-home"
    }
    with pytest.raises(InvalidRequest):
        await rig.runtime.update_account({"id": "zzz"})
    assert rig.events.account_lists == []


async def test_remove_drops_stored_data_and_signals(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    cleared: list[str] = []

    async def fake_clear(account_id: str) -> None:
        cleared.append(account_id)

    monkeypatch.setattr("tokengrill.core.runtime.clear_api_key", fake_clear)
    runtime = rig.runtime
    runtime._snapshots["a"] = {}  # type: ignore[typeddict-item]
    await runtime.remove_account("a", False)
    assert cleared == []
    assert [item["id"] for item in rig.store.load()["accounts"]] == ["b"]
    assert rig.store.load()["accounts"][0]["sortOrder"] == 0
    assert "a" not in runtime.state()["snapshots"]
    assert [item["id"] for item in rig.events.account_lists[-1]] == ["b"]
    await runtime.remove_account("missing", True)
    assert cleared == []


async def test_remove_with_key_clears_keyring_item(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    cleared: list[str] = []

    async def fake_clear(account_id: str) -> None:
        cleared.append(account_id)

    monkeypatch.setattr("tokengrill.core.runtime.clear_api_key", fake_clear)
    await rig.runtime.remove_account("b", True)
    assert cleared == ["b"]


async def test_remove_survives_an_unavailable_keyring(rig: Rig, monkeypatch: pytest.MonkeyPatch) -> None:
    async def failing(account_id: str) -> None:
        raise ServiceError("dependency", "deepseek.keyring-unavailable")

    monkeypatch.setattr("tokengrill.core.runtime.clear_api_key", failing)
    await rig.runtime.remove_account("b", True)
    assert [item["id"] for item in rig.store.load()["accounts"]] == ["a"]


async def test_remove_forgets_stored_readings_totals_and_balances(tmp_path: Path) -> None:
    rig = await build(tmp_path, [account("a", "~/.codex-a")])
    forgotten: list[str] = []
    for name in ("_aggregates", "_checkpoints", "_balances", "_readings"):
        store = getattr(rig.runtime, name)

        async def remember(account_id: str, label: str = name) -> None:
            forgotten.append(f"{label}:{account_id}")

        store.remove_provider = remember
    await rig.runtime.remove_account("a", False)
    await rig.runtime.stop()
    assert forgotten == ["_aggregates:a", "_checkpoints:a", "_balances:a", "_readings:a"]


async def test_reorder_saves_and_signals(rig: Rig) -> None:
    await rig.runtime.reorder_accounts(["b", "a"])
    assert [item["id"] for item in rig.store.load()["accounts"]] == ["b", "a"]
    assert [item["id"] for item in rig.events.account_lists[-1]] == ["b", "a"]


async def test_validate_account_uses_the_codes(rig: Rig) -> None:
    assert rig.runtime.validate_account(
        {"kind": "codex", "app": "codex-cli", "displayName": "x", "accountHome": ""}
    ) == {"accountHome": "required"}
    assert (
        rig.runtime.validate_account(
            {"kind": "codex", "app": "codex-cli", "displayName": "x", "accountHome": "/tmp/../tmp/q"}
        )
        == {}
    )
    assert rig.runtime.validate_account(
        {"kind": "codex", "app": "codex-cli", "displayName": "x", "accountHome": "~/.codex-a"}
    ) == {"accountHome": "duplicate-home"}
    assert rig.runtime.validate_account({"id": "a", "displayName": "x", "accountHome": "~/.codex-a"}) == {}
    assert rig.runtime.validate_account({"kind": "codex", "displayName": "", "accountHome": "~/x"}) == {
        "displayName": "required"
    }


async def test_toggle_limit_and_automatic_save_and_signal(rig: Rig) -> None:
    await rig.runtime.toggle_limit("a", "weekly")
    assert rig.store.load()["accounts"][0]["topBar"] == {"automatic": False, "limits": ["weekly"]}
    assert rig.events.account_lists[-1][0]["topBar"]["limits"] == ["weekly"]
    await rig.runtime.set_automatic("a", True)
    assert rig.store.load()["accounts"][0]["topBar"] == {"automatic": True, "limits": []}
    with pytest.raises(InvalidRequest):
        await rig.runtime.toggle_limit("zzz", "weekly")
    with pytest.raises(InvalidRequest):
        await rig.runtime.set_automatic("zzz", True)
    await settle(rig)
    assert rig.collector.calls == []


async def test_set_settings_saves_reschedules_and_signals(rig: Rig) -> None:
    await rig.runtime.set_settings({"refreshIntervalSeconds": 600, "alertStepPercent": 20, "alertsEnabled": False})
    loaded = rig.store.load()
    assert (loaded["refreshIntervalSeconds"], loaded["alertStepPercent"], loaded["alertsEnabled"]) == (600, 20, False)
    assert rig.events.settings[-1] == rig.runtime.state()["settings"]
    assert rig.runtime._scheduler._interval == 600


@pytest.mark.parametrize(
    "patch",
    [
        {"refreshIntervalSeconds": 59},
        {"refreshIntervalSeconds": 3601},
        {"refreshIntervalSeconds": "60"},
        {"refreshIntervalSeconds": True},
        {"alertStepPercent": 4},
        {"alertStepPercent": 51},
        {"alertsEnabled": 1},
        {"unknown": 1},
        [],
    ],
)
async def test_settings_out_of_range_are_rejected(rig: Rig, patch: object) -> None:
    with pytest.raises(InvalidRequest):
        await rig.runtime.set_settings(patch)
    assert rig.store.load()["refreshIntervalSeconds"] == 300
    assert rig.events.settings == []


def legacy(home: str = "~/.codex-legacy") -> LegacySettings:
    entry = new_provider("codex", "codex-cli", home)
    return {
        "providerInstancesJson": json.dumps([entry]),
        "configurationVersion": 3,
        "activeProviderId": "",
        "refreshIntervalSeconds": 120,
        "notificationsEnabled": False,
        "notificationStepPercent": 25,
        "diagnosticsJournal": True,
    }


async def test_import_twice_imports_once(tmp_path: Path) -> None:
    rig = await build(tmp_path, [])
    assert await rig.runtime.import_accounts(legacy()) == 1
    state = rig.runtime.state()
    assert len(state["accounts"]) == 1 and state["settings"]["refreshIntervalSeconds"] == 120
    assert len(rig.events.account_lists) == 1 and len(rig.events.settings) == 1
    backup = tmp_path / "config" / "token-grill" / "imported-0.4.json"
    kept = backup.read_text(encoding="ascii")
    # Removing every account must not reopen the import and replace the backup.
    await rig.runtime.remove_account(state["accounts"][0]["id"], False)
    assert await rig.runtime.import_accounts(legacy("~/.other")) == 0
    assert backup.read_text(encoding="ascii") == kept
    assert rig.runtime.state()["accounts"] == []
    await rig.runtime.stop()


async def test_import_is_refused_when_accounts_exist(rig: Rig) -> None:
    assert await rig.runtime.import_accounts(legacy()) == 0
    assert not (rig.store.path.parent / "imported-0.4.json").exists()


async def test_import_rejects_a_malformed_value(rig: Rig) -> None:
    with pytest.raises(InvalidRequest):
        await rig.runtime.import_accounts({"providerInstancesJson": 3})


async def test_failed_config_save_leaves_no_backup_and_a_retry_imports(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rig = await build(tmp_path, [])
    real_save = rig.store.save

    async def failing(config: Config) -> None:
        raise OSError("disk full")

    monkeypatch.setattr(rig.store, "save", failing)
    with pytest.raises(OSError):
        await rig.runtime.import_accounts(legacy())
    assert not (rig.store.path.parent / "imported-0.4.json").exists()
    monkeypatch.setattr(rig.store, "save", real_save)
    assert await rig.runtime.import_accounts(legacy()) == 1
    assert (rig.store.path.parent / "imported-0.4.json").exists()
    await rig.runtime.stop()


def _totals(tokens: int) -> TokenTotals:
    return {"input": tokens, "cachedInput": 0, "cacheWrite": 0, "output": 0, "reasoning": 0, "total": tokens}


class BlockingCollector:
    def __init__(self, ctx_target: "Runtime | None" = None) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        self.started.set()
        await self.release.wait()
        # What a real collector records while it reads: totals, read offsets and the prepaid balance.
        ctx.aggregates.add(instance["id"], {"capturedAt": 1_800_000_000_000, "model": None, "totals": _totals(5)})
        ctx.checkpoints.set(
            {"providerId": instance["id"], "path": "/x.jsonl", "size": 1, "mtime": 1, "offset": 1, "parserVersion": 1}
        )
        ctx.balances.set(instance["id"], {"currency": "USD", "full": 10.0, "last": 5.0})
        return {**snapshot, "plan": "Pro", "lastUpdated": 1_800_000_000_000}


async def test_account_removed_during_collection_leaves_nothing_behind(tmp_path: Path) -> None:
    store = ConfigStore(tmp_path / "config" / "token-grill" / "config.json")
    await store.save({"schema": 1, "accounts": [account("a", "~/.codex-a")], **default_settings()})
    blocker = BlockingCollector()
    collectors: dict[ProviderKind, Collector] = {"codex": blocker}
    runtime = Runtime(store, Events(), HttpClient(), collectors)
    await runtime.start()
    refreshing = asyncio.create_task(runtime.refresh("a"))
    await asyncio.wait_for(blocker.started.wait(), WAIT)
    await runtime.remove_account("a", False)
    blocker.release.set()
    await asyncio.wait_for(refreshing, WAIT)
    state = runtime.state()
    assert "a" not in state["runtime"] and "a" not in state["snapshots"]
    assert runtime._readings.get("a") is None
    assert runtime._aggregates.buckets_since("a", 0) == []
    assert runtime._checkpoints.get("a", "/x.jsonl") is None
    assert runtime._balances.get("a") is None
    await runtime.stop()


class FailingBackup:
    def __init__(self, path: Path) -> None:
        self.path = path

    async def write(self, payload: object) -> None:
        raise OSError("read-only")


async def test_failed_backup_write_still_adopts_the_saved_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    rig = await build(tmp_path, [])
    # Only the backup writer is made after the store; the store keeps its own.
    monkeypatch.setattr("tokengrill.core.config.SerialWriter", FailingBackup)
    with pytest.raises(OSError):
        await rig.runtime.import_accounts(legacy())
    monkeypatch.undo()
    assert len(rig.runtime.state()["accounts"]) == 1
    assert len(rig.store.load()["accounts"]) == 1
    await rig.runtime.stop()
