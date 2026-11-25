"""The last limits of each account (readings-v1.json), so they keep showing after a restart."""

import math
from pathlib import Path
from typing import Any, TypedDict

from tokengrill.core.json_util import is_record
from tokengrill.core.types import Balance, ProviderSnapshot, UsageWindow
from tokengrill.storage.atomic_json import Persisted, dumps, state_path


class StoredReading(TypedDict):
    plan: str | None
    # Windows and reset credits as 0.4.1 wrote them: no pace, no error.
    windows: list[dict[str, Any]]
    balance: Balance | None
    resetCredits: dict[str, Any] | None
    fetchedAt: int


_CANONICAL_WINDOWS = ("five-hour", "weekly", "monthly", "other")


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _nullable_number(record: dict[str, Any], key: str) -> bool:
    return key in record and (record[key] is None or _is_number(record[key]))


def _is_window(value: object) -> bool:
    return (
        is_record(value)
        and isinstance(value.get("id"), str)
        and isinstance(value.get("label"), str)
        and value.get("canonicalWindow") in _CANONICAL_WINDOWS
        and all(_nullable_number(value, key) for key in ("used", "limit", "percent", "resetAt", "durationSeconds"))
        and "unit" in value
        and value["unit"] in (None, "credits")
    )


def _is_balance(value: object) -> bool:
    return is_record(value) and _is_number(value.get("amount")) and isinstance(value.get("currency"), str)


def _is_credit(value: object) -> bool:
    return (
        is_record(value)
        and "title" in value
        and (value["title"] is None or isinstance(value["title"], str))
        and _nullable_number(value, "expiresAt")
    )


def _is_reset_credits(value: object) -> bool:
    return (
        is_record(value)
        and isinstance(value.get("availableCount"), int | float)
        and not isinstance(value.get("availableCount"), bool)
        and isinstance(value.get("fetchedAt"), int | float)
        and not isinstance(value.get("fetchedAt"), bool)
        and isinstance(value.get("stale"), bool)
        and isinstance(value.get("credits"), list)
        and all(_is_credit(credit) for credit in value["credits"])
    )


def _without_pace(window: UsageWindow) -> dict[str, Any]:
    # The 0.4.1 file knows no pace; the next refresh computes it again.
    return {
        "id": window["id"],
        "canonicalWindow": window["canonicalWindow"],
        "label": window["label"],
        "used": window["used"],
        "limit": window["limit"],
        "percent": window["percent"],
        "resetAt": window["resetAt"],
        "durationSeconds": window["durationSeconds"],
        "unit": window["unit"],
    }


def stored_reading(snapshot: ProviderSnapshot) -> StoredReading | None:
    """The account name is left out: Token Grill writes no e-mail address to disk."""
    fetched_at = snapshot["quotaFetchedAt"]
    if fetched_at is None:
        return None
    credits = snapshot["resetCredits"]
    return {
        "plan": snapshot["plan"],
        "windows": [_without_pace(window) for window in snapshot["windows"]],
        "balance": snapshot["balance"],
        "resetCredits": {**credits, "error": None} if credits else None,
        "fetchedAt": fetched_at,
    }


def parse_stored_reading(value: object) -> StoredReading | None:
    """A damaged entry is dropped as a whole, so a half-read reading never shows."""
    if not is_record(value) or not _is_number(value.get("fetchedAt")):
        return None
    plan = value.get("plan", ...)
    windows = value.get("windows")
    if not (plan is None or isinstance(plan, str)) or not isinstance(windows, list):
        return None
    if not all(_is_window(window) for window in windows):
        return None
    balance = value.get("balance", ...)
    credits = value.get("resetCredits", ...)
    if not (balance is None or _is_balance(balance)) or not (credits is None or _is_reset_credits(credits)):
        return None
    return {
        "plan": plan,
        "windows": windows,
        "balance": balance,
        "resetCredits": credits,
        "fetchedAt": value["fetchedAt"],
    }


class ReadingStore(Persisted):
    """Port of SnapshotStore."""

    def __init__(self, path: Path | None = None) -> None:
        super().__init__(path or state_path("readings-v1.json"))
        self._readings: dict[str, StoredReading] = {}

    async def load(self) -> None:
        accounts = (await self._read()).get("accounts")
        for provider_id, value in (accounts if is_record(accounts) else {}).items():
            reading = parse_stored_reading(value)
            if reading:
                self._readings[provider_id] = reading

    def get(self, provider_id: str) -> StoredReading | None:
        return self._readings.get(provider_id)

    def set(self, snapshot: ProviderSnapshot) -> None:
        """A snapshot without a reading, such as one cleared for a new sign-in, removes the old one."""
        provider_id = snapshot["providerId"]
        reading = stored_reading(snapshot)
        previous = self._readings.get(provider_id)
        if dumps(reading) == dumps(previous):
            return
        if reading:
            self._readings[provider_id] = reading
        else:
            self._readings.pop(provider_id, None)
        self._mark_dirty()

    async def remove_provider(self, provider_id: str) -> None:
        self._readings.pop(provider_id, None)
        self._mark_dirty()
        await self.flush()

    def _contents(self) -> object:
        return {"schemaVersion": 1, "accounts": self._readings}
