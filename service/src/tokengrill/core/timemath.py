"""Countdown arithmetic for reset times."""

import math
import time
from typing import TypedDict


def now_ms() -> int:
    return int(time.time() * 1000)


class DurationParts(TypedDict):
    expired: bool
    totalMinutes: int
    days: int
    hours: int
    minutes: int


def duration_until(target_at: float | None, now: float | None = None) -> DurationParts | None:
    if target_at is None or not math.isfinite(target_at):
        return None
    current = time.time() * 1000 if now is None else now
    difference = target_at - current
    remaining = 0 if 0 < difference < 60000 else max(0, math.ceil(difference / 60000))
    return {
        "expired": target_at <= current,
        "totalMinutes": remaining,
        "days": remaining // 1440,
        "hours": (remaining % 1440) // 60,
        "minutes": remaining % 60,
    }


def format_duration(parts: DurationParts, compact: bool = False) -> str:
    """`compact` drops the minutes once a duration reaches whole days."""
    if parts["totalMinutes"] < 1:
        return "less than 1m"
    if parts["days"] > 0 and compact:
        return f"{parts['days']}d {parts['hours']}h"
    if parts["days"] > 0:
        return f"{parts['days']}d {parts['hours']}h {parts['minutes']}m"
    if parts["hours"] > 0:
        return f"{parts['hours']}h {parts['minutes']}m"
    return f"{parts['minutes']}m"
