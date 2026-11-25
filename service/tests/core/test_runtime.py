import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from pathlib import Path

import pytest

import tokengrill
from tokengrill.core.config import Config, ConfigStore, default_settings, new_provider
from tokengrill.core.errors import InvalidRequest, ServiceError
from tokengrill.core.runtime import Emitter, Runtime
from tokengrill.core.types import (
    Alert,
    ProviderInstance,
    ProviderKind,
    ProviderRuntimeState,
    ProviderSnapshot,
    RefreshPhase,
    Settings,
    UsageWindow,
    empty_snapshot,
)
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import Collector, CollectorContext, LimitsUpdate, collect_limits
from tokengrill.storage.readings import ReadingStore

START = 1_800_000_000_000
HOUR = 3600 * 1000
WAIT = 5.0


class Clock:
    def __init__(self) -> None:
        self.now = START

    def __call__(self) -> int:
        return self.now


class Events:
    """The recording fake of the Emitter protocol."""

    def __init__(self) -> None:
        self.accounts: list[tuple[str, ProviderSnapshot, ProviderRuntimeState]] = []
        self.account_lists: list[list[ProviderInstance]] = []
        self.settings: list[Settings] = []
        self.alerts: list[Alert] = []

    def account_changed(self, account_id: str, snapshot: ProviderSnapshot, runtime: ProviderRuntimeState) -> None:
        self.accounts.append((account_id, snapshot, runtime))

    def accounts_changed(self, accounts: list[ProviderInstance]) -> None:
        self.account_lists.append(accounts)

    def settings_changed(self, settings: Settings) -> None:
        self.settings.append(settings)

    def alert(self, alert: Alert) -> None:
        self.alerts.append(alert)

    def phases(self, account_id: str) -> list[RefreshPhase]:
        return [runtime["phase"] for id_, _, runtime in self.accounts if id_ == account_id]

    def last(self, account_id: str) -> tuple[ProviderSnapshot, ProviderRuntimeState]:
        found = [(snapshot, runtime) for id_, snapshot, runtime in self.accounts if id_ == account_id]
        return found[-1]


def window(percent: float, clock: Clock) -> UsageWindow:
    """A five-hour window that is halfway through."""
    return {
        "id": "five-hour",
        "canonicalWindow": "five-hour",
        "label": "5h",
        "used": None,
        "limit": None,
        "percent": percent,
        "resetAt": START + int(2.5 * HOUR),
        "durationSeconds": 5 * 3600,
        "unit": None,
        "pace": None,
    }


class FakeCollector:
    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self.calls = 0
        self.manual: list[bool] = []
        self.history: list[bool] = []
        self.percent = 0.8
        self.fail_with: ServiceError | None = None
        self.crash = False
        self.partial = False
        self.block: asyncio.Event | None = None
        self.cancelled = False
        self.started = asyncio.Event()
        self._called = asyncio.Condition()

    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        self.calls += 1
        self.manual.append(ctx.manual)
        self.history.append(ctx.history_enabled)
        self.started.set()
        async with self._called:
            self._called.notify_all()
        if self.block is not None:
            try:
                await self.block.wait()
            except asyncio.CancelledError:
                self.cancelled = True
                raise
        if self.crash:
            raise RuntimeError("bug")
        error = self.fail_with

        async def fetch() -> LimitsUpdate:
            if error is not None:
                raise error
            return {"plan": "Pro", "windows": [window(self.percent, self.clock)]}

        result = await collect_limits(ctx, snapshot, fetch)
        if self.partial:
            ctx.report_phase("fetching-reset-credits")
            ctx.report_source("reset-credits", "failed")
        stamp = self.clock()
        return {**result, "lastUpdated": stamp if result["state"] == "ready" else result["lastUpdated"]}

    async def wait_calls(self, count: int) -> None:
        async with self._called:
            await asyncio.wait_for(self._called.wait_for(lambda: self.calls >= count), WAIT)


