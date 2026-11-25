"""Read-only access to the SQLite databases of other tools."""

import asyncio
import contextlib
import os
import sqlite3
import uuid
from collections.abc import Callable
from pathlib import Path
from typing import TypeVar
from urllib.parse import quote

from tokengrill.core.paths import runtime_dir
from tokengrill.providers.credentials import credential_file_error

T = TypeVar("T")

# Byte 18 of an SQLite header is 2 when the database keeps a write-ahead log.
_HEADER_BYTES = 20
_WAL_FORMAT = 2
_SIDECARS = ("", "-wal", "-shm")


def _file_stamp(path: str) -> str | None:
    try:
        info = os.stat(path)
    except FileNotFoundError:
        return None
    return f"{info.st_mtime_ns}:{info.st_size}"


def _stamp(path: str) -> str | None:
    try:
        stamps = [_file_stamp(path), _file_stamp(f"{path}-wal")]
    except OSError as error:
        raise credential_file_error(error, path) from None
    return None if stamps[0] is None else "|".join(stamp or "" for stamp in stamps)


async def database_stamp(path: str) -> str | None:
    """Changes when the owning app writes to its database, including writes still held in the
    write-ahead log. None when the database does not exist."""
    return await asyncio.to_thread(_stamp, path)


def _uses_write_ahead_log(path: str) -> bool:
    with Path(path).open("rb") as handle:
        header = handle.read(_HEADER_BYTES)
    return len(header) > 18 and header[18] == _WAL_FORMAT


def _needs_private_copy(path: str) -> bool:
    """SQLite creates the -wal and -shm files of a write-ahead-log database when a reader opens it
    without them, which is the case while the owning app is closed. Then a private copy is read, so
    nothing appears beside the original."""
    if os.path.exists(f"{path}-wal") and os.path.exists(f"{path}-shm"):
        return False
    return _uses_write_ahead_log(path)


def _make_private_copy(path: str) -> str:
    directory = runtime_dir()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = str(directory / f"{uuid.uuid4().hex}.sqlite")
    contents = Path(path).read_bytes()
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(contents)
    return target


def _remove_private_copy(path: str) -> None:
    for suffix in _SIDECARS:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(f"{path}{suffix}")


def open_read_only(path: str) -> sqlite3.Connection:
    # mode=ro is advisory for some builds; query_only makes SQLite itself refuse writes.
    connection = sqlite3.connect(f"file:{quote(path)}?mode=ro", uri=True, timeout=5)
    try:
        connection.execute("PRAGMA query_only = ON")
    except sqlite3.Error:
        connection.close()
        raise
    return connection


def _read(path: str, work: Callable[[sqlite3.Connection], T]) -> T:
    copy: str | None = None
    try:
        if _needs_private_copy(path):
            copy = _make_private_copy(path)
        connection = open_read_only(copy or path)
        try:
            return work(connection)
        finally:
            connection.close()
    finally:
        if copy is not None:
            _remove_private_copy(copy)


async def read_database(path: str, work: Callable[[sqlite3.Connection], T]) -> T:
    """Runs `work` on a read-only connection in a thread. Errors of the database and the file
    (sqlite3.Error, OSError) pass through for the caller to map."""
    return await asyncio.to_thread(_read, path, work)


async def query_rows(path: str, sql: str, params: tuple[object, ...] = ()) -> list[tuple[object, ...]]:
    def work(connection: sqlite3.Connection) -> list[tuple[object, ...]]:
        return list(connection.execute(sql, params).fetchall())

    return await read_database(path, work)
