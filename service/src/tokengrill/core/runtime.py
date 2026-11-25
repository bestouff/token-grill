"""Owns the stores, the scheduler and the collectors; reports what changes through an Emitter."""

import asyncio
import logging
import random
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

import tokengrill
from tokengrill.core.account_edits import (
    pasted_keys,
    validate_draft,
    with_new_accounts,
    with_updated_account,
)
from tokengrill.core.alerts import check_milestone, notification_key, should_notify_low_balance
from tokengrill.core.config import (
    Config,
    ConfigStore,
    LegacySettings,
    apply_settings_patch,
    import_legacy,
    needs_refresh,
    parse_legacy,
)
from tokengrill.core.diagnostics import DiagnosticEntry, format_report, redact
from tokengrill.core.errors import InvalidRequest, ServiceError
from tokengrill.core.order import reorder_providers
from tokengrill.core.pace import with_pace
from tokengrill.core.paths import provider_paths, runtime_dir
from tokengrill.core.readings import restored_snapshot, snapshot_fingerprint
from tokengrill.core.scheduler import Scheduler, SchedulerJob
from tokengrill.core.timemath import now_ms
from tokengrill.core.topbar import is_shown, limit_key, set_automatic, shown_limits, toggle_limit
from tokengrill.core.types import (
    BALANCE_KEY,
    Alert,
    AlertKind,
    Balance,
    ProviderInstance,
    ProviderKind,
    ProviderRuntimeState,
    ProviderSnapshot,
    RefreshOutcome,
    RefreshPhase,
    RefreshSource,
    ServiceState,
    Settings,
    SourceResult,
    UsageWindow,
    empty_snapshot,
)
from tokengrill.core.validation import ProviderValidationErrors
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import Collector, CollectorContext, failed
from tokengrill.providers.candidates import Candidate
from tokengrill.providers.credential_state import CredentialState, credential_state
from tokengrill.providers.discovery import ALL_APPS, find_all_candidates, find_candidates
from tokengrill.providers.keyring import clear_api_key, store_api_key
from tokengrill.providers.pricing import PricingCatalog, load_catalog
from tokengrill.providers.sqlite import sweep_private_copies
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.alerts import AlertStateStore
from tokengrill.storage.balances import BalanceStore
from tokengrill.storage.checkpoints import CheckpointStore
from tokengrill.storage.diagnostics import DiagnosticsStore
from tokengrill.storage.readings import ReadingStore

ACCOUNT_LIMIT_MS = 30_000
ALL_ACCOUNTS_LIMIT_MS = 60_000

_LOG = logging.getLogger("tokengrill.runtime")


class _Store(Protocol):
    async def load(self) -> None: ...

    async def flush(self) -> None: ...


class Emitter(Protocol):
    """Where the runtime reports changes; the D-Bus layer implements it."""

    def account_changed(self, account_id: str, snapshot: ProviderSnapshot, runtime: ProviderRuntimeState) -> None: ...

    def accounts_changed(self, accounts: list[ProviderInstance]) -> None: ...

    def settings_changed(self, settings: Settings) -> None: ...

    def alert(self, alert: Alert) -> None: ...


def _idle_state() -> ProviderRuntimeState:
    return {
        "phase": "idle",
        "outcome": None,
        "completedAt": None,
        "sources": {"limits": None, "reset-credits": None, "history": None},
    }


def _copy_state(state: ProviderRuntimeState) -> ProviderRuntimeState:
    return {**state, "sources": dict(state["sources"])}


