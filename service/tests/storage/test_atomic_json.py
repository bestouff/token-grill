import asyncio
import logging
import os
import stat
from pathlib import Path

import pytest

from tokengrill.storage.atomic_json import SerialWriter, dumps, read_json


def test_read_json_missing_file_is_none(tmp_path: Path) -> None:
    assert read_json(tmp_path / "none.json", 100) is None


def test_read_json_too_large_is_none_and_kept(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    path = tmp_path / "big.json"
    path.write_text('{"a":"' + "x" * 200 + '"}')
    with caplog.at_level(logging.WARNING):
        assert read_json(path, 100) is None
    assert path.exists()
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 1


def test_read_json_invalid_is_none_and_kept(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    path = tmp_path / "bad.json"
    path.write_text("{not json")
    with caplog.at_level(logging.WARNING):
        assert read_json(path, 100) is None
    assert path.read_text() == "{not json"
    assert len(caplog.records) == 1


def test_read_json_directory_is_none(tmp_path: Path) -> None:
    assert read_json(tmp_path, 100) is None


def test_read_json_rejects_nan(tmp_path: Path) -> None:
    path = tmp_path / "nan.json"
    path.write_text('{"a":NaN}')
    assert read_json(path, 100) is None


def test_dumps_matches_json_stringify() -> None:
    value = {"a": [1, 2.0, 0.5, -0.0, 1e21, 1.5e-7, 123456789.125], "b": None, "c": True, "d": 'q"\n\x01' + chr(233)}
    assert (
        dumps(value)
        == '{"a":[1,2,0.5,0,1e+21,1.5e-7,123456789.125],"b":null,"c":true,"d":"q\\"\\n\\u0001' + chr(233) + '"}'
    )


def test_dumps_non_finite_is_null() -> None:
    assert dumps([float("nan"), float("inf")]) == "[null,null]"


def test_dumps_lone_surrogate_is_escaped() -> None:
    assert dumps("a" + chr(0xD800)) == '"a\\ud800"'


async def test_writes_are_private(tmp_path: Path) -> None:
    path = tmp_path / "new" / "deeper" / "file.json"
    await SerialWriter(path).write({"a": 1})
    assert path.read_text() == '{"a":1}'
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
    assert stat.S_IMODE(path.parent.parent.stat().st_mode) == 0o700


async def test_existing_folder_keeps_its_mode(tmp_path: Path) -> None:
    folder = tmp_path / "shared"
    folder.mkdir(mode=0o755)
    os.chmod(folder, 0o755)
    await SerialWriter(folder / "f.json").write([])
    assert stat.S_IMODE(folder.stat().st_mode) == 0o755


async def test_existing_wide_file_is_tightened(tmp_path: Path) -> None:
    path = tmp_path / "f.json"
    path.write_text("{}")
    os.chmod(path, 0o644)
    await SerialWriter(path).write({"a": 1})
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


async def test_last_write_wins_after_concurrent_writes(tmp_path: Path) -> None:
    path = tmp_path / "f.json"
    writer = SerialWriter(path)
    await asyncio.gather(*(writer.write({"n": n}) for n in range(20)))
    await writer.flush()
    assert path.read_text() == '{"n":19}'
    assert [p.name for p in tmp_path.iterdir()] == ["f.json"]


async def test_payload_is_snapshotted_at_write_time(tmp_path: Path) -> None:
    path = tmp_path / "f.json"
    payload: dict[str, int] = {"n": 1}
    task = asyncio.create_task(SerialWriter(path).write(payload))
    await asyncio.sleep(0)
    payload["n"] = 2
    await task
    assert path.read_text() == '{"n":1}'


async def test_failed_write_is_retried_by_flush(tmp_path: Path) -> None:
    blocker = tmp_path / "blocker"
    blocker.write_text("file")
    writer = SerialWriter(blocker / "f.json")
    with pytest.raises(OSError):
        await writer.write({"a": 1})
    blocker.unlink()
    await writer.flush()
    assert (tmp_path / "blocker" / "f.json").read_text() == '{"a":1}'


async def test_a_cancelled_write_still_running_never_overwrites_a_newer_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading

    from tokengrill.storage import atomic_json

    real_write = atomic_json._write_atomic
    started = threading.Event()
    release = threading.Event()

    def slow_first(path: Path, text: str) -> None:
        if text == '{"n":1}':
            started.set()
            release.wait(5)
        real_write(path, text)

    monkeypatch.setattr(atomic_json, "_write_atomic", slow_first)
    target = tmp_path / "state.json"
    writer = SerialWriter(target)
    first = asyncio.create_task(writer.write({"n": 1}))
    await asyncio.to_thread(started.wait, 5)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(writer.write({"n": 2}))
    await asyncio.sleep(0.05)
    release.set()
    await second
    # The first thread may still be finishing; wait until it has given up the file.
    await asyncio.to_thread(writer._thread_lock.acquire)
    writer._thread_lock.release()
    assert target.read_text() == '{"n":2}'
