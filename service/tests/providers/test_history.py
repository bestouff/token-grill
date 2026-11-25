import asyncio
import errno
import json
import os
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

import pytest

from tokengrill.core.types import ProviderInstance, TokenTotals
from tokengrill.providers.history import PARSER_VERSION, scan_history
from tokengrill.storage.aggregate import AggregateStore, UsageEvent
from tokengrill.storage.checkpoints import CheckpointStore
from tokengrill.storage.jsonl import scan_jsonl

DAY_MS = int(datetime(2026, 8, 7, tzinfo=UTC).timestamp() * 1000)


def parse(line: str) -> UsageEvent | None:
    try:
        record = json.loads(line)
    except ValueError:
        return None
    tokens = record.get("tokens")
    if not isinstance(tokens, int) or tokens == 0:
        return None
    totals: TokenTotals = {
        "input": tokens,
        "output": 0,
        "cachedInput": 0,
        "cacheWrite": 0,
        "reasoning": 0,
        "total": tokens,
    }
    return {"capturedAt": DAY_MS, "model": "m", "totals": totals}


def make_instance(home: Path) -> ProviderInstance:
    return {
        "schemaVersion": 2,
        "id": "acct",
        "kind": "codex",
        "app": "codex-cli",
        "displayName": "x",
        "accent": "green",
        "enabled": True,
        "sortOrder": 0,
        "accountHome": str(home),
        "authFileOverride": None,
        "sessionsDirectoryOverride": None,
        "liveUsageEnabled": True,
        "localHistoryEnabled": True,
        "topBar": {"automatic": True, "limits": []},
        "lowBalance": None,
        "showPace": True,
    }


def test_parser_version_is_the_0_4_1_value() -> None:
    assert PARSER_VERSION == 1


