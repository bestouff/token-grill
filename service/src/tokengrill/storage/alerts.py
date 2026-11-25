"""Milestone and low-balance alert state (notifications-v1.json)."""

from pathlib import Path
from typing import Any, TypedDict

from tokengrill.core.json_util import is_record, to_number
from tokengrill.storage.atomic_json import Persisted, dumps, state_path

_MINUTE_MS = 60_000
_LEGACY_SUFFIX = ":selected-limit"


class WindowState(TypedDict):
    providerId: str
    resetIdentity: str
    lastNotifiedBucket: int
    configuredStep: int


def _rounded_reset(reset_at: float) -> int:
    """Math.round: halves go up."""
    return int((reset_at / _MINUTE_MS + 0.5) // 1) * _MINUTE_MS


def migrate_notification_state(windows: dict[str, Any]) -> dict[str, WindowState]:
    """0.3.x kept one alert state per account; it moves to the key of the limit it followed.

    The file is our own but may be damaged; one bad entry must not stop the start.
    """
    migrated: dict[str, Any] = {}
    for key, state in windows.items():
        if not is_record(state) or not isinstance(state.get("resetIdentity"), str):
            continue
        if not key.endswith(_LEGACY_SUFFIX):
            migrated[key] = state
            continue
        identity: str = state["resetIdentity"]
        limit, _, rest = identity.partition(":")
        reset = rest.partition(":")[0]
        reset_at = to_number(reset) if reset != "" else None
        reset_identity = f"{limit}:{_rounded_reset(reset_at)}" if reset_at is not None else identity
        if limit:
            migrated.setdefault(f"{key[: -len(_LEGACY_SUFFIX)]}:{limit}", {**state, "resetIdentity": reset_identity})
    return migrated


class AlertStateStore(Persisted):
    def __init__(self, path: Path | None = None) -> None:
        super().__init__(path or state_path("notifications-v1.json"))
        self._windows: dict[str, WindowState] = {}
        self._low_balance: dict[str, bool] = {}

    async def load(self) -> None:
        loaded = await self._read()
        windows = loaded.get("windows")
        if loaded.get("schemaVersion") != 2 or not is_record(windows):
            return
        low = loaded.get("lowBalance")
        self._low_balance = {
            key: value for key, value in (low if is_record(low) else {}).items() if isinstance(value, bool)
        }
        self._windows = migrate_notification_state(windows)

    def window(self, key: str) -> WindowState | None:
        return self._windows.get(key)

    def set_window(self, key: str, state: WindowState) -> None:
        if dumps(self._windows.get(key)) == dumps(state):
            return
        self._windows[key] = state
        self._mark_dirty()

    def low_balance(self, provider_id: str) -> bool | None:
        return self._low_balance.get(provider_id)

    def set_low_balance(self, provider_id: str, low: bool) -> None:
        if self._low_balance.get(provider_id) is low:
            return
        self._low_balance[provider_id] = low
        self._mark_dirty()

    async def remove_provider(self, provider_id: str) -> None:
        keys = [key for key, state in self._windows.items() if state["providerId"] == provider_id]
        for key in keys:
            del self._windows[key]
        had_balance = self._low_balance.pop(provider_id, None) is not None
        if keys or had_balance:
            self._mark_dirty()
        await self.flush()

    def _contents(self) -> object:
        return {"schemaVersion": 2, "windows": self._windows, "lowBalance": self._low_balance}
