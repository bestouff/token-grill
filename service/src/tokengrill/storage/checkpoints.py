"""How far each history file has been read (checkpoints-v1.json)."""

import json
from pathlib import Path
from typing import Any, TypedDict

from tokengrill.core.json_util import is_record
from tokengrill.storage.atomic_json import Persisted, state_path


class FileCheckpoint(TypedDict):
    providerId: str
    path: str
    size: int
    mtime: int
    offset: int
    parserVersion: int


def _key(provider_id: str, path: str) -> str:
    return json.dumps([provider_id, path])


class CheckpointStore(Persisted):
    def __init__(self, path: Path | None = None) -> None:
        super().__init__(path or state_path("checkpoints-v1.json"))
        self._files: dict[str, FileCheckpoint] = {}

    async def load(self) -> None:
        file = await self._read()
        files: Any = file.get("files")
        for item in files if isinstance(files, list) else []:
            if is_record(item) and isinstance(item.get("providerId"), str) and isinstance(item.get("path"), str):
                self._files[_key(item["providerId"], item["path"])] = item  # type: ignore[assignment]

    def get(self, provider_id: str, path: str) -> FileCheckpoint | None:
        return self._files.get(_key(provider_id, path))

    def set(self, checkpoint: FileCheckpoint) -> None:
        self._files[_key(checkpoint["providerId"], checkpoint["path"])] = checkpoint
        self._mark_dirty()

    async def remove_provider(self, provider_id: str) -> None:
        for key in [key for key, item in self._files.items() if item["providerId"] == provider_id]:
            del self._files[key]
        self._mark_dirty()
        await self.flush()

    def _contents(self) -> object:
        return {"schemaVersion": 1, "files": list(self._files.values())}
