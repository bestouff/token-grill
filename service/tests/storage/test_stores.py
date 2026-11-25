import logging
import shutil
import stat
from pathlib import Path

import pytest

from tokengrill.core.types import ProviderSnapshot, TokenTotals, UsageWindow
from tokengrill.storage.aggregate import AggregateStore
from tokengrill.storage.alerts import AlertStateStore, WindowState
from tokengrill.storage.balances import BalanceStore
from tokengrill.storage.checkpoints import CheckpointStore, FileCheckpoint
from tokengrill.storage.diagnostics import DiagnosticEntry, DiagnosticsStore, read_diagnostics
from tokengrill.storage.readings import ReadingStore

FIXTURES = Path(__file__).parent / "fixtures"
ENTRY: DiagnosticEntry = {
    "at": 1,
    "account": "codex-0",
    "kind": "codex",
    "app": "codex-cli",
    "step": "error",
    "detail": "",
}


def fixture_copy(tmp_path: Path, name: str) -> Path:
    target = tmp_path / "state" / name
    target.parent.mkdir()
    shutil.copy(FIXTURES / name, target)
    return target


async def test_aggregate_round_trip_is_byte_identical(tmp_path: Path) -> None:
    path = fixture_copy(tmp_path, "history-v1.json")
    store = AggregateStore(path)
    await store.load()
    await store.remove_provider("nobody")
    assert path.read_bytes() == (FIXTURES / "history-v1.json").read_bytes()


async def test_checkpoints_round_trip_is_byte_identical(tmp_path: Path) -> None:
    path = fixture_copy(tmp_path, "checkpoints-v1.json")
    store = CheckpointStore(path)
    await store.load()
    await store.remove_provider("nobody")
    assert path.read_bytes() == (FIXTURES / "checkpoints-v1.json").read_bytes()


async def test_balances_round_trip_is_byte_identical(tmp_path: Path) -> None:
    path = fixture_copy(tmp_path, "balances-v1.json")
    store = BalanceStore(path)
    await store.load()
    await store.remove_provider("nobody")
    assert path.read_bytes() == (FIXTURES / "balances-v1.json").read_bytes()


async def test_readings_round_trip_is_byte_identical(tmp_path: Path) -> None:
    path = fixture_copy(tmp_path, "readings-v1.json")
    store = ReadingStore(path)
    await store.load()
    await store.remove_provider("nobody")
    assert path.read_bytes() == (FIXTURES / "readings-v1.json").read_bytes()


async def test_diagnostics_round_trip_is_byte_identical(tmp_path: Path) -> None:
    path = fixture_copy(tmp_path, "diagnostics-v1.json")
    store = DiagnosticsStore(path, "/home/example", {"version": "0.4.1", "shell": "48.2"})
    await store.load()
    await store.flush()
    assert path.read_bytes() == (FIXTURES / "diagnostics-v1.json").read_bytes()


async def test_alerts_round_trip_is_byte_identical(tmp_path: Path) -> None:
    path = fixture_copy(tmp_path, "notifications-v1.json")
    store = AlertStateStore(path)
    await store.load()
    await store.remove_provider("nobody")
    assert path.read_bytes() == (FIXTURES / "notifications-v1.json").read_bytes()


async def test_stores_write_private_files_into_new_folders(tmp_path: Path) -> None:
    path = tmp_path / "fresh" / "checkpoints-v1.json"
    store = CheckpointStore(path)
    await store.load()
    store.set({"providerId": "a", "path": "/x", "size": 1, "mtime": 2, "offset": 3, "parserVersion": 4})
    await store.flush()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700


@pytest.mark.parametrize(
    "make",
    [
        lambda p: AggregateStore(p),
        lambda p: CheckpointStore(p),
        lambda p: BalanceStore(p),
        lambda p: ReadingStore(p),
        lambda p: DiagnosticsStore(p, "/h", {"version": "1", "shell": "48"}),
        lambda p: AlertStateStore(p),
    ],
)
async def test_corrupt_file_is_kept_and_store_starts_empty(
    tmp_path: Path, make: object, caplog: pytest.LogCaptureFixture
) -> None:
    path = tmp_path / "state.json"
    path.write_text("{broken")
    store = make(path)  # type: ignore[operator]
    with caplog.at_level(logging.WARNING):
        await store.load()
    assert path.read_text() == "{broken"
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 1


