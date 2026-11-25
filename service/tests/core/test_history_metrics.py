from typing import Any, cast

from tokengrill.core.history_metrics import history_metrics
from tokengrill.core.types import ProviderInstance, ProviderRuntimeState, ProviderSnapshot


def instance(**overrides: object) -> ProviderInstance:
    return cast(ProviderInstance, {"kind": "codex", "localHistoryEnabled": True, **overrides})


def runtime(phase: str = "idle", history: str | None = None) -> ProviderRuntimeState:
    sources = {"limits": None, "reset-credits": None, "history": history}
    return cast(ProviderRuntimeState, {"phase": phase, "outcome": None, "completedAt": None, "sources": sources})


def snapshot(**overrides: Any) -> ProviderSnapshot:
    base: dict[str, Any] = {
        "localHistoryUpdatedAt": 1,
        "todayTotals": {"total": 12400},
        "monthTotals": {"total": 42000},
        "monthCost": 3.42,
    }
    return cast(ProviderSnapshot, {**base, **overrides})


def test_history_metrics_distinguish_unsupported_disabled_pending_updating_and_initial_failure() -> None:
    assert history_metrics(instance(kind="kiro"), None, runtime())["state"] == "unsupported"
    assert history_metrics(instance(localHistoryEnabled=False), None, runtime())["state"] == "off"
    assert history_metrics(instance(), None, runtime())["state"] == "waiting"
    assert history_metrics(instance(), None, None)["state"] == "waiting"
    assert history_metrics(instance(), None, runtime("scanning-history"))["state"] == "updating"
    assert history_metrics(instance(), None, runtime("idle", "failed"))["state"] == "failed"


def test_successful_history_metrics_carry_token_totals_and_cost_including_a_free_empty_month() -> None:
    assert history_metrics(instance(), snapshot(), runtime("idle", "success")) == {
        "state": "ready",
        "todayTokens": 12400,
        "monthTokens": 42000,
        "monthCost": 3.42,
    }
    empty = history_metrics(
        instance(), snapshot(todayTotals={"total": 0}, monthTotals={"total": 0}, monthCost=None), runtime()
    )
    assert empty["todayTokens"] == 0
    assert empty["monthCost"] == 0


def test_unpriced_history_has_no_cost_and_cached_metrics_survive_later_scan_failure() -> None:
    assert history_metrics(instance(), snapshot(monthCost=None), runtime())["monthCost"] is None
    cached = history_metrics(instance(), snapshot(), runtime("idle", "failed"))
    assert cached["state"] == "ready"
    assert cached["monthTokens"] == 42000
