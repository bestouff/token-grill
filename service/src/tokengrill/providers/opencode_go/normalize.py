"""OpenCode Go reports one pool for the whole subscription, whatever model is used.

Fields from the community-observed response: {rolling|weekly|monthly: {status, percent, resetsAt}},
optionally wrapped in `usage`.
"""

from tokengrill.core.json_util import clamp_fraction, is_record, number_at, record_at, string_at, to_epoch_ms
from tokengrill.core.types import CanonicalQuotaWindow, UsageWindow
from tokengrill.providers.windows import WEEK, month_before, window_label

_WINDOWS: list[tuple[str, CanonicalQuotaWindow]] = [
    ("rolling", "five-hour"),
    ("weekly", "weekly"),
    ("monthly", "monthly"),
]


def _length(window_id: str, reset_at: float | None) -> int | None:
    """The response has no length field, so only a window whose name carries its length has one:
    "weekly", and "monthly" through the month before its reset. "rolling" names no length, so it has no pace."""
    if window_id == "monthly":
        month = month_before(reset_at)
        return None if month is None else int(month)
    return WEEK if window_id == "weekly" else None


def normalize_open_code_go_usage(payload: object) -> list[UsageWindow]:
    root = (record_at(payload, "usage") or payload) if is_record(payload) else {}
    windows: list[UsageWindow] = []
    for window_id, canonical in _WINDOWS:
        item = record_at(root, window_id)
        percent = number_at(item, "percent") if item else None
        if item is None or percent is None:
            continue
        # A rate-limited window is closed before its percentage reaches 100.
        used = 1 if string_at(item, "status") == "rate-limited" else clamp_fraction(percent / 100)
        reset_at = to_epoch_ms(item.get("resetsAt"))
        windows.append(
            {
                "id": window_id,
                "canonicalWindow": canonical,
                "label": window_label(canonical, window_id),
                "used": None,
                "limit": None,
                "percent": used,
                "resetAt": None if reset_at is None else int(reset_at),
                "durationSeconds": _length(window_id, reset_at),
                "unit": None,
                "pace": None,
            }
        )
    return windows