async def test_scan_counts_each_line_once_across_passes(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions" / "2026" / "08"
    sessions.mkdir(parents=True)
    log = sessions / "a.jsonl"
    log.write_text('{"tokens": 5}\nnot json\n{"tokens": 0}\n')
    (sessions / "ignored.txt").write_text('{"tokens": 100}\n')
    instance = make_instance(tmp_path)
    aggregates = AggregateStore(tmp_path / "agg.json")
    checkpoints = CheckpointStore(tmp_path / "cp.json")
    await scan_history(instance, parse, aggregates, checkpoints)
    assert aggregates.totals("acct", 0)["total"] == 5
    await scan_history(instance, parse, aggregates, checkpoints)
    assert aggregates.totals("acct", 0)["total"] == 5
    with log.open("a") as handle:
        handle.write('{"tokens": 7}\n{"tokens": 9')
    await scan_history(instance, parse, aggregates, checkpoints)
    assert aggregates.totals("acct", 0)["total"] == 12
    checkpoint = checkpoints.get("acct", str(log))
    assert checkpoint is not None
    assert checkpoint["parserVersion"] == PARSER_VERSION
    assert checkpoint["offset"] == len('{"tokens": 5}\nnot json\n{"tokens": 0}\n{"tokens": 7}\n')


async def test_scan_rereads_when_the_parser_version_differs_or_file_shrank(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    log = sessions / "a.jsonl"
    log.write_text('{"tokens": 5}\n')
    instance = make_instance(tmp_path)
    aggregates = AggregateStore(tmp_path / "agg.json")
    checkpoints = CheckpointStore(tmp_path / "cp.json")
    await scan_history(instance, parse, aggregates, checkpoints)
    stale = checkpoints.get("acct", str(log))
    assert stale is not None
    checkpoints.set({**stale, "parserVersion": PARSER_VERSION + 1})
    await scan_history(instance, parse, aggregates, checkpoints)
    assert aggregates.totals("acct", 0)["total"] == 10


async def test_scan_skips_old_files_and_missing_directories(tmp_path: Path) -> None:
    instance = make_instance(tmp_path)
    aggregates = AggregateStore(tmp_path / "agg.json")
    checkpoints = CheckpointStore(tmp_path / "cp.json")
    await scan_history(instance, parse, aggregates, checkpoints)
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    old = sessions / "old.jsonl"
    old.write_text('{"tokens": 5}\n')
    long_ago = datetime.now(UTC).timestamp() - 100 * 86400
    os.utime(old, (long_ago, long_ago))
    await scan_history(instance, parse, aggregates, checkpoints)
    assert aggregates.totals("acct", 0)["total"] == 0


async def test_scan_reports_unreadable_directories(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    sessions.chmod(0)
    if os.access(sessions, os.R_OK):
        pytest.skip("permissions are not enforced for this user")
    try:
        with pytest.raises(PermissionError):
            await scan_history(
                make_instance(tmp_path),
                parse,
                AggregateStore(tmp_path / "a.json"),
                CheckpointStore(tmp_path / "c.json"),
            )
    finally:
        sessions.chmod(0o700)


def write_log(home: Path, count: int) -> Path:
    sessions = home / "sessions"
    sessions.mkdir()
    log = sessions / "a.jsonl"
    log.write_text("".join(f'{{"tokens": {n}}}\n' for n in range(1, count + 1)))
    return log


async def full_scan_total(tmp_path: Path, count: int) -> int:
    home = tmp_path / "reference"
    home.mkdir()
    write_log(home, count)
    aggregates = AggregateStore(home / "agg.json")
    await scan_history(make_instance(home), parse, aggregates, CheckpointStore(home / "cp.json"))
    return aggregates.totals("acct", 0)["total"]


async def test_a_scan_cancelled_mid_file_adds_nothing_and_the_next_pass_counts_each_line_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Small reads, so the file takes many awaits and the cancellation lands inside it.
    monkeypatch.setattr("tokengrill.storage.jsonl.CHUNK_SIZE", 16)
    home = tmp_path / "home"
    home.mkdir()
    log = write_log(home, 40)
    instance = make_instance(home)
    aggregates = AggregateStore(home / "agg.json")
    checkpoints = CheckpointStore(home / "cp.json")
    first_line = asyncio.Event()

    def parse_and_signal(line: str) -> UsageEvent | None:
        first_line.set()
        return parse(line)

    scan = asyncio.create_task(scan_history(instance, parse_and_signal, aggregates, checkpoints))
    await first_line.wait()
    assert not scan.done()
    scan.cancel()
    with pytest.raises(asyncio.CancelledError):
        await scan
    assert aggregates.totals("acct", 0)["total"] == 0
    assert checkpoints.get("acct", str(log)) is None

    await scan_history(instance, parse, aggregates, checkpoints)
    assert aggregates.totals("acct", 0)["total"] == await full_scan_total(tmp_path, 40)


async def test_a_read_error_mid_file_adds_nothing_and_the_next_pass_counts_each_line_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    log = write_log(home, 40)
    instance = make_instance(home)
    aggregates = AggregateStore(home / "agg.json")
    checkpoints = CheckpointStore(home / "cp.json")

    async def fail_after_some_lines(
        path: Path, offset: int, on_line: Callable[[str], None], max_line_bytes: int
    ) -> int:
        def counted(line: str) -> None:
            on_line(line)
            if line == '{"tokens": 10}':
                raise OSError(errno.EIO, "Input/output error")

        return await scan_jsonl(path, offset, counted, max_line_bytes)

    monkeypatch.setattr("tokengrill.providers.history.scan_jsonl", fail_after_some_lines)
    with pytest.raises(OSError):
        await scan_history(instance, parse, aggregates, checkpoints)
    assert aggregates.totals("acct", 0)["total"] == 0
    assert checkpoints.get("acct", str(log)) is None

    monkeypatch.setattr("tokengrill.providers.history.scan_jsonl", scan_jsonl)
    await scan_history(instance, parse, aggregates, checkpoints)
    assert aggregates.totals("acct", 0)["total"] == await full_scan_total(tmp_path, 40)


async def test_a_folder_link_loop_is_listed_once(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions" / "2026"
    sessions.mkdir(parents=True)
    (sessions / "a.jsonl").write_text('{"tokens": 5}\n')
    (sessions / "loop").symlink_to(tmp_path / "sessions")
    aggregates = AggregateStore(tmp_path / "agg.json")
    await scan_history(make_instance(tmp_path), parse, aggregates, CheckpointStore(tmp_path / "cp.json"))
    assert aggregates.totals("acct", 0)["total"] == 5