async def test_aggregate_adds_and_sums(tmp_path: Path) -> None:
    path = tmp_path / "h.json"
    store = AggregateStore(path)
    await store.load()
    day1 = 1746057600000  # 2025-05-01T00:00:00Z
    totals: TokenTotals = {"input": 1, "output": 2, "cachedInput": 3, "cacheWrite": 4, "reasoning": 5, "total": 6}
    store.add("a", {"capturedAt": day1 + 5000, "model": None, "totals": totals})
    store.add("a", {"capturedAt": day1 + 9000, "model": None, "totals": totals})
    store.add("a", {"capturedAt": day1 + 86400000, "model": "m", "totals": totals})
    assert store.totals("a", day1)["total"] == 18
    assert store.totals("a", day1 + 86400000)["total"] == 6
    assert store.totals("b", 0)["total"] == 0
    await store.flush()
    text = path.read_text()
    assert text.startswith(
        '{"schemaVersion":1,"buckets":[{"providerId":"a","date":"2025-05-01","model":"unknown","totals":{"input":2,'
    )
    other = AggregateStore(path)
    await other.load()
    assert other.totals("a", 0)["total"] == 18


async def test_aggregate_ignores_damaged_buckets(tmp_path: Path) -> None:
    path = tmp_path / "h.json"
    path.write_text('{"schemaVersion":1,"buckets":[null,{"providerId":"a"},5]}')
    store = AggregateStore(path)
    await store.load()
    assert store.totals("a", 0)["total"] == 0


async def test_checkpoints_get_set_remove(tmp_path: Path) -> None:
    store = CheckpointStore(tmp_path / "c.json")
    await store.load()
    assert store.get("a", "/p") is None
    checkpoint: FileCheckpoint = {
        "providerId": "a",
        "path": "/p",
        "size": 1,
        "mtime": 2,
        "offset": 3,
        "parserVersion": 4,
    }
    store.set(checkpoint)
    assert store.get("a", "/p") == checkpoint
    await store.remove_provider("a")
    assert store.get("a", "/p") is None


async def test_balances_drop_invalid_references(tmp_path: Path) -> None:
    path = tmp_path / "b.json"
    path.write_text('{"schemaVersion":1,"accounts":{"ok":{"currency":"USD","full":1,"last":1},"bad":{"currency":1}}}')
    store = BalanceStore(path)
    await store.load()
    assert store.get("ok") == {"currency": "USD", "full": 1, "last": 1}
    assert store.get("bad") is None


async def test_readings_set_strips_name_and_pace_and_removes_cleared(tmp_path: Path) -> None:
    path = tmp_path / "r.json"
    store = ReadingStore(path)
    await store.load()
    window: UsageWindow = {
        "id": "five-hour",
        "canonicalWindow": "five-hour",
        "label": "5h",
        "used": None,
        "limit": None,
        "percent": 0.5,
        "resetAt": None,
        "durationSeconds": 18000,
        "unit": None,
        "pace": {"state": "high", "runsOutAt": None},
    }
    snapshot: ProviderSnapshot = {  # type: ignore[typeddict-item]
        "providerId": "a",
        "state": "ready",
        "lastUpdated": 5,
        "errorInfo": None,
        "plan": "pro",
        "account": "me@example.com",
        "windows": [window],
        "balance": None,
        "quotaFetchedAt": 7,
        "resetCredits": None,
    }
    store.set(snapshot)
    await store.flush()
    text = path.read_text()
    assert "example.com" not in text
    assert "pace" not in text
    assert text == (
        '{"schemaVersion":1,"accounts":{"a":{"plan":"pro","windows":[{"id":"five-hour","canonicalWindow":"five-hour",'
        '"label":"5h","used":null,"limit":null,"percent":0.5,"resetAt":null,"durationSeconds":18000,"unit":null}],'
        '"balance":null,"resetCredits":null,"fetchedAt":7}}}'
    )
    assert store.get("a") is not None
    store.set({**snapshot, "quotaFetchedAt": None})
    assert store.get("a") is None


