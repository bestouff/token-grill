"""Kimi Code's usage endpoint is undocumented and public descriptions of it disagree.

Both layouts are read: `usages.limit_*` with used ratios, and a `usage` block plus `limits[]`
with counts (numbers may be strings).
"""

import re
from typing import Any, Literal

from tokengrill.core.json_util import clamp_fraction, is_record, record_at, string_at, to_epoch_ms, to_number
from tokengrill.core.types import CanonicalQuotaWindow, UsageWindow
from tokengrill.providers.windows import claim_type, month_before, named_length, window_label

# The key names give the length of each window.
_RATIO_WINDOWS: list[tuple[str, CanonicalQuotaWindow, str, Literal["five-hour", "weekly", "month"]]] = [
    ("limit_5h", "five-hour", "", "five-hour"),
    ("limit_7d", "weekly", "", "weekly"),
    ("limit_month_total", "monthly", "", "month"),
    ("limit_month_code", "other", "Monthly Code", "month"),
]

_UNIT_SECONDS = {"MINUTE": 60, "HOUR": 3600, "DAY": 86400}


def _make_window(
    window_id: str,
    canonical: CanonicalQuotaWindow,
    label: str,
    percent: float,
    reset: object,
    duration_seconds: int | None,
) -> UsageWindow:
    reset_at = to_epoch_ms(reset)
    return {
        "id": window_id,
        "canonicalWindow": canonical,
        "label": window_label(canonical, label),
        "used": None,
        "limit": None,
        "percent": clamp_fraction(percent),
        "resetAt": None if reset_at is None else int(reset_at),
        "durationSeconds": duration_seconds,
        "unit": None,
        "pace": None,
    }


def _ratio_windows(usages: dict[str, Any]) -> list[UsageWindow]:
    windows: list[UsageWindow] = []
    for window_id, canonical, label, length in _RATIO_WINDOWS:
        item = record_at(usages, window_id)
        ratio = to_number(item.get("used_ratio")) if item else None
        if item is None or ratio is None:
            continue
        if length == "month":
            month = month_before(to_epoch_ms(item.get("reset_time")))
            seconds = None if month is None else int(month)
        else:
            seconds = named_length(length)
        windows.append(_make_window(window_id, canonical, label, ratio, item.get("reset_time"), seconds))
    return windows


def _window_seconds(window: dict[str, Any] | None) -> int | None:
    duration = to_number(window.get("duration")) if window else None
    unit = _UNIT_SECONDS.get(string_at(window, "timeUnit") or "") if window else None
    return int(duration * unit) if duration is not None and duration > 0 and unit is not None else None


def _window_kind(seconds: int | None) -> CanonicalQuotaWindow:
    if seconds == 5 * 3600:
        return "five-hour"
    return "weekly" if seconds == 7 * 86400 else "other"


def _count_window(
    window_id: str,
    canonical: CanonicalQuotaWindow,
    label: str,
    detail: dict[str, Any],
    seconds: int | None,
) -> UsageWindow | None:
    limit = to_number(detail.get("limit"))
    remaining = to_number(detail.get("remaining"))
    used = to_number(detail.get("used"))
    if used is None and limit is not None and remaining is not None:
        used = limit - remaining
    if limit is None or limit <= 0 or used is None:
        return None
    reset = detail.get("resetTime")
    return _make_window(
        window_id, canonical, label, used / limit, reset if reset is not None else detail.get("reset_time"), seconds
    )


def normalize_kimi_usage(payload: object) -> list[UsageWindow]:
    if not is_record(payload):
        return []
    usages = record_at(payload, "usages")
    by_ratio = _ratio_windows(usages) if usages else []
    if by_ratio:
        return by_ratio
    windows: list[UsageWindow] = []
    claimed: set[str] = set()
    usage = record_at(payload, "usage")
    weekly = _count_window("usage", "weekly", "", usage, None) if usage else None
    if weekly:
        claimed.add("weekly")
        windows.append(weekly)
    limits = payload.get("limits")
    for index, item in enumerate(limits if isinstance(limits, list) else []):
        if not is_record(item):
            continue
        seconds = _window_seconds(record_at(item, "window"))
        window_type = claim_type(claimed, _window_kind(seconds), string_at(item, "name") or "Usage Limit")
        window = _count_window(
            f"limit-{index}",
            window_type["canonicalWindow"],
            window_type["label"],
            record_at(item, "detail") or item,
            seconds,
        )
        if window:
            windows.append(window)
    return windows


def kimi_api_host(config_toml: str) -> str:
    """Kimi Code serves the global and mainland China regions from different hosts."""
    return "api.kimi.ai" if re.search(r"api\.kimi\.ai", config_toml) else "api.kimi.com"
