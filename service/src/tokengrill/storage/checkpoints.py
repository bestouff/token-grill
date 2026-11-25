"""How far each history file has been read (checkpoints-v1.json)."""

import json
from pathlib import Path
from typing import Any, TypedDict, TypeGuard

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


def _is_count(value: object) -> TypeGuard[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _checkpoint(item: object) -> FileCheckpoint | None:
    """A damaged entry is dropped, so its file is read again instead of failing every scan."""
    if not is_record(item):
        return None
    provider_id, path = item.get("providerId"), item.get("path")
    size, mtime, offset, version = item.get("size"), item.get("mtime"), item.get("offset"), item.get("parserVersion")
    if not (isinstance(provider_id, str) and isinstance(path, str)):
        return None
    if not (_is_count(size) and _is_count(mtime) and _is_count(offset) and _is_count(version)):
        return None
    return {
        "providerId": provider_id,
        "path": path,
        "size": size,
        "mtime": mtime,
        "offset": offset,
        "parserVersion": version,
    }


class CheckpointStore(Persisted):
    def __init__(self, path: Path | None = None) -> None:
        super().__init__(path or state_path("checkpoints-v1.json"))
        self._files: dict[str, FileCheckpoint] = {}

    async def load(self) -> None:
        file = await self._read()
        files: Any = file.get("files")
        for item in files if isinstance(files, list) else []:
            checkpoint = _checkpoint(item)
            if checkpoint is not None:
                self._files[_key(checkpoint["providerId"], checkpoint["path"])] = checkpoint

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
