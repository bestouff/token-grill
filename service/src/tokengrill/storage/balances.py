"""The full amount of each prepaid account (balances-v1.json), so a meter does not reset to 100 % on login."""

import math
from pathlib import Path
from typing import TypedDict

from tokengrill.core.json_util import is_record
from tokengrill.storage.atomic_json import Persisted, state_path


class BalanceReference(TypedDict):
    currency: str
    full: float
    last: float


def _is_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value)


def _is_reference(value: object) -> bool:
    return (
        is_record(value)
        and isinstance(value.get("currency"), str)
        and _is_number(value.get("full"))
        and _is_number(value.get("last"))
    )


class BalanceStore(Persisted):
    def __init__(self, path: Path | None = None) -> None:
        super().__init__(path or state_path("balances-v1.json"))
        self._accounts: dict[str, BalanceReference] = {}

    async def load(self) -> None:
        accounts = (await self._read()).get("accounts")
        for provider_id, reference in (accounts if is_record(accounts) else {}).items():
            if _is_reference(reference):
                self._accounts[provider_id] = reference

    def get(self, provider_id: str) -> BalanceReference | None:
        return self._accounts.get(provider_id)

    def set(self, provider_id: str, reference: BalanceReference) -> None:
        self._accounts[provider_id] = reference
        self._mark_dirty()

    async def remove_provider(self, provider_id: str) -> None:
        self._accounts.pop(provider_id, None)
        self._mark_dirty()
        await self.flush()

    def _contents(self) -> object:
        return {"schemaVersion": 1, "accounts": self._accounts}
