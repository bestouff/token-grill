"""Milestone and low-balance alert state (notifications-v1.json)."""

from pathlib import Path

from tokengrill.core.alerts import WindowState, migrate_notification_state
from tokengrill.core.json_util import is_record
from tokengrill.storage.atomic_json import Persisted, dumps, state_path


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
