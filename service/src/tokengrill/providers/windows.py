"""Window lengths and labels shared by the collectors."""

import calendar
from datetime import UTC, datetime, timedelta
from typing import TypedDict

from tokengrill.core.types import CanonicalQuotaWindow

# Labels are data, matched by the window preference and shown only for
# windows outside the three canonical ones; the UI names those itself.
_LABELS: dict[str, str] = {"five-hour": "Five-hour", "weekly": "Weekly", "monthly": "Monthly"}

FIVE_HOURS = 5 * 3600
WEEK = 7 * 86400


def named_length(canonical_window: CanonicalQuotaWindow) -> int | None:
    """A window the service names "5h" or "seven_day" lasts that long; usage pace needs the length."""
    if canonical_window == "five-hour":
        return FIVE_HOURS
    return WEEK if canonical_window == "weekly" else None


def month_before(reset_at: float | None) -> float | None:
    """A monthly allowance that resets on a date runs from the same day a month before."""
    if reset_at is None:
        return None
    reset = datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=reset_at)
    year, month = (reset.year - 1, 12) if reset.month == 1 else (reset.year, reset.month - 1)
    # Date.setUTCMonth rolls a day the earlier month lacks into the next month.
    overflow = max(0, reset.day - calendar.monthrange(year, month)[1])
    start = reset.replace(year=year, month=month, day=reset.day - overflow) + timedelta(days=overflow)
    return (reset - start).total_seconds()


class WindowType(TypedDict):
    canonicalWindow: CanonicalQuotaWindow
    label: str


def claim_type(claimed: set[str], canonical_window: CanonicalQuotaWindow, name: str) -> WindowType:
    """A reading keeps one window of each type; a second one, such as a model's own weekly limit,
    becomes a limit of its own, named after the model or pool."""
    if canonical_window == "other":
        return {"canonicalWindow": canonical_window, "label": name}
    if canonical_window not in claimed:
        claimed.add(canonical_window)
        return {"canonicalWindow": canonical_window, "label": _LABELS[canonical_window]}
    return {"canonicalWindow": "other", "label": f"{name} - {_LABELS[canonical_window]}"}


def window_label(canonical_window: CanonicalQuotaWindow, fallback: str) -> str:
    return fallback if canonical_window == "other" else _LABELS[canonical_window]
