"""Private state files: limited reads, JSON.stringify-compatible text, atomic writes."""

import asyncio
import json
import logging
import math
import os
import re
import stat
import tempfile
from decimal import Decimal
from pathlib import Path
from typing import Any

from tokengrill.core.paths import data_dir, state_dir

MAX_STATE_BYTES = 4 * 1024 * 1024

_LOG = logging.getLogger("tokengrill.storage")
_SURROGATE = re.compile("[\ud800-\udfff]")


def data_path(name: str) -> Path:
    return data_dir() / name


def state_path(name: str) -> Path:
    return state_dir() / name


def _refuse_constant(name: str) -> object:
    raise ValueError(f"{name} is not JSON")


def read_json(path: Path, max_bytes: int) -> object | None:
    """A missing file is the normal first run. A damaged one is reported once and left in place."""
    try:
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            _LOG.warning("Ignoring %s: not a regular file or larger than %d bytes", path, max_bytes)
            return None
        text = path.read_bytes().decode("utf-8-sig", errors="replace")
    except FileNotFoundError:
        return None
    try:
        return json.loads(text, parse_constant=_refuse_constant)  # type: ignore[no-any-return]
    except ValueError:
        _LOG.warning("Ignoring unreadable state file %s", path)
        return None


def _js_float(value: float) -> str:
    """Number.prototype.toString for a finite double."""
    if value == 0:
        return "0"
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    _, digit_tuple, exponent = Decimal(repr(abs(value))).as_tuple()
    assert isinstance(exponent, int)
    digits = "".join(map(str, digit_tuple)).rstrip("0")
    point = len(digit_tuple) + exponent
    count = len(digits)
    prefix = "-" if value < 0 else ""
    if count <= point <= 21:
        body = digits + "0" * (point - count)
    elif 0 < point <= 21:
        body = digits[:point] + "." + digits[point:]
    elif -6 < point <= 0:
        body = "0." + "0" * -point + digits
    else:
        shift = point - 1
        mantissa = digits[0] + ("." + digits[1:] if count > 1 else "")
        body = f"{mantissa}e{'+' if shift >= 0 else '-'}{abs(shift)}"
    return prefix + body


def _js_string(value: str) -> str:
    text = json.dumps(value, ensure_ascii=False)
    return _SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", text)


def dumps(value: object) -> str:
    """The text JSON.stringify makes: no spaces, no trailing newline, shortest numbers."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _js_float(value) if math.isfinite(value) else "null"
    if isinstance(value, str):
        return _js_string(value)
    if isinstance(value, dict):
        return "{" + ",".join(f"{_js_string(str(key))}:{dumps(item)}" for key, item in value.items()) + "}"
    if isinstance(value, list | tuple):
        return "[" + ",".join(dumps(item) for item in value) + "]"
    raise TypeError(f"{type(value).__name__} is not JSON")


def _make_directory(directory: Path) -> None:
    """Only directories created here are restricted; existing ones keep the user's mode."""
    if directory.is_dir():
        return
    _make_directory(directory.parent)
    try:
        directory.mkdir(mode=0o700)
    except FileExistsError:
        return
    directory.chmod(0o700)


def _write_atomic(path: Path, text: str) -> None:
    _make_directory(path.parent)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(text.encode("utf-8"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise


class SerialWriter:
    """Writes one state file in order, never two at once; the latest payload wins."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = asyncio.Lock()
        self._pending: str | None = None

    async def write(self, payload: object) -> None:
        # Serialized now, so later changes to the caller's objects never leak into this write.
        self._pending = dumps(payload)
        await self._drain()

    async def flush(self) -> None:
        await self._drain()

    async def _drain(self) -> None:
        async with self._lock:
            text = self._pending
            if text is None:
                return
            self._pending = None
            try:
                await asyncio.to_thread(_write_atomic, self.path, text)
            except BaseException:
                # A failed write is kept for the next flush unless a newer payload replaced it.
                if self._pending is None:
                    self._pending = text
                raise


class Persisted:
    """A store backed by one file: changes mark it dirty, `flush` writes it when it is."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._writer = SerialWriter(path)
        self._dirty = False

    def _contents(self) -> object:
        raise NotImplementedError

    def _mark_dirty(self) -> None:
        self._dirty = True

    async def _read(self) -> dict[str, Any]:
        value = await asyncio.to_thread(read_json, self.path, MAX_STATE_BYTES)
        return value if isinstance(value, dict) else {}

    async def flush(self) -> None:
        if not self._dirty:
            await self._writer.flush()
            return
        self._dirty = False
        try:
            await self._writer.write(self._contents())
        except BaseException:
            self._dirty = True
            raise
