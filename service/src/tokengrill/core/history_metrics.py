"""What the popup shows for local history: the sums of one account."""

from typing import Literal, TypedDict

from tokengrill.core.types import ProviderInstance, ProviderKind, ProviderRuntimeState, ProviderSnapshot

HistoryState = Literal["unsupported", "off", "waiting", "updating", "failed", "ready"]

LOCAL_HISTORY_KINDS: frozenset[ProviderKind] = frozenset({"codex", "claude"})


class HistoryMetrics(TypedDict):
    state: HistoryState
    todayTokens: int
    monthTokens: int
    # None when no model in the period has a known price.
    monthCost: float | None


def _status(state: HistoryState) -> HistoryMetrics:
    return {"state": state, "todayTokens": 0, "monthTokens": 0, "monthCost": None}


def history_metrics(
    instance: ProviderInstance, snapshot: ProviderSnapshot | None, runtime: ProviderRuntimeState | None
) -> HistoryMetrics:
    if instance["kind"] not in LOCAL_HISTORY_KINDS:
        return _status("unsupported")
    if not instance["localHistoryEnabled"]:
        return _status("off")
    if snapshot is None or not snapshot["localHistoryUpdatedAt"]:
        if runtime is not None and runtime["phase"] == "scanning-history":
            return _status("updating")
        if runtime is not None and runtime["sources"].get("history") == "failed":
            return _status("failed")
        return _status("waiting")
    month_tokens = snapshot["monthTotals"]["total"]
    month_cost = snapshot["monthCost"]
    return {
        "state": "ready",
        "todayTokens": snapshot["todayTotals"]["total"],
        "monthTokens": month_tokens,
        # An empty month is free even without price data.
        "monthCost": month_cost if month_cost is not None else (0 if month_tokens == 0 else None),
    }
