import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from tokengrill.core.types import ProviderInstance, TokenTotals
from tokengrill.providers.history import PARSER_VERSION, scan_history
from tokengrill.storage.aggregate import AggregateStore, UsageEvent
from tokengrill.storage.checkpoints import CheckpointStore

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