async def test_readings_drop_damaged_entry_as_a_whole(tmp_path: Path) -> None:
    path = tmp_path / "r.json"
    path.write_text(
        '{"schemaVersion":1,"accounts":{"a":{"plan":null,"windows":[{"id":1}],"balance":null,"resetCredits":null,'
        '"fetchedAt":1}}}'
    )
    store = ReadingStore(path)
    await store.load()
    assert store.get("a") is None


async def test_diagnostics_record_redacts_and_caps(tmp_path: Path) -> None:
    path = tmp_path / "d.json"
    store = DiagnosticsStore(path, "/home/example", {"version": "1", "shell": "48"})
    await store.load()
    kept = store.record({**ENTRY, "detail": "/home/example/x me@example.com"})
    assert kept["detail"] == "~/x <email>"
    for index in range(250):
        store.record({**ENTRY, "at": index})
    await store.flush()
    diagnostics = read_diagnostics(path)
    assert len(diagnostics["entries"]) == 200
    assert diagnostics["about"] == {"version": "1", "shell": "48"}
    assert diagnostics["entries"][-1]["at"] == 249


async def test_diagnostics_load_keeps_older_entries_and_marks_dirty(tmp_path: Path) -> None:
    path = fixture_copy(tmp_path, "diagnostics-v1.json")
    store = DiagnosticsStore(path, "/h", {"version": "0.5.0", "shell": "49"})
    await store.load()
    await store.flush()
    diagnostics = read_diagnostics(path)
    assert diagnostics["about"] == {"version": "0.5.0", "shell": "49"}
    assert len(diagnostics["entries"]) == 2


def test_read_diagnostics_missing_file(tmp_path: Path) -> None:
    assert read_diagnostics(tmp_path / "none.json") == {"about": None, "entries": []}


async def test_alerts_migrate_legacy_keys(tmp_path: Path) -> None:
    path = tmp_path / "n.json"
    path.write_text(
        '{"schemaVersion":2,"windows":{"a:selected-limit":{"providerId":"a","resetIdentity":"weekly:1746120000400",'
        '"lastNotifiedBucket":1,"configuredStep":10},"bad":{"x":1}},"lowBalance":{"a":true,"b":"no"}}'
    )
    store = AlertStateStore(path)
    await store.load()
    assert store.window("a:weekly") == {
        "providerId": "a",
        "resetIdentity": "weekly:1746120000000",
        "lastNotifiedBucket": 1,
        "configuredStep": 10,
    }
    assert store.window("bad") is None
    assert store.low_balance("a") is True
    assert store.low_balance("b") is None


async def test_alerts_ignore_other_schema_versions(tmp_path: Path) -> None:
    path = tmp_path / "n.json"
    path.write_text('{"schemaVersion":1,"windows":{"a:w":{"resetIdentity":"x"}}}')
    store = AlertStateStore(path)
    await store.load()
    assert store.window("a:w") is None


async def test_alerts_set_and_remove_persist(tmp_path: Path) -> None:
    path = tmp_path / "n.json"
    store = AlertStateStore(path)
    await store.load()
    state: WindowState = {"providerId": "a", "resetIdentity": "w:unknown", "lastNotifiedBucket": 0, "configuredStep": 5}
    store.set_window("a:w", state)
    store.set_low_balance("a", False)
    await store.flush()
    assert path.read_text() == (
        '{"schemaVersion":2,"windows":{"a:w":{"providerId":"a","resetIdentity":"w:unknown","lastNotifiedBucket":0,'
        '"configuredStep":5}},"lowBalance":{"a":false}}'
    )
    await store.remove_provider("a")
    assert path.read_text() == '{"schemaVersion":2,"windows":{},"lowBalance":{}}'
