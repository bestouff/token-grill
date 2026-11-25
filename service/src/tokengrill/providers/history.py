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


def _find_history_files(directory: str, cutoff: int, visited: set[tuple[int, int]] | None = None) -> list[HistoryFile]:
    # Folder links are followed, but each folder is listed once, so a link loop ends.
    visited = set() if visited is None else visited
    try:
        info = os.stat(directory)
        if (info.st_dev, info.st_ino) in visited:
            return []
        visited.add((info.st_dev, info.st_ino))
        entries = sorted(os.scandir(directory), key=lambda entry: entry.name)
    except FileNotFoundError:
        # A tool that was never used has no history directory.
        return []
    files: list[HistoryFile] = []
    for entry in entries:
        try:
            if entry.is_dir():
                files.extend(_find_history_files(entry.path, cutoff, visited))
                continue
            if not entry.is_file() or not entry.name.endswith(".jsonl"):
                continue
            found = entry.stat()
        except FileNotFoundError:
            # Sessions can be removed while they are listed.
            continue
        mtime = int(found.st_mtime)
        if mtime >= cutoff:
            files.append(HistoryFile(entry.path, found.st_size, mtime))
    return files


def _collect_into(events: list[UsageEvent], parse_line: Callable[[str], UsageEvent | None]) -> Callable[[str], None]:
    def on_line(line: str) -> None:
        event = parse_line(line)
        if event is not None:
            events.append(event)

    return on_line


async def scan_history(
    instance: ProviderInstance,
    parse_line: Callable[[str], UsageEvent | None],
    aggregates: AggregateStore,
    checkpoints: CheckpointStore,
) -> None:
    """Each file is read from where the previous pass stopped; files that did not change are not opened.

    The events of a file reach the totals together with its new checkpoint, after the file is read, so a scan
    that is cancelled or fails part way adds nothing for that file and the next pass reads it again.
    """
    cutoff = int(time.time()) - RETENTION_SECONDS
    roots = provider_paths(instance)["historyDirectories"]
    found = await asyncio.to_thread(lambda: [file for root in roots for file in _find_history_files(root, cutoff)])

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
        events: list[UsageEvent] = []
        start = resumable["offset"] if resumable else 0
        try:
            offset = await scan_jsonl(Path(file.path), start, _collect_into(events, parse_line), MAX_LINE_BYTES)
        except FileNotFoundError:
            continue
        for event in events:
            aggregates.add(instance["id"], event)
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
