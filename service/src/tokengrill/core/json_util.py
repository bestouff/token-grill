"""Readers for untyped JSON from services and credential files."""

import json
import math
import re
from datetime import UTC, datetime, timedelta
from typing import Any, TypeGuard

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_MS = timedelta(milliseconds=1)
_DECIMAL = re.compile(r"[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?")
_RADIX = re.compile(r"0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+")


def is_record(value: object) -> TypeGuard[dict[str, Any]]:
    return isinstance(value, dict)


def _is_finite_number(value: object) -> TypeGuard[int | float]:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:
        # An integer too large for a float is not a JSON number JS could hold.
        return False


def parse_record(text: str) -> dict[str, Any] | None:
    """Text from another program may be truncated or rewritten while it is read."""
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if is_record(value) else None


def record_at(record: dict[str, Any], key: str) -> dict[str, Any] | None:
    value = record.get(key)
    return value if is_record(value) else None


def number_at(record: dict[str, Any], key: str) -> int | float | None:
    value = record.get(key)
    return value if _is_finite_number(value) else None


def string_at(record: dict[str, Any], key: str) -> str | None:
    value = record.get(key)
    return value if isinstance(value, str) and value != "" else None


def _parse_date(text: str) -> int | None:
    """Date.parse for ISO 8601: date-only is UTC, a date-time without offset is local."""
    try:
        parsed = datetime.fromisoformat(text.strip())
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC) if "T" not in text and " " not in text.strip() else parsed.astimezone()
    return (parsed - _EPOCH) // _MS


def to_epoch_ms(value: object) -> int | float | None:
    """Services mix epoch seconds, epoch milliseconds and ISO 8601 strings.

    Epoch values below 1e10 are seconds: as milliseconds they would predate 1970-04.
    """
    if _is_finite_number(value):
        return value * 1000 if value < 1e10 else value
    if isinstance(value, str) and value != "":
        return _parse_date(value)
    return None


def to_number(value: object) -> int | float | None:
    """Some services send numbers as decimal strings."""
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if _DECIMAL.fullmatch(text):
            number: object = float(text)
        elif _RADIX.fullmatch(text):
            number = int(text, 0)
        else:
            return None
        return number if _is_finite_number(number) else None
    return value if _is_finite_number(value) else None


def clamp_fraction(value: float) -> float:
    return max(0, min(1, value))
