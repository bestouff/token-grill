"""The Kiro usage response as one monthly credits window."""

from dataclasses import dataclass, field
from typing import Any

from tokengrill.core.json_util import clamp_fraction, is_record, number_at, record_at, string_at, to_epoch_ms
from tokengrill.core.types import UsageWindow
from tokengrill.providers.windows import month_before


@dataclass
class KiroUsage:
    windows: list[UsageWindow] = field(default_factory=list)
    plan: str | None = None
    account: str | None = None


def _precise_number(record: dict[str, Any], key: str) -> int | float | None:
    """Kiro reports both rounded and precise counters; the precise ones are preferred."""
    precise = number_at(record, f"{key}WithPrecision")
    return precise if precise is not None else number_at(record, key)


def _first(*values: float | None) -> int | float | None:
    return next((value for value in values if value is not None), None)


def normalize_kiro_usage(payload: object) -> KiroUsage:
    if not is_record(payload):
        return KiroUsage()
    subscription = record_at(payload, "subscriptionInfo")
    user = record_at(payload, "userInfo")
    plan = (string_at(subscription, "subscriptionTitle") or string_at(subscription, "type")) if subscription else None
    account = string_at(user, "email") if user else None
    raw = payload.get("usageBreakdownList")
    breakdowns = [item for item in raw if is_record(item)] if isinstance(raw, list) else []
    credits = next((item for item in breakdowns if item.get("resourceType") == "CREDIT"), None)
    used = _precise_number(credits, "currentUsage") if credits else None
    limit = _precise_number(credits, "usageLimit") if credits else None
    if credits is None or (used is None and limit is None):
        return KiroUsage(plan=plan, account=account)
    reset_at = _first(to_epoch_ms(credits.get("nextDateReset")), to_epoch_ms(payload.get("nextDateReset")))
    duration = month_before(reset_at)
    window: UsageWindow = {
        "id": "monthly-credits",
        "canonicalWindow": "monthly",
        "label": "Monthly credits",
        "used": used,
        "limit": limit,
        # A zero limit means pooled or unlimited credits, which have no meaningful percentage.
        "percent": clamp_fraction(used / limit) if used is not None and limit is not None and limit > 0 else None,
        "resetAt": None if reset_at is None else int(reset_at),
        "durationSeconds": None if duration is None else int(duration),
        "unit": "credits",
        "pace": None,
    }
    return KiroUsage(windows=[window], plan=plan, account=account)
