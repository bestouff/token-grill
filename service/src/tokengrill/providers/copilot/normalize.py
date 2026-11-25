"""Field names from a real copilot_internal/user response (Copilot Free, 2026-11):
quota_snapshots.{chat, completions, premium_interactions}, each with entitlement,
percent_remaining, unlimited, token_based_billing and credits_used, plus
quota_reset_date_utc and access_type_sku. ghcp-spend-tray reads the same
credits fields for AI Credits plans.
"""

from typing import Any, TypedDict

from tokengrill.core.errors import ServiceError
from tokengrill.core.json_util import clamp_fraction, is_record, number_at, record_at, string_at, to_epoch_ms
from tokengrill.core.types import CanonicalQuotaWindow, UsageWindow
from tokengrill.providers.windows import month_before, window_label

_SNAPSHOTS: list[tuple[str, CanonicalQuotaWindow, str]] = [
    ("premium_interactions", "monthly", "Premium Requests"),
    ("chat", "other", "Chat"),
    ("completions", "other", "Code Completions"),
]


class CopilotUsage(TypedDict):
    windows: list[UsageWindow]
    plan: str | None


def _snapshot_window(
    snapshot: object, window_id: str, canonical: CanonicalQuotaWindow, label: str, reset_at: float | None
) -> UsageWindow | None:
    """A snapshot with no entitlement is a feature the plan lacks (Copilot Free has no
    premium requests); reading its percent_remaining of 0 as "all used" would be wrong."""
    if not is_record(snapshot) or snapshot.get("unlimited") is True:
        return None
    entitlement = number_at(snapshot, "entitlement")
    if entitlement is None or entitlement <= 0:
        return None
    month = month_before(reset_at)
    label = window_label(canonical, label)
    reset = None if reset_at is None else int(reset_at)
    duration = None if month is None else int(month)
    # Plans billed in AI Credits report the credits spent; count them out of the entitlement.
    credits_used = number_at(snapshot, "credits_used") if snapshot.get("token_based_billing") is True else None
    if credits_used is not None and credits_used >= 0:
        return {
            "id": window_id,
            "canonicalWindow": canonical,
            "label": label,
            "used": credits_used,
            "limit": entitlement,
            "percent": min(1, credits_used / entitlement),
            "resetAt": reset,
            "durationSeconds": duration,
            "unit": "credits",
            "pace": None,
        }
    percent_remaining = number_at(snapshot, "percent_remaining")
    if percent_remaining is None:
        return None
    return {
        "id": window_id,
        "canonicalWindow": canonical,
        "label": label,
        "used": None,
        "limit": None,
        "percent": clamp_fraction(1 - percent_remaining / 100),
        "resetAt": reset,
        "durationSeconds": duration,
        "unit": None,
        "pace": None,
    }


def normalize_copilot_usage(payload: object) -> CopilotUsage:
    root: dict[str, Any] = payload if is_record(payload) else {}
    snapshots = record_at(root, "quota_snapshots") or {}
    reset_at = to_epoch_ms(root.get("quota_reset_date_utc"))
    windows = [
        window
        for window_id, canonical, label in _SNAPSHOTS
        if (window := _snapshot_window(snapshots.get(window_id), window_id, canonical, label, reset_at))
    ]
    if not windows:
        raise ServiceError("unsupported-account", "copilot.no-limit")
    plan = (
        "Copilot Free"
        if string_at(root, "access_type_sku") == "free_limited_copilot"
        else string_at(root, "copilot_plan")
    )
    return {"windows": windows, "plan": plan}
