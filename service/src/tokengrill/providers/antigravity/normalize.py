"""The cloudcode-pa responses as plan and usage windows."""

from typing import Any, TypedDict

from tokengrill.core.json_util import clamp_fraction, is_record, number_at, record_at, string_at, to_epoch_ms
from tokengrill.core.types import CanonicalQuotaWindow, UsageWindow
from tokengrill.providers.windows import named_length, window_label


class QuotaSummaryBucket(TypedDict):
    canonicalWindow: CanonicalQuotaWindow
    remainingFraction: float
    resetAt: int | None


_BUCKET_WINDOWS: dict[str, CanonicalQuotaWindow] = {"5h": "five-hour", "weekly": "weekly"}


def antigravity_plan(payload: object) -> str | None:
    """The subscription tier from a loadCodeAssist response."""
    tier = record_at(payload, "currentTier") if is_record(payload) else None
    return string_at(tier, "name") if tier else None


def extract_quota_summary_buckets(payload: object) -> list[QuotaSummaryBucket]:
    """retrieveUserQuotaSummary groups models (Gemini, Claude and GPT) and gives each group its own
    five-hour and weekly bucket."""
    groups = payload.get("groups") if is_record(payload) else None
    buckets: list[QuotaSummaryBucket] = []
    for group in groups if isinstance(groups, list) else []:
        if not is_record(group):
            continue
        items: Any = group.get("buckets")
        for bucket in items if isinstance(items, list) else []:
            if not is_record(bucket):
                continue
            canonical = _BUCKET_WINDOWS.get(string_at(bucket, "window") or "")
            remaining = number_at(bucket, "remainingFraction")
            reset = to_epoch_ms(bucket.get("resetTime"))
            if canonical and remaining is not None:
                buckets.append(
                    {
                        "canonicalWindow": canonical,
                        "remainingFraction": clamp_fraction(remaining),
                        "resetAt": None if reset is None else int(reset),
                    }
                )
    return buckets


def _tighter(a: QuotaSummaryBucket, b: QuotaSummaryBucket) -> QuotaSummaryBucket:
    """The tightest bucket decides what the user can do next, so the lowest remaining fraction wins;
    ties go to the earliest reset."""
    if a["remainingFraction"] != b["remainingFraction"]:
        return a if a["remainingFraction"] < b["remainingFraction"] else b
    b_reset = b["resetAt"]
    a_reset = a["resetAt"]
    if b_reset is not None and (a_reset is None or b_reset < a_reset):
        return b
    return a


def normalize_quota_summary(payload: object) -> list[UsageWindow]:
    tightest: dict[CanonicalQuotaWindow, QuotaSummaryBucket] = {}
    for bucket in extract_quota_summary_buckets(payload):
        current = tightest.get(bucket["canonicalWindow"])
        tightest[bucket["canonicalWindow"]] = _tighter(current, bucket) if current else bucket
    return [
        {
            "id": bucket["canonicalWindow"],
            "canonicalWindow": bucket["canonicalWindow"],
            "label": window_label(bucket["canonicalWindow"], bucket["canonicalWindow"]),
            "used": None,
            "limit": None,
            "percent": 1 - bucket["remainingFraction"],
            "resetAt": bucket["resetAt"],
            # The buckets are named "5h" and "weekly".
            "durationSeconds": named_length(bucket["canonicalWindow"]),
            "unit": None,
            "pace": None,
        }
        for bucket in tightest.values()
    ]
