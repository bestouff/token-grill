"""The Claude usage response as usage windows."""

from dataclasses import dataclass
from typing import Any

from tokengrill.core.json_util import clamp_fraction, is_record, number_at, record_at, string_at, to_epoch_ms
from tokengrill.core.types import CanonicalQuotaWindow, UsageWindow
from tokengrill.providers.windows import FIVE_HOURS, WEEK, window_label

# The key names give the length of each window.
_LEGACY_WINDOWS: list[tuple[str, CanonicalQuotaWindow, int]] = [
    ("five_hour", "five-hour", FIVE_HOURS),
    ("seven_day", "weekly", WEEK),
    ("seven_day_opus", "other", WEEK),
    ("seven_day_sonnet", "other", WEEK),
]

_LIMIT_GROUPS: dict[str, tuple[CanonicalQuotaWindow, int]] = {
    "session": ("five-hour", FIVE_HOURS),
    "weekly": ("weekly", WEEK),
}


@dataclass
class _Entry:
    canonical_window: CanonicalQuotaWindow
    scope: str | None
    window: UsageWindow


def _scope_name(scope: dict[str, Any] | None) -> str | None:
    if not scope:
        return None
    model = record_at(scope, "model")
    name = (string_at(model, "display_name") or string_at(model, "id")) if model else None
    return " - ".join(part for part in (name, string_at(scope, "surface")) if part) or None


def _make_window(
    window_id: str,
    canonical_window: CanonicalQuotaWindow,
    label: str,
    percentage_points: float,
    reset: object,
    duration_seconds: int,
) -> UsageWindow:
    """Claude reports utilization in percentage points (0-100), including fractions: 1 means 1% used."""
    reset_at = to_epoch_ms(reset)
    return {
        "id": window_id,
        "canonicalWindow": canonical_window,
        "label": label,
        "used": None,
        "limit": None,
        "percent": clamp_fraction(percentage_points / 100),
        "resetAt": None if reset_at is None else int(reset_at),
        "durationSeconds": duration_seconds,
        "unit": None,
        "pace": None,
    }


def _model_of(scope: str) -> str:
    return scope.split(" - ")[0].lower()


def _limit_windows(limits: object, legacy_keys: set[str], present: set[CanonicalQuotaWindow]) -> list[UsageWindow]:
    """Model-scoped limits in the `limits` array are separate limits that Claude shows to the user, so each
    one is kept unless a legacy model key such as seven_day_opus already reports it. Unscoped limits only fill
    the windows the legacy keys left out, because otherwise they repeat them."""
    if not isinstance(limits, list):
        return []
    entries: list[_Entry] = []
    for item in [entry for entry in limits if is_record(entry)]:
        percent = number_at(item, "percent")
        group = string_at(item, "group") or ""
        group_window = _LIMIT_GROUPS.get(group)
        if percent is None or group_window is None:
            continue
        canonical_window, seconds = group_window
        scope = _scope_name(record_at(item, "scope"))
        if scope and f"seven_day_{_model_of(scope)}" in legacy_keys:
            continue
        kind = string_at(item, "kind") or group
        base = window_label(canonical_window, kind)
        window_id = f"limits:{kind}:{scope}" if scope else f"limits:{kind}"
        label = f"{base} - {scope}" if scope else base
        window = _make_window(window_id, canonical_window, label, percent, item.get("resets_at"), seconds)
        entries.append(_Entry(canonical_window, scope, window))
    fills: dict[CanonicalQuotaWindow, _Entry] = {}
    for entry in entries:
        existing = fills.get(entry.canonical_window)
        if entry.canonical_window in present or (existing and (not existing.scope or entry.scope)):
            continue
        fills[entry.canonical_window] = entry
    used = [id(entry) for entry in fills.values()]
    scoped: list[UsageWindow] = [
        {**entry.window, "canonicalWindow": "other"} for entry in entries if entry.scope and id(entry) not in used
    ]
    return [entry.window for entry in fills.values()] + scoped


def normalize_claude_usage(payload: object) -> list[UsageWindow]:
    if not is_record(payload):
        return []
    windows: list[UsageWindow] = []
    legacy_keys: set[str] = set()
    for key, canonical_window, seconds in _LEGACY_WINDOWS:
        item = record_at(payload, key)
        utilization = number_at(item, "utilization") if item else None
        if item is not None and utilization is not None:
            legacy_keys.add(key)
            label = window_label(canonical_window, key.replace("_", " "))
            windows.append(_make_window(key, canonical_window, label, utilization, item.get("resets_at"), seconds))
    present = {window["canonicalWindow"] for window in windows}
    return windows + _limit_windows(payload.get("limits"), legacy_keys, present)
