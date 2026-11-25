"""Cursor's dashboard service is undocumented. These readers keep only the fields seen in real
`GetCurrentPeriodUsage` and `GetPlanInfo` responses."""

import re
from typing import cast

from tokengrill.core.json_util import clamp_fraction, is_record, number_at, record_at, string_at, to_epoch_ms
from tokengrill.core.types import CanonicalQuotaWindow, UsageWindow
from tokengrill.providers.windows import claim_type

DAY_MS = 24 * 60 * 60 * 1000

# The total and the two pools of Cursor's usage page: Cursor's own models, which Auto uses, and the
# other models, picked by name.
_POOLS = [
    ("totalPercentUsed", "total", "Total"),
    ("autoPercentUsed", "cursor-models", "Cursor Models"),
    ("apiPercentUsed", "other-models", "Other Models"),
]

_DIGITS = re.compile(r"[0-9]+")
_JWT = re.compile(r"eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*")


def _epoch_ms(value: object) -> int | float | None:
    """Cursor sends epoch milliseconds as decimal strings."""
    return to_epoch_ms(int(value) if isinstance(value, str) and _DIGITS.fullmatch(value) else value)


def _cycle_type(start: float | None, end: float | None) -> CanonicalQuotaWindow:
    """All pools reset with the billing cycle, so its length gives their type."""
    if start is None or end is None:
        return "other"
    days = (end - start) / DAY_MS
    if 6 <= days <= 8:
        return "weekly"
    return "monthly" if 27 <= days <= 32 else "other"


def _seconds_between(start: float | None, end: float | None) -> int | None:
    """Whole seconds stay integers so the JSON matches 0.4.1; milliseconds of a fraction are kept as is."""
    if start is None or end is None or end <= start:
        return None
    seconds = (end - start) / 1000
    return int(seconds) if seconds == int(seconds) else cast(int, seconds)


def normalize_cursor_usage(payload: object) -> list[UsageWindow]:
    usage = record_at(payload, "planUsage") if is_record(payload) else None
    if not is_record(payload) or usage is None:
        return []
    start = _epoch_ms(payload.get("billingCycleStart"))
    end = _epoch_ms(payload.get("billingCycleEnd"))
    cycle = _cycle_type(start, end)
    duration = _seconds_between(start, end)
    reset_at = None if end is None else int(end)
    claimed: set[str] = set()
    windows: list[UsageWindow] = []
    for key, window_id, name in _POOLS:
        percent = number_at(usage, key)
        if percent is None:
            continue
        window_type = claim_type(claimed, cycle, name)
        windows.append(
            {
                "id": window_id,
                "canonicalWindow": window_type["canonicalWindow"],
                "label": window_type["label"],
                "used": None,
                "limit": None,
                # Cursor reports percentage points, 0 to 100.
                "percent": clamp_fraction(percent / 100),
                "resetAt": reset_at,
                "durationSeconds": duration,
                "unit": None,
                "pace": None,
            }
        )
    return windows


def is_jwt_like(token: str) -> bool:
    """Cursor stores either a plain JWT or an encrypted value with a prefix of its own."""
    return _JWT.fullmatch(token) is not None


def normalize_cursor_plan(payload: object) -> str | None:
    info = record_at(payload, "planInfo") if is_record(payload) else None
    return string_at(info, "planName") if info else None
