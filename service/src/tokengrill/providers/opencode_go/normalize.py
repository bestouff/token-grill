"""OpenCode Go reports one pool for the whole subscription, whatever model is used.

Fields from the community-observed response: {rolling|weekly|monthly: {status, percent, resetsAt}},
optionally wrapped in `usage`.
"""

from tokengrill.core.json_util import clamp_fraction, is_record, number_at, record_at, string_at, to_epoch_ms
from tokengrill.core.types import CanonicalQuotaWindow, UsageWindow
from tokengrill.providers.windows import month_before, named_length, window_label

_WINDOWS: list[tuple[str, CanonicalQuotaWindow]] = [
    ("rolling", "five-hour"),
    ("weekly", "weekly"),
    ("monthly", "monthly"),
]


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
        month = month_before(reset_at)
        duration = (None if month is None else int(month)) if canonical == "monthly" else named_length(canonical)
        windows.append(
            {
                "id": window_id,
                "canonicalWindow": canonical,
                "label": window_label(canonical, window_id),
                "used": None,
                "limit": None,
                "percent": used,
                "resetAt": None if reset_at is None else int(reset_at),
                "durationSeconds": duration,
                "unit": None,
                "pace": None,
            }
        )
    return windows