class Runtime:
    def __init__(
        self,
        config: ConfigStore,
        emitter: Emitter,
        http: HttpClient,
        collectors: dict[ProviderKind, Collector],
        clock: Callable[[], int] = now_ms,
    ) -> None:
        self._config_store = config
        self._emitter = emitter
        self._http = http
        self._collectors = collectors
        self._clock = clock
        self._config: Config | None = None
        self._catalog: PricingCatalog = {}
        self._aggregates = AggregateStore()
        self._checkpoints = CheckpointStore()
        self._balances = BalanceStore()
        self._readings = ReadingStore()
        self._alerts = AlertStateStore()
        self._diagnostics = DiagnosticsStore(None, str(Path.home()), {"version": tokengrill.__version__, "shell": ""})
        self._scheduler = Scheduler(self._collect, 300, clock=lambda: clock() / 1000, rng=random.Random())
        self._shell_connected = False
        self._paused = False
        self._snapshots: dict[str, ProviderSnapshot] = {}
        self._runtime_states: dict[str, ProviderRuntimeState] = {}
        self._last_account_request: dict[str, int] = {}
        self._last_all_request: int | None = None
        # One collection at a time, so progress shows per account and requests are not bursty.
        self._collecting = asyncio.Lock()
        self._tasks: set[asyncio.Task[None]] = set()
        # Edits read the list, wait for the file to be written and then replace the list.
        self._edits = asyncio.Lock()

    async def start(self) -> None:
        """Loads the stores and shows the saved readings as stale until the first refresh."""
        self._config = self._config_store.load()
        self._catalog = await asyncio.to_thread(load_catalog)
        try:
            await sweep_private_copies()
        except OSError:
            _LOG.warning("could not clear the private database copies in %s", runtime_dir(), exc_info=True)
        for store in self._stores():
            await store.load()
        self._scheduler.set_interval(self._config["refreshIntervalSeconds"])
        self._scheduler.set_providers(self._config["accounts"])
        for account in self._config["accounts"]:
            reading = self._readings.get(account["id"]) if account["liveUsageEnabled"] else None
            if reading:
                self._snapshots[account["id"]] = restored_snapshot(account["id"], reading)

    async def stop(self) -> None:
        """Cancels the running collections, then writes every store."""
        self._scheduler.stop()
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self._flush()

    def set_shell_connected(self, connected: bool) -> None:
        if connected == self._shell_connected:
            return
        self._shell_connected = connected
        if not connected:
            self._scheduler.stop()
            # The scheduler forgot its queue and cancelled the running batch; no account stays queued.
            for account_id, state in list(self._runtime_states.items()):
                if state["phase"] == "queued":
                    self._finish(account_id, "failed")
            return
        accounts = self._accounts()
        self._scheduler.set_paused(self._paused)
        self._scheduler.set_providers(accounts)
        self._scheduler.start()
        # As 0.4.1 on every enable: all enabled accounts are read now, silently when paused.
        self._scheduler.request([account["id"] for account in accounts if account["enabled"]])

    async def refresh(self, account_id: str) -> None:
        if not any(account["id"] == account_id and account["enabled"] for account in self._accounts()):
            return
        now = self._clock()
        if self._merged(account_id, now):
            return
        if not self._paused:
            self._last_account_request[account_id] = now
        await self._request([account_id])

    async def refresh_all(self) -> None:
        ids = [account["id"] for account in self._accounts() if account["enabled"]]
        now = self._clock()
        if not ids or (self._last_all_request is not None and now - self._last_all_request < ALL_ACCOUNTS_LIMIT_MS):
            return
        # A request refused while paused must not delay the first real one after resuming.
        if not self._paused:
            self._last_all_request = now
            for account_id in ids:
                self._last_account_request[account_id] = now
        await self._request(ids)

    def set_paused(self, paused: bool) -> None:
        self._paused = paused
        self._scheduler.set_paused(paused)

    # Account and settings edits

    async def import_accounts(self, legacy: object) -> int:
        """The one-time takeover of the 0.4.x GSettings; refused once there are accounts or a backup."""
        values: LegacySettings = parse_legacy(legacy)
        async with self._edits:
            if self._config is None:
                raise InvalidRequest("the service has not started")
            try:
                imported = await import_legacy(self._config_store, values)
            except OSError:
                # The accounts are saved before the backup is written; a failed backup must not leave this stale.
                saved = self._config_store.load()
                if saved["accounts"]:
                    await self._adopt(saved)
                raise
            if imported:
                await self._adopt(self._config_store.load())
            return imported

    async def add_accounts(self, entries: object) -> tuple[list[str], dict[str, ProviderValidationErrors]]:
        """A draft may carry a pasted `apiKey`: it is stored before its account exists, as in 0.4.1, so a key the
        keyring refuses (ServiceError) adds nothing and leaves no account without its key behind."""
        keys = pasted_keys(entries)
        async with self._edits:
            before = self._accounts()
            after, errors = with_new_accounts(before, entries)
            if errors:
                return [], errors
            known = {account["id"] for account in before}
            # with_new_accounts appends the drafts in their order.
            added = [account for account in after if account["id"] not in known]
            stored = await self._store_keys(
                [(account["id"], key) for account, key in zip(added, keys, strict=True) if key]
            )
            try:
                await self._apply_accounts(after)
            except OSError:
                # Only a failed save leaves the accounts out; later steps run with the accounts added.
                if self._accounts() != after:
                    await self._clear_keys(stored)
                raise
            return [account["id"] for account in added], {}

    async def _store_keys(self, keys: list[tuple[str, str]]) -> list[str]:
        stored: list[str] = []
        try:
            for account_id, key in keys:
                await store_api_key(account_id, key)
                stored.append(account_id)
        except ServiceError:
            await self._clear_keys(stored)
            raise
        return stored

    async def _clear_keys(self, account_ids: list[str]) -> None:
        """The accounts are not added, so no key may stay behind for them."""
        for account_id in account_ids:
            try:
                await clear_api_key(account_id)
            except ServiceError:
                _LOG.warning("could not remove the API key of an account that was not added", exc_info=True)

    async def update_account(self, entry: object) -> ProviderValidationErrors:
        async with self._edits:
            after, errors = with_updated_account(self._accounts(), entry)
            if not errors:
                await self._apply_accounts(after)
            return errors

    async def remove_account(self, account_id: str, remove_key: bool) -> None:
        async with self._edits:
            before = self._accounts()
            removed = next((account for account in before if account["id"] == account_id), None)
            if removed is None:
                return
            after = reorder_providers(
                [account for account in before if account["id"] != account_id],
                [account["id"] for account in before if account["id"] != account_id],
            )
            await self._apply_accounts(after)
        if remove_key:
            try:
                await clear_api_key(account_id)
            except ServiceError:
                _LOG.warning("could not remove the API key of a removed account", exc_info=True)

    async def reorder_accounts(self, ids: list[str]) -> None:
        async with self._edits:
            await self._apply_accounts(reorder_providers(self._accounts(), ids))

    async def discover(self, app: str) -> list[Candidate]:
        """An empty app means every app. Nothing is written and no keyring is unlocked."""
        accounts = self._accounts()
        if app == "":
            return await find_all_candidates(accounts)
        if app not in ALL_APPS:
            raise InvalidRequest("unknown app")
        return await find_candidates(app, accounts)

    async def credential_state(self, account_id: str) -> CredentialState:
        return await credential_state(self._account(account_id))

    async def save_api_key(self, account_id: str, key: str) -> None:
        """Write-only: the key goes to Token Grill's own keyring item and is neither logged nor returned."""
        account = self._account(account_id)
        if account["kind"] != "deepseek" or account["app"] != "keyring":
            raise InvalidRequest("this account does not keep its key in the keyring")
        if not key.strip():
            raise InvalidRequest("the key is empty")
        await store_api_key(account_id, key.strip())

    def validate_account(self, draft: object) -> ProviderValidationErrors:
        return validate_draft(self._accounts(), draft)

    async def toggle_limit(self, account_id: str, limit_key: str) -> None:
        async with self._edits:
            account = self._account(account_id)
            windows = self._snapshots[account_id]["windows"] if account_id in self._snapshots else []
            await self._replace(toggle_limit(account, limit_key, windows))

    async def set_automatic(self, account_id: str, automatic: bool) -> None:
        async with self._edits:
            await self._replace(set_automatic(self._account(account_id), automatic))

    async def set_settings(self, patch: object) -> None:
        async with self._edits:
            config = self._loaded()
            settings = apply_settings_patch(self._settings(), patch)
            if settings == self._settings():
                return
            updated: Config = {**config, **settings}
            await self._config_store.save(updated)
            self._config = updated
            self._scheduler.set_interval(settings["refreshIntervalSeconds"])
            self._emitter.settings_changed(settings)

    def diagnostics_report(self) -> str:
        """The stored steps, redacted once more in case an entry was written by an older version."""
        home = str(Path.home())
        entries: list[DiagnosticEntry] = [
            {**entry, "detail": redact(entry["detail"], home)} for entry in self._diagnostics.entries()
        ]
        date = datetime.fromtimestamp(self._clock() / 1000, UTC).strftime("%Y-%m-%d")
        return format_report(entries, {"version": tokengrill.__version__, "date": date})

    def _loaded(self) -> Config:
        if self._config is None:
            raise InvalidRequest("the service has not started")
        return self._config

    def _account(self, account_id: str) -> ProviderInstance:
        found = next((account for account in self._accounts() if account["id"] == account_id), None)
        if found is None:
            raise InvalidRequest("unknown account")
        return found

    async def _replace(self, account: ProviderInstance) -> None:
        await self._apply_accounts([account if item["id"] == account["id"] else item for item in self._accounts()])

    async def _adopt(self, config: Config) -> None:
        """Takes a config that is already saved: the import writes it itself."""
        before = self._accounts()
        self._config = config
        self._scheduler.set_interval(config["refreshIntervalSeconds"])
        await self._accounts_changed(before, config["accounts"])
        self._emitter.settings_changed(self._settings())

    async def _apply_accounts(self, accounts: list[ProviderInstance]) -> None:
        config = self._loaded()
        if accounts == config["accounts"]:
            return
        before = config["accounts"]
        await self._config_store.save({**config, "accounts": accounts})
        self._config = {**config, "accounts": accounts}
        await self._accounts_changed(before, accounts)

    async def _accounts_changed(self, before: list[ProviderInstance], after: list[ProviderInstance]) -> None:
        previous = {account["id"]: account for account in before}
        kept = {account["id"] for account in after}
        removed = [account_id for account_id in previous if account_id not in kept]
        for account_id in removed:
            self._snapshots.pop(account_id, None)
            self._runtime_states.pop(account_id, None)
            self._last_account_request.pop(account_id, None)
        self._scheduler.set_providers(after)
        self._emitter.accounts_changed(after)
        if removed:
            await self._forget_stored(removed)
        # A rename or a colour needs no new reading.
        self._refresh_after_edit(
            [
                account["id"]
                for account in after
                if account["enabled"] and needs_refresh(previous.get(account["id"]), account)
            ]
        )

    async def _forget_stored(self, ids: list[str]) -> None:
        """As 0.4.1: totals, read offsets, balances and the last readings of a removed account go with it."""
        try:
            for account_id in ids:
                await self._aggregates.remove_provider(account_id)
                await self._checkpoints.remove_provider(account_id)
                await self._balances.remove_provider(account_id)
                await self._readings.remove_provider(account_id)
                await self._alerts.remove_provider(account_id)
        except OSError:
            _LOG.warning("could not remove the stored data of a removed account", exc_info=True)

    def _refresh_after_edit(self, ids: list[str]) -> None:
        """Silent, as 0.4.1: a paused session is not shown as failed, and the caller does not wait for the reading."""
        if not ids or self._paused:
            return
        for account_id in ids:
            self._runtime_states[account_id] = {**_idle_state(), "phase": "queued"}
            self._emit(account_id)
        if self._shell_connected:
            self._scheduler.request(ids)
            return
        accounts = {account["id"]: account for account in self._accounts()}
        jobs: list[SchedulerJob] = [{"provider": accounts[id_], "manual": True} for id_ in ids]
        task = asyncio.get_running_loop().create_task(self._collect(jobs))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def state(self) -> ServiceState:
        now = self._clock()
        accounts = self._accounts()
        by_id = {account["id"]: account for account in accounts}
        return {
            "schema": 1,
            "apiVersion": tokengrill.API_VERSION,
            "serviceVersion": tokengrill.__version__,
            "paused": self._paused,
            "settings": self._settings(),
            "accounts": accounts,
            "snapshots": {
                id_: with_pace(snapshot, by_id[id_], now) for id_, snapshot in self._snapshots.items() if id_ in by_id
            },
            "runtime": {id_: _copy_state(state) for id_, state in self._runtime_states.items() if id_ in by_id},
        }

    def _accounts(self) -> list[ProviderInstance]:
        return self._config["accounts"] if self._config else []

    def _settings(self) -> Settings:
        config = self._config
        if config is None:
            return self._config_store.load()
        return {
            "refreshIntervalSeconds": config["refreshIntervalSeconds"],
            "alertsEnabled": config["alertsEnabled"],
            "alertStepPercent": config["alertStepPercent"],
            "journalDiagnostics": config["journalDiagnostics"],
        }

    def _interval_seconds(self) -> int:
        return self._settings()["refreshIntervalSeconds"]

    def _older_than(self, account_id: str, age_ms: int) -> bool:
        updated = self._snapshots.get(account_id, empty_snapshot(account_id))["lastUpdated"]
        return updated is None or self._clock() - updated >= age_ms

    def _merged(self, account_id: str, now: int) -> bool:
        """A request inside the limit is covered by the one that came before it."""
        last = self._last_account_request.get(account_id)
        return last is not None and now - last < ACCOUNT_LIMIT_MS

    async def _request(self, ids: list[str]) -> None:
        if self._paused:
            for account_id in ids:
                self._finish(account_id, "failed")
            return
        for account_id in ids:
            self._runtime_states[account_id] = {**_idle_state(), "phase": "queued"}
            self._emit(account_id)
        if self._shell_connected:
            self._scheduler.request(ids)
            return
        # Without a shell client there is no scheduler loop, so the explicit refresh runs here.
        accounts = {account["id"]: account for account in self._accounts()}
        jobs: list[SchedulerJob] = [{"provider": accounts[id_], "manual": True} for id_ in ids]
        task = asyncio.get_running_loop().create_task(self._collect(jobs))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        # wait() does not raise when stop() cancels the task.
        await asyncio.wait({task})

    async def _collect(self, jobs: list[SchedulerJob]) -> None:
        current = asyncio.current_task()
        if current is not None:
            self._tasks.add(current)
        try:
            async with self._collecting:
                for job in jobs:
                    await self._refresh_account(job["provider"], job["manual"])
                await self._flush_quietly()
        except asyncio.CancelledError:
            # Losing the shell client or stopping must not leave an account mid-refresh.
            for job in jobs:
                state = self._runtime_states.get(job["provider"]["id"])
                if state is not None and state["phase"] != "idle":
                    self._finish(job["provider"]["id"], "failed")
            raise
        finally:
            if current is not None:
                self._tasks.discard(current)

    async def _refresh_account(self, instance: ProviderInstance, manual: bool) -> None:
        account_id = instance["id"]
        state = _idle_state()
        state["phase"] = "fetching-limits"
        self._runtime_states[account_id] = state
        self._emit(account_id)

        def on_phase(phase: RefreshPhase) -> None:
            state["phase"] = phase
            self._emit(account_id)

        def on_source(source: RefreshSource, result: SourceResult) -> None:
            state["sources"][source] = result

        ctx = CollectorContext(
            http=self._http,
            pricing=self._catalog,
            aggregates=self._aggregates,
            checkpoints=self._checkpoints,
            balances=self._balances,
            on_phase=on_phase,
            on_source=on_source,
            on_record=lambda step, detail: self._record(instance, step, detail),
            manual=manual,
            history_enabled=self._shell_connected,
        )
        self._record(instance, "sign-in", self._sign_in_source(instance))
        previous = self._snapshots.get(account_id)
        try:
            snapshot = await self._collectors[instance["kind"]].collect(
                instance, previous or empty_snapshot(account_id), ctx
            )
        except Exception:  # noqa: BLE001 - an expected failure comes back in the snapshot; anything raised is a bug
            _LOG.exception("collector for %s failed", instance["kind"])
            # The last values stay, marked stale; one broken collector must not stop the other accounts.
            snapshot = failed(previous or empty_snapshot(account_id), ServiceError("internal", "service.internal"))

        if await self._drop_if_removed(account_id):
            return
        self._snapshots[account_id] = snapshot
        self._readings.set(snapshot)
        if snapshot["errorInfo"]:
            # Sign-in problems end a refresh before any request, so they are recorded here.
            self._record(instance, "error", f"refresh: {snapshot['errorInfo']['code']}")
        await self._decide_alerts(instance, snapshot)
        if snapshot["errorInfo"]:
            self._finish(account_id, "failed")
        elif "failed" in state["sources"].values():
            self._finish(account_id, "partial")
        elif previous is not None and snapshot_fingerprint(previous) == snapshot_fingerprint(snapshot):
            self._finish(account_id, "unchanged")
        else:
            self._finish(account_id, "changed")

    async def _drop_if_removed(self, account_id: str) -> bool:
        """An account removed while its collection ran: the collector may have written its totals, offsets
        and balance after the removal cleaned them, so they go again."""
        if self._configured(account_id):
            return False
        self._runtime_states.pop(account_id, None)
        await self._forget_stored([account_id])
        return True

    async def _decide_alerts(self, instance: ProviderInstance, snapshot: ProviderSnapshot) -> None:
        """Only while a shell client can show the alert: without one no checkpoint advances, so the
        alert is decided when the shell is back. Only the limits shown in the top bar alert."""
        settings = self._settings()
        if (
            not self._shell_connected
            or not settings["alertsEnabled"]
            or snapshot["state"] in ("error", "disabled")
            or not is_shown(instance)
        ):
            return
        limits = shown_limits(instance, snapshot["windows"])
        for window in limits:
            if window["percent"] is None:
                continue
            key = notification_key(instance["id"], window)
            previous = self._alerts.window(key)
            check = check_milestone(previous, window, settings["alertStepPercent"])
            self._alerts.set_window(key, {"providerId": instance["id"], **check.checkpoint})
            if check.notify:
                self._emitter.alert(self._alert("milestone", instance["id"], window=window, fraction=check.consumed))
                await self._persist_alerts()
        if any(limit_key(window) == BALANCE_KEY for window in limits):
            await self._decide_low_balance(instance, snapshot)

    async def _decide_low_balance(self, instance: ProviderInstance, snapshot: ProviderSnapshot) -> None:
        balance = snapshot["balance"]
        threshold = instance["lowBalance"]
        if balance is None or threshold is None:
            return
        low = balance["amount"] < threshold
        previous = self._alerts.low_balance(instance["id"])
        self._alerts.set_low_balance(instance["id"], low)
        if should_notify_low_balance(previous, low):
            self._emitter.alert(self._alert("low-balance", instance["id"], balance=balance, low_balance=threshold))
            await self._persist_alerts()

    async def _persist_alerts(self) -> None:
        """As 0.4.1, which saved each checkpoint at once: a kill before the end of the batch must not
        repeat an alert that was already shown."""
        try:
            await self._alerts.flush()
        except OSError:
            _LOG.warning("could not write the alert state", exc_info=True)

    def _alert(
        self,
        kind: AlertKind,
        account_id: str,
        window: UsageWindow | None = None,
        fraction: float | None = None,
        balance: Balance | None = None,
        low_balance: float | None = None,
    ) -> Alert:
        return {
            "schema": 1,
            "kind": kind,
            "accountId": account_id,
            "window": window,
            "fraction": fraction,
            "balance": balance,
            "lowBalance": low_balance,
            "at": self._clock(),
        }

    def send_test_alert(self, account_id: str) -> None:
        """As the 0.4.1 test notification: the account's first shown limit as it reads now, or none."""
        account = self._account(account_id)
        snapshot = self._snapshots.get(account_id)
        window = next(iter(shown_limits(account, snapshot["windows"] if snapshot else [])), None)
        self._emitter.alert(
            self._alert("test", account_id, window=window, fraction=window["percent"] if window else None)
        )

    def _configured(self, account_id: str) -> bool:
        return any(account["id"] == account_id for account in self._accounts())

    def _finish(self, account_id: str, outcome: RefreshOutcome) -> None:
        if not self._configured(account_id):
            self._runtime_states.pop(account_id, None)
            return
        state = self._runtime_states.get(account_id) or _idle_state()
        self._runtime_states[account_id] = {
            **state,
            "phase": "idle",
            "outcome": outcome,
            "completedAt": self._clock(),
        }
        self._emit(account_id)

    def _emit(self, account_id: str) -> None:
        instance = next((account for account in self._accounts() if account["id"] == account_id), None)
        if instance is None:
            return
        snapshot = with_pace(self._snapshots.get(account_id) or empty_snapshot(account_id), instance, self._clock())
        state = self._runtime_states.get(account_id) or _idle_state()
        self._emitter.account_changed(account_id, snapshot, _copy_state(state))

    def _sign_in_source(self, instance: ProviderInstance) -> str:
        """Testers' reports show which file or keyring item an app's sign-in came from."""
        path = "" if instance["app"] in ("keyring", "copilot-cli") else provider_paths(instance)["authFile"]
        return f"{instance['app']} {path}" if path else f"{instance['app']} keyring"

    def _record(self, instance: ProviderInstance, step: str, detail: str) -> None:
        same_kind = [account["id"] for account in self._accounts() if account["kind"] == instance["kind"]]
        kind_index = same_kind.index(instance["id"]) if instance["id"] in same_kind else len(same_kind)
        entry: DiagnosticEntry = {
            "at": self._clock(),
            "account": f"{instance['kind']}-{kind_index + 1}",
            "kind": instance["kind"],
            "app": instance["app"],
            # The callers pass the step names of DiagnosticEntry as plain strings.
            "step": step,  # type: ignore[typeddict-item]
            "detail": detail,
        }
        kept = self._diagnostics.record(entry)
        if self._settings()["journalDiagnostics"]:
            _LOG.info("%s (%s) %s: %s", kept["account"], kept["app"], kept["step"], kept["detail"])

    async def _flush(self) -> None:
        """One store that cannot be written must not keep the last changes of the others off the disk.

        The checkpoints are written only after the totals they describe, so a failed write never moves a
        checkpoint past lines whose totals are lost.
        """
        try:
            await self._aggregates.flush()
            await self._checkpoints.flush()
        except OSError:
            _LOG.warning("could not write the history state", exc_info=True)
        for store in (self._balances, self._readings, self._alerts, self._diagnostics):
            try:
                await store.flush()
            except OSError:
                _LOG.warning("could not write a state file", exc_info=True)

    def _stores(self) -> tuple[_Store, ...]:
        return (
            self._aggregates,
            self._checkpoints,
            self._balances,
            self._readings,
            self._alerts,
            self._diagnostics,
        )

    async def _flush_quietly(self) -> None:
        try:
            await self._readings.flush()
            await self._alerts.flush()
            await self._diagnostics.flush()
        except OSError:
            _LOG.warning("could not write the state files", exc_info=True)
