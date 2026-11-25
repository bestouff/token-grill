"""Reads the JSONL session logs of a tool into the daily totals, once per line."""

import asyncio
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from tokengrill.core.paths import provider_paths
from tokengrill.core.types import ProviderInstance
from tokengrill.storage.aggregate import AggregateStore, UsageEvent
from tokengrill.storage.checkpoints import CheckpointStore
from tokengrill.storage.jsonl import scan_jsonl

# Totals are cumulative, so changing this re-reads every file and counts it again.
PARSER_VERSION = 1
RETENTION_SECONDS = 90 * 24 * 60 * 60
MAX_LINE_BYTES = 256 * 1024


@dataclass(frozen=True)
class HistoryFile:
    path: str
    size: int
    mtime: int


def _find_history_files(directory: str, cutoff: int) -> list[HistoryFile]:
    try:
        entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
    except FileNotFoundError:
        # A tool that was never used has no history directory.
        return []
    files: list[HistoryFile] = []
    for entry in entries:
        try:
            if entry.is_dir():
                files.extend(_find_history_files(entry.path, cutoff))
                continue
            if not entry.is_file() or not entry.name.endswith(".jsonl"):
                continue
            info = entry.stat()
        except FileNotFoundError:
            # Sessions can be removed while they are listed.
            continue
        mtime = int(info.st_mtime)
        if mtime >= cutoff:
            files.append(HistoryFile(entry.path, info.st_size, mtime))
    return files


async def scan_history(
    instance: ProviderInstance,
    parse_line: Callable[[str], UsageEvent | None],
    aggregates: AggregateStore,
    checkpoints: CheckpointStore,
) -> None:
    """Each file is read from where the previous pass stopped; files that did not change are not opened."""
    cutoff = int(time.time()) - RETENTION_SECONDS
    roots = provider_paths(instance)["historyDirectories"]
    found = await asyncio.to_thread(lambda: [file for root in roots for file in _find_history_files(root, cutoff)])

    def on_line(line: str) -> None:
        event = parse_line(line)
        if event is not None:
            aggregates.add(instance["id"], event)

    for file in found:
        checkpoint = checkpoints.get(instance["id"], file.path)
        resumable = (
            checkpoint
            if checkpoint is not None
            and checkpoint["parserVersion"] == PARSER_VERSION
            and checkpoint["size"] <= file.size
            else None
        )
        if resumable is not None and resumable["size"] == file.size and resumable["mtime"] == file.mtime:
            continue
        try:
            offset = await scan_jsonl(Path(file.path), resumable["offset"] if resumable else 0, on_line, MAX_LINE_BYTES)
        except FileNotFoundError:
            continue
        checkpoints.set(
            {
                "providerId": instance["id"],
                "path": file.path,
                "size": file.size,
                "mtime": file.mtime,
                "offset": offset,
                "parserVersion": PARSER_VERSION,
            }
        )