class Rig:
    def __init__(self, runtime: Runtime, events: Events, clock: Clock, fake: FakeCollector, tmp_path: Path) -> None:
        self.runtime = runtime
        self.events = events
        self.clock = clock
        self.fake = fake
        self.tmp_path = tmp_path

    async def advance(self, seconds: int) -> None:
        """Moves the injected clock and wakes the scheduler, which would otherwise sleep for real."""
        self.clock.now += seconds * 1000
        wake = self.runtime._scheduler._wake
        if wake is not None:
            wake.set()
        await asyncio.sleep(0)


ACCOUNT_ID = "a"


def codex_account(**changes: object) -> ProviderInstance:
    return {**new_provider("codex", "codex-cli", "~/.codex"), "id": ACCOUNT_ID, "showPace": True, **changes}  # type: ignore[typeddict-item]


@pytest.fixture
def xdg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    return tmp_path


async def build(
    tmp_path: Path, accounts: list[ProviderInstance] | None = None, settings: Settings | None = None
) -> Rig:
    store = ConfigStore(tmp_path / "config" / "token-grill" / "config.json")
    config: Config = {"schema": 1, "accounts": accounts or [codex_account()], **(settings or default_settings())}
    await store.save(config)
    clock = Clock()
    events = Events()
    fake = FakeCollector(clock)
    collectors: dict[ProviderKind, Collector] = {"codex": fake}
    runtime = Runtime(store, events, HttpClient(), collectors, clock)
    return Rig(runtime, events, clock, fake, tmp_path)


@pytest.fixture
async def rig(xdg: Path) -> AsyncIterator[Rig]:
    made = await build(xdg)
    yield made
    await made.runtime.stop()


def test_events_fake_satisfies_the_emitter_protocol() -> None:
    emitter: Emitter = Events()
    assert emitter is not None


