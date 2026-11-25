"""The Codex usage response as usage windows."""

from typing import Any, TypedDict

from tokengrill.core.json_util import clamp_fraction, is_record, number_at, record_at, string_at, to_epoch_ms
from tokengrill.core.types import CanonicalQuotaWindow, UsageWindow
from tokengrill.providers.windows import claim_type

HOUR_SECONDS = 60 * 60
DAY_SECONDS = 24 * HOUR_SECONDS


class CodexUsage(TypedDict):
    windows: list[UsageWindow]
    plan: str | None


def _canonical_for(seconds: float | None) -> CanonicalQuotaWindow:
    """The duration identifies a window; `primary` and `secondary` only describe the order listed."""
    if seconds is not None and abs(seconds - 5 * HOUR_SECONDS) <= 2 * HOUR_SECONDS:
        return "five-hour"
    if seconds is not None and abs(seconds - 7 * DAY_SECONDS) <= DAY_SECONDS:
        return "weekly"
    return "other"


def _normalize_window(window: dict[str, Any], name: str | None, index: int, claimed: set[str]) -> UsageWindow | None:
    """`used_percent` is in percentage points (0-100), including fractions: 1 means 1% used.

    The plan's own windows keep their position-based ids; a model limit is named after the model and its
    window, so a choice in the popup follows it.
    """
    percentage_points = number_at(window, "used_percent")
    if percentage_points is None:
        return None
    seconds = number_at(window, "limit_window_seconds")
    duration = _canonical_for(seconds)
    kind = claim_type(claimed, duration, name if name is not None else "Usage limit")
    reset_at = to_epoch_ms(window.get("reset_at"))
    return {
        "id": f"{kind['canonicalWindow']}-{index}" if name is None else f"{name}:{duration}",
        "canonicalWindow": kind["canonicalWindow"],
        "label": kind["label"],
        "used": None,
        "limit": None,
        "percent": clamp_fraction(percentage_points / 100),
        "resetAt": None if reset_at is None else int(reset_at),
        "durationSeconds": int(seconds) if seconds is not None and seconds > 0 else None,
        "unit": None,
        "pace": None,
    }


def _rate_limit_windows(rate_limit: dict[str, Any] | None) -> list[dict[str, Any]]:
    if rate_limit is None:
        return []
    found = [record_at(rate_limit, "primary_window"), record_at(rate_limit, "secondary_window")]
    return [window for window in found if window is not None]


def normalize_codex_usage(payload: object) -> CodexUsage:
    if not is_record(payload):
        return {"windows": [], "plan": None}
    sources: list[tuple[dict[str, Any], str | None]] = [
        (window, None) for window in _rate_limit_windows(record_at(payload, "rate_limit"))
    ]
    # Plans with model-specific limits list them separately, each with its own windows.
    extra = payload.get("additional_rate_limits")
    for limit in [item for item in extra if is_record(item)] if isinstance(extra, list) else []:
        model = string_at(limit, "limit_name") or "Usage limit"
        sources.extend((window, model) for window in _rate_limit_windows(record_at(limit, "rate_limit")))
    windows: list[UsageWindow] = []
    claimed: set[str] = set()
    for window, name in sources:
        normalized = _normalize_window(window, name, len(windows), claimed)
        if normalized:
            windows.append(normalized)
    return {"windows": windows, "plan": string_at(payload, "plan_type")}
