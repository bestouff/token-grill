"""Line reader for the JSONL session logs, resumable from a byte offset."""

import asyncio
from collections.abc import Callable
from pathlib import Path

# Small reads keep every pass over the event loop short.
CHUNK_SIZE = 64 * 1024
_NEWLINE = b"\n"


def _decode(parts: list[bytes]) -> str:
    return b"".join(parts).decode("utf-8-sig", errors="replace")


async def scan_jsonl(path: Path, offset: int, on_line: Callable[[str], None], max_line_bytes: int) -> int:
    """Returns the offset just past the last complete line.

    A line that is still being written is read again in full on the next pass.
    Lines longer than the limit are tool output, not usage records, and are
    skipped without being buffered.
    """
    handle = await asyncio.to_thread(path.open, "rb")
    try:
        await asyncio.to_thread(handle.seek, offset)
        parts: list[bytes] = []
        part_length = 0
        overlong = False
        position = offset
        line_end = offset
        while True:
            chunk = await asyncio.to_thread(handle.read, CHUNK_SIZE)
            if not chunk:
                break
            start = 0
            newline = chunk.find(_NEWLINE)
            while newline != -1:
                if not overlong and part_length + newline - start <= max_line_bytes:
                    parts.append(chunk[start:newline])
                    on_line(_decode(parts))
                parts = []
                part_length = 0
                overlong = False
                start = newline + 1
                line_end = position + start
                newline = chunk.find(_NEWLINE, start)
            rest = len(chunk) - start
            if overlong or part_length + rest > max_line_bytes:
                overlong = True
                parts = []
                part_length = 0
            elif rest:
                parts.append(chunk[start:])
                part_length += rest
            position += len(chunk)
        return line_end
    finally:
        await asyncio.to_thread(handle.close)