async def test_collect_emits_snapshot_with_pace(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh(ACCOUNT_ID)
    snapshot, runtime = rig.events.last(ACCOUNT_ID)
    assert snapshot["state"] == "ready"
    assert snapshot["windows"][0]["pace"] == {"state": "high", "runsOutAt": START + int(0.625 * HOUR)}
    assert snapshot["pace"] == {"state": "high", "runsOutAt": START + int(0.625 * HOUR)}
    assert runtime == {
        "phase": "idle",
        "outcome": "changed",
        "completedAt": START,
        "sources": {"limits": "success", "reset-credits": None, "history": None},
    }
    assert "queued" in rig.events.phases(ACCOUNT_ID)
    assert "fetching-limits" in rig.events.phases(ACCOUNT_ID)
    state = rig.runtime.state()
    assert state["snapshots"][ACCOUNT_ID]["windows"][0]["pace"] == snapshot["windows"][0]["pace"]
    assert state["runtime"][ACCOUNT_ID] == runtime


async def test_manual_flag_reaches_the_collector(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.fake.manual == [True]


async def test_outcomes_follow_the_refresh(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh(ACCOUNT_ID)
    rig.clock.now += 100_000
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.events.last(ACCOUNT_ID)[1]["outcome"] == "unchanged"
    rig.clock.now += 100_000
    rig.fake.percent = 0.9
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.events.last(ACCOUNT_ID)[1]["outcome"] == "changed"
    rig.clock.now += 100_000
    rig.fake.partial = True
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.events.last(ACCOUNT_ID)[1]["outcome"] == "partial"
    assert "fetching-reset-credits" in rig.events.phases(ACCOUNT_ID)
    rig.clock.now += 100_000
    rig.fake.partial = False
    rig.fake.fail_with = ServiceError("offline", "net.offline")
    await rig.runtime.refresh(ACCOUNT_ID)
    snapshot, runtime = rig.events.last(ACCOUNT_ID)
    assert runtime["outcome"] == "failed"
    assert snapshot["state"] == "stale"
    assert snapshot["errorInfo"] is not None


async def test_a_bug_in_a_collector_fails_the_account_and_is_logged(rig: Rig, caplog: pytest.LogCaptureFixture) -> None:
    await rig.runtime.start()
    rig.fake.crash = True
    with caplog.at_level(logging.ERROR):
        await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.events.last(ACCOUNT_ID)[1]["outcome"] == "failed"
    errors = [record for record in caplog.records if record.levelno == logging.ERROR]
    assert len(errors) == 1
    assert errors[0].exc_info is not None
    snapshot = rig.events.last(ACCOUNT_ID)[0]
    assert snapshot["state"] == "error"
    assert snapshot["errorInfo"] == {
        "code": "internal",
        "messageId": "service.internal",
        "params": {},
        "recovery": "retry",
    }
    rig.clock.now += 100_000
    rig.fake.crash = False
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.events.last(ACCOUNT_ID)[1]["outcome"] == "changed"
    assert rig.events.last(ACCOUNT_ID)[0]["errorInfo"] is None


async def test_a_bug_after_a_good_reading_keeps_the_values_as_stale(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh(ACCOUNT_ID)
    rig.clock.now += 100_000
    rig.fake.crash = True
    await rig.runtime.refresh(ACCOUNT_ID)
    snapshot, runtime = rig.events.last(ACCOUNT_ID)
    assert snapshot["state"] == "stale"
    assert snapshot["plan"] == "Pro"
    assert snapshot["errorInfo"] is not None and snapshot["errorInfo"]["messageId"] == "service.internal"
    assert runtime["outcome"] == "failed"


async def test_saved_readings_restore_on_start(xdg: Path) -> None:
    rig = await build(xdg, [codex_account(), codex_account(id="off", liveUsageEnabled=False)])
    clock = rig.clock
    saved: ProviderSnapshot = {
        **empty_snapshot(ACCOUNT_ID),
        "state": "ready",
        "lastUpdated": 5,
        "quotaFetchedAt": 5,
        "plan": "Pro",
        "account": "person@example.com",
        "windows": [window(0.8, clock)],
    }
    store = ReadingStore()
    store.set(saved)
    store.set({**saved, "providerId": "off"})
    await store.flush()
    await rig.runtime.start()
    state = rig.runtime.state()
    restored = state["snapshots"][ACCOUNT_ID]
    assert restored["state"] == "stale"
    assert restored["plan"] == "Pro"
    assert restored["account"] is None
    assert restored["quotaFetchedAt"] == 5
    assert restored["windows"][0]["pace"] is not None
    assert "off" not in state["snapshots"]
    await rig.runtime.stop()


async def test_stop_flushes_stores(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh(ACCOUNT_ID)
    (rig.tmp_path / "state" / "token-grill" / "readings-v1.json").unlink(missing_ok=True)
    rig.clock.now += 100_000
    rig.fake.percent = 0.9
    await rig.runtime.refresh(ACCOUNT_ID)
    await rig.runtime.stop()
    folder = rig.tmp_path / "state" / "token-grill"
    assert "0.9" in (folder / "readings-v1.json").read_text()
    assert (folder / "diagnostics-v1.json").exists()


async def test_stop_writes_the_other_stores_when_one_cannot_be_written(
    rig: Rig, monkeypatch: pytest.MonkeyPatch
) -> None:
    await rig.runtime.start()
    flushed: list[str] = []

    def spy(name: str, fail: bool = False) -> Callable[[], Awaitable[None]]:
        async def flush() -> None:
            flushed.append(name)
            if fail:
                raise OSError(28, "No space left on device")

        return flush

    runtime = rig.runtime
    monkeypatch.setattr(runtime._aggregates, "flush", spy("aggregates", fail=True))
    for name in ("checkpoints", "balances", "readings", "alerts", "diagnostics"):
        monkeypatch.setattr(getattr(runtime, f"_{name}"), "flush", spy(name))
    await runtime.stop()
    # The checkpoints never move past totals that were not written.
    assert flushed == ["aggregates", "balances", "readings", "alerts", "diagnostics"]


async def test_stop_cancels_a_running_collection(rig: Rig) -> None:
    await rig.runtime.start()
    rig.fake.block = asyncio.Event()
    refresh = asyncio.create_task(rig.runtime.refresh(ACCOUNT_ID))
    await asyncio.wait_for(rig.fake.started.wait(), WAIT)
    await asyncio.wait_for(rig.runtime.stop(), WAIT)
    assert rig.fake.cancelled
    await asyncio.wait_for(refresh, WAIT)


async def test_refresh_is_rate_limited(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.fake.calls == 1
    rig.clock.now += 29_000
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.fake.calls == 1
    rig.clock.now += 2_000
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.fake.calls == 2


async def test_refresh_all_is_rate_limited_and_counts_for_each_account(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh_all()
    assert rig.fake.calls == 1
    rig.clock.now += 20_000
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.fake.calls == 1
    rig.clock.now += 35_000
    await rig.runtime.refresh_all()
    assert rig.fake.calls == 1
    rig.clock.now += 6_000
    await rig.runtime.refresh_all()
    assert rig.fake.calls == 2


async def test_a_merged_refresh_leaves_the_state_alone(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh(ACCOUNT_ID)
    count = len(rig.events.accounts)
    await rig.runtime.refresh(ACCOUNT_ID)
    assert len(rig.events.accounts) == count


async def test_unknown_and_disabled_accounts_are_ignored(xdg: Path) -> None:
    rig = await build(xdg, [codex_account(enabled=False)])
    await rig.runtime.start()
    await rig.runtime.refresh("nobody")
    await rig.runtime.refresh(ACCOUNT_ID)
    await rig.runtime.refresh_all()
    assert rig.fake.calls == 0
    await rig.runtime.stop()


async def test_paused_refresh_fails_without_asking_the_service(rig: Rig) -> None:
    await rig.runtime.start()
    rig.runtime.set_paused(True)
    assert rig.runtime.state()["paused"] is True
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.fake.calls == 0
    assert rig.events.last(ACCOUNT_ID)[1]["outcome"] == "failed"
    rig.runtime.set_paused(False)
    rig.clock.now += 100_000
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.fake.calls == 1


async def test_no_refresh_without_shell_client(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh_all()
    await rig.advance(3600)
    assert rig.fake.calls == 1  # the explicit refresh only
    rig.runtime.set_shell_connected(True)
    await rig.advance(400)
    await rig.fake.wait_calls(2)  # the timer runs with a shell client
    assert rig.fake.calls >= 2


async def test_no_history_scan_without_shell_client(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.fake.history == [False]
    rig.runtime.set_shell_connected(True)
    await rig.advance(400)
    await rig.fake.wait_calls(2)
    assert rig.fake.history[-1] is True
    rig.runtime.set_shell_connected(False)
    rig.clock.now += 100_000
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.fake.history[-1] is False


async def test_losing_the_shell_client_stops_the_timer(rig: Rig) -> None:
    await rig.runtime.start()
    rig.runtime.set_shell_connected(True)
    await rig.advance(400)
    await rig.fake.wait_calls(1)
    calls = rig.fake.calls
    rig.runtime.set_shell_connected(False)
    await rig.advance(7200)
    await asyncio.sleep(0)
    assert rig.fake.calls == calls
    rig.runtime.set_shell_connected(False)


async def test_a_shell_client_refreshes_all_enabled_accounts_on_connect(xdg: Path) -> None:
    rig = await build(xdg, [codex_account(), codex_account(id="b"), codex_account(id="off", enabled=False)])
    await rig.runtime.start()
    await rig.runtime.refresh_all()
    assert rig.fake.calls == 2
    rig.runtime.set_shell_connected(True)
    await rig.fake.wait_calls(4)
    assert rig.fake.calls == 4
    await rig.runtime.stop()


async def test_losing_the_shell_client_mid_refresh_ends_the_run(rig: Rig) -> None:
    await rig.runtime.start()
    rig.runtime.set_shell_connected(True)
    rig.fake.block = asyncio.Event()
    await asyncio.wait_for(rig.fake.started.wait(), WAIT)
    assert rig.runtime.state()["runtime"][ACCOUNT_ID]["phase"] == "fetching-limits"
    rig.runtime.set_shell_connected(False)
    for _ in range(20):
        await asyncio.sleep(0)
    state = rig.runtime.state()["runtime"][ACCOUNT_ID]
    assert state["phase"] == "idle"
    assert state["outcome"] == "failed"
    assert rig.fake.cancelled


async def test_a_refresh_refused_while_paused_does_not_delay_the_next(rig: Rig) -> None:
    await rig.runtime.start()
    rig.runtime.set_paused(True)
    await rig.runtime.refresh(ACCOUNT_ID)
    rig.runtime.set_paused(False)
    rig.clock.now += 5_000
    await rig.runtime.refresh(ACCOUNT_ID)
    assert rig.fake.calls == 1
    rig.runtime.set_paused(True)
    rig.clock.now += 100_000
    await rig.runtime.refresh_all()
    rig.runtime.set_paused(False)
    rig.clock.now += 5_000
    await rig.runtime.refresh_all()
    assert rig.fake.calls == 2


async def test_state_describes_the_service(rig: Rig) -> None:
    await rig.runtime.start()
    state = rig.runtime.state()
    assert state["schema"] == 1
    assert state["apiVersion"] == tokengrill.API_VERSION
    assert state["serviceVersion"] == tokengrill.__version__
    assert state["paused"] is False
    assert state["settings"] == default_settings()
    assert [account["id"] for account in state["accounts"]] == [ACCOUNT_ID]
    assert state["snapshots"] == {}
    assert state["runtime"] == {}


async def test_the_journal_gets_each_recorded_step_only_when_journal_diagnostics_is_on(
    xdg: Path, caplog: pytest.LogCaptureFixture
) -> None:
    for on in (True, False):
        caplog.clear()
        made = await build(xdg, settings={**default_settings(), "journalDiagnostics": on})
        await made.runtime.start()
        with caplog.at_level(logging.INFO, logger="tokengrill.runtime"):
            await made.runtime.refresh(ACCOUNT_ID)
        await made.runtime.stop()
        assert any("codex-1 (codex-cli) sign-in:" in line for line in caplog.messages) is on


async def test_the_report_has_the_service_version_and_the_redacted_steps(rig: Rig) -> None:
    await rig.runtime.start()
    await rig.runtime.refresh(ACCOUNT_ID)
    report = rig.runtime.diagnostics_report()
    lines = report.splitlines()
    assert lines[0].startswith(f"Token Grill service {tokengrill.__version__} - ")
    assert any(" codex-1 (codex, codex-cli) sign-in: codex-cli ~/.codex/auth.json" in line for line in lines[1:])
    assert str(Path.home()) not in report


async def test_a_request_for_an_unknown_account_is_refused(rig: Rig) -> None:
    await rig.runtime.start()
    with pytest.raises(InvalidRequest):
        rig.runtime.send_test_alert("nope")


async def test_start_sweeps_stale_private_database_copies(
    xdg: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path / "run"))
    folder = tmp_path / "run" / "token-grill"
    folder.mkdir(mode=0o700, parents=True)
    stale = folder / f"{'d' * 32}.sqlite"
    stale.write_bytes(b"left by a crash")
    made = await build(xdg)
    await made.runtime.start()
    assert not stale.exists()
    await made.runtime.stop()


async def test_a_refused_private_folder_is_one_warning_that_names_the_folder(
    xdg: Path, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    folder = tmp_path / "runtime-dir" / "token-grill"
    folder.parent.mkdir(parents=True, exist_ok=True)
    folder.symlink_to(tmp_path)
    made = await build(xdg)
    with caplog.at_level(logging.WARNING):
        await made.runtime.start()
    warnings = [record for record in caplog.records if record.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert str(folder) in warnings[0].getMessage()
    await made.runtime.stop()
