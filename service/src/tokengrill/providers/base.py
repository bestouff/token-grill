"""The collector contract and the two steps every collector shares."""

import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Protocol, TypedDict

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import (
    Balance,
    ConnectionState,
    ProviderInstance,
    ProviderSnapshot,
    RefreshPhase,
    RefreshSource,
    SourceResult,
    UsageEvent,
    UsageWindow,
)
from tokengrill.net.http import HttpClient
from tokengrill.providers.history import scan_history
from tokengrill.providers.pricing import PricingCatalog
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.balances import BalanceStore
from tokengrill.storage.checkpoints import CheckpointStore

MONTH_MS = 30 * 24 * 60 * 60 * 1000


class LimitsUpdate(TypedDict, total=False):
    plan: str | None
    account: str | None
    windows: list[UsageWindow]
    balance: Balance | None


def _ignore_phase(phase: RefreshPhase) -> None:
    return None


def _ignore_source(source: RefreshSource, result: SourceResult) -> None:
    return None


def _ignore_record(step: str, detail: str) -> None:
    return None


class CollectorContext:
    """What a collector may use; progress and diagnostics go out through the callbacks."""

    def __init__(
        self,
        http: HttpClient,
        pricing: PricingCatalog,
        aggregates: AggregateStore,
        checkpoints: CheckpointStore,
        on_phase: Callable[[RefreshPhase], None] = _ignore_phase,
        on_source: Callable[[RefreshSource, SourceResult], None] = _ignore_source,
        on_record: Callable[[str, str], None] = _ignore_record,
        manual: bool = False,
        history_enabled: bool = True,
        balances: BalanceStore | None = None,
    ) -> None:
        self.http = http
        self.pricing = pricing
        self.aggregates = aggregates
        self.checkpoints = checkpoints
        # The full amount of each prepaid account; only balance collectors use it.
        self.balances = balances if balances is not None else BalanceStore()
        # True when the user explicitly asked for this refresh.
        self.manual = manual
        # History scans run only while a shell client is connected.
        self.history_enabled = history_enabled
        self._on_phase = on_phase
        self._on_source = on_source
        self._on_record = on_record

    def report_phase(self, phase: RefreshPhase) -> None:
        self._on_phase(phase)

    def report_source(self, source: RefreshSource, result: SourceResult) -> None:
        self._on_source(source, result)

    def record(self, step: str, detail: str) -> None:
        self._on_record(step, detail)


class Collector(Protocol):
    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot: ...


def _now_ms() -> int:
    return int(time.time() * 1000)


def _start_of_utc_day() -> int:
    today = datetime.now(UTC).replace(hour=0, minute=0, second=0, microsecond=0)
    return int(today.timestamp() * 1000)


def failed(snapshot: ProviderSnapshot, error: BaseException) -> ProviderSnapshot:
    """Expected failures keep the last known values, marked stale; anything else is a bug and propagates."""
    if not isinstance(error, ServiceError):
        raise error
    state: ConnectionState = "stale" if snapshot["lastUpdated"] else "error"
    return {**snapshot, "state": state, "errorInfo": error.info()}


async def collect_limits(
    ctx: CollectorContext, snapshot: ProviderSnapshot, fetch: Callable[[], Awaitable[LimitsUpdate]]
) -> ProviderSnapshot:
    try:
        update = await fetch()
    except ServiceError as error:
        ctx.report_source("limits", "failed")
        return failed(snapshot, error)
    ctx.report_source("limits", "success")
    now = _now_ms()
    return {**snapshot, **update, "state": "ready", "lastUpdated": now, "quotaFetchedAt": now, "errorInfo": None}


async def collect_history(
    ctx: CollectorContext,
    instance: ProviderInstance,
    snapshot: ProviderSnapshot,
    parse_line: Callable[[str], UsageEvent | None],
) -> ProviderSnapshot:
    if not ctx.history_enabled:
        return snapshot
    ctx.report_phase("scanning-history")
    try:
        await scan_history(instance, parse_line, ctx.aggregates, ctx.checkpoints)
        await ctx.aggregates.flush()
        await ctx.checkpoints.flush()
    except OSError:
        ctx.report_source("history", "failed")
        return failed(snapshot, ServiceError("local-history", "history.update-failed"))
    ctx.report_source("history", "success")
    today = _start_of_utc_day()
    month_start = _now_ms() - MONTH_MS
    id_ = instance["id"]
    return {
        **snapshot,
        "totals": ctx.aggregates.totals(id_, 0),
        "todayTotals": ctx.aggregates.totals(id_, today),
        "monthTotals": ctx.aggregates.totals(id_, month_start),
        "todayCost": ctx.aggregates.cost(id_, today, ctx.pricing),
        "monthCost": ctx.aggregates.cost(id_, month_start, ctx.pricing),
        "localHistoryUpdatedAt": _now_ms(),
    }
