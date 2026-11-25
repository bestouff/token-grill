"""The last refresh steps (diagnostics-v1.json), redacted before they are kept."""

import asyncio
from pathlib import Path
from typing import Any, Literal, TypedDict

from tokengrill.core.diagnostics import redact
from tokengrill.core.json_util import is_record
from tokengrill.core.types import AccountApp, ProviderKind
from tokengrill.storage.atomic_json import MAX_STATE_BYTES, Persisted, read_json, state_path

MAX_ENTRIES = 200


class DiagnosticEntry(TypedDict):
    at: int
    account: str
    kind: ProviderKind
    app: AccountApp
    step: Literal["sign-in", "request", "response", "error"]
    detail: str


class DiagnosticsAbout(TypedDict):
    version: str
    shell: str


class Diagnostics(TypedDict):
    about: DiagnosticsAbout | None
    entries: list[DiagnosticEntry]


def _is_entry(value: object) -> bool:
    return (
        is_record(value)
        and isinstance(value.get("at"), int | float)
        and not isinstance(value.get("at"), bool)
        and all(isinstance(value.get(key), str) for key in ("account", "kind", "app", "step", "detail"))
    )


def _is_about(value: object) -> bool:
    return is_record(value) and isinstance(value.get("version"), str) and isinstance(value.get("shell"), str)


def read_diagnostics(path: Path | None = None) -> Diagnostics:
    """Blocking read, for the preferences-style one-shot callers."""
    file = read_json(path or state_path("diagnostics-v1.json"), MAX_STATE_BYTES)
    record: dict[str, Any] = file if is_record(file) else {}
    entries = record.get("entries")
    return {
        "about": record["about"] if _is_about(record.get("about")) else None,
        "entries": [entry for entry in entries if _is_entry(entry)] if isinstance(entries, list) else [],
    }


class DiagnosticsStore(Persisted):
    def __init__(self, path: Path | None, home: str, about: DiagnosticsAbout) -> None:
        super().__init__(path or state_path("diagnostics-v1.json"))
        self._home = home
        self._about = about
        self._entries: list[DiagnosticEntry] = []

    async def load(self) -> None:
        diagnostics = await asyncio.to_thread(read_diagnostics, self.path)
        self._entries = [*diagnostics["entries"], *self._entries][-MAX_ENTRIES:]
        # A new version or Shell is worth recording even before the next request.
        self._mark_dirty()

    def record(self, entry: DiagnosticEntry) -> DiagnosticEntry:
        kept: DiagnosticEntry = {**entry, "detail": redact(entry["detail"], self._home)}
        self._entries.append(kept)
        del self._entries[: max(0, len(self._entries) - MAX_ENTRIES)]
        self._mark_dirty()
        return kept

    def _contents(self) -> object:
        return {"schemaVersion": 1, "about": self._about, "entries": self._entries}
