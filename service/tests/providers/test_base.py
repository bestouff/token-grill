import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from tokengrill.core.errors import ServiceError
from tokengrill.core.types import (
    ProviderInstance,
    ProviderSnapshot,
    RefreshPhase,
    RefreshSource,
    SourceResult,
    TokenTotals,
    empty_snapshot,
)
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import CollectorContext, LimitsUpdate, collect_history, collect_limits
from tokengrill.providers.registry import create_collectors
from tokengrill.storage.aggregate import AggregateStore, UsageEvent
from tokengrill.storage.checkpoints import CheckpointStore


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


class Recorder:
    def __init__(self) -> None:
        self.phases: list[RefreshPhase] = []
        self.sources: list[tuple[RefreshSource, SourceResult]] = []
        self.records: list[tuple[str, str]] = []


def make_context(tmp_path: Path, recorder: Recorder) -> CollectorContext:
    return CollectorContext(
        http=HttpClient(),
        pricing={"m": {"input": 1.0, "output": 1.0}},
        aggregates=AggregateStore(tmp_path / "agg.json"),
        checkpoints=CheckpointStore(tmp_path / "cp.json"),
        on_phase=recorder.phases.append,
        on_source=lambda source, result: recorder.sources.append((source, result)),
        on_record=lambda step, detail: recorder.records.append((step, detail)),
    )


def test_registry_holds_only_ported_collectors() -> None:
    assert set(create_collectors()) == {
        "antigravity",
        "claude",
        "codex",
        "copilot",
        "deepseek",
        "kimi",
        "kiro",
        "opencode-go",
    }


async def test_limits_success_merges_the_update(tmp_path: Path) -> None:
    recorder = Recorder()
    ctx = make_context(tmp_path, recorder)

    async def fetch() -> LimitsUpdate:
        return {"plan": "Pro", "account": "a@b"}

    result = await collect_limits(ctx, empty_snapshot("x"), fetch)
    assert result["state"] == "ready"
    assert result["plan"] == "Pro"
    assert result["errorInfo"] is None
    assert result["lastUpdated"] == result["quotaFetchedAt"]
    assert recorder.sources == [("limits", "success")]
    ctx.record("limits", "ok")
    assert recorder.records == [("limits", "ok")]


async def test_limits_failure_is_an_error_snapshot_then_stale(tmp_path: Path) -> None:
    recorder = Recorder()
    ctx = make_context(tmp_path, recorder)

    async def fetch() -> LimitsUpdate:
        raise ServiceError("offline", "net.offline")

    first = await collect_limits(ctx, empty_snapshot("x"), fetch)
    assert first["state"] == "error"
    assert first["errorInfo"] is not None
    assert first["errorInfo"]["messageId"] == "net.offline"
    ready: ProviderSnapshot = {**empty_snapshot("x"), "state": "ready", "lastUpdated": 5, "plan": "Pro"}
    second = await collect_limits(ctx, ready, fetch)
    assert second["state"] == "stale"
    assert second["plan"] == "Pro"
    assert recorder.sources == [("limits", "failed"), ("limits", "failed")]


async def test_limits_bug_propagates(tmp_path: Path) -> None:
    ctx = make_context(tmp_path, Recorder())

    async def fetch() -> LimitsUpdate:
        raise RuntimeError("bug")

    with pytest.raises(RuntimeError):
        await collect_limits(ctx, empty_snapshot("x"), fetch)


def _parse(line: str) -> UsageEvent | None:
    tokens = json.loads(line)["tokens"]
    now = int(datetime.now(UTC).timestamp() * 1000)
    totals: TokenTotals = {
        "input": tokens,
        "output": 0,
        "cachedInput": 0,
        "cacheWrite": 0,
        "reasoning": 0,
        "total": tokens,
    }
    return {"capturedAt": now, "model": "m", "totals": totals}


async def test_history_fills_totals_and_cost(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    (sessions / "a.jsonl").write_text('{"tokens": 1000000}\n')
    recorder = Recorder()
    ctx = make_context(tmp_path, recorder)
    result = await collect_history(ctx, make_instance(tmp_path), empty_snapshot("acct"), _parse)
    assert result["totals"]["total"] == 1_000_000
    assert result["todayTotals"]["total"] == 1_000_000
    assert result["monthTotals"]["total"] == 1_000_000
    assert result["todayCost"] == 1.0
    assert result["monthCost"] == 1.0
    assert result["localHistoryUpdatedAt"] is not None
    assert recorder.phases == ["scanning-history"]
    assert recorder.sources == [("history", "success")]
    assert (tmp_path / "agg.json").exists()
    assert (tmp_path / "cp.json").exists()


async def test_history_failure_maps_to_local_history_error(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    (sessions / "a.jsonl").write_text('{"tokens": 1}\n')
    recorder = Recorder()
    ctx = make_context(tmp_path, recorder)

    def bad_parse(line: str) -> UsageEvent | None:
        raise OSError("disk")

    result = await collect_history(ctx, make_instance(tmp_path), empty_snapshot("acct"), bad_parse)
    assert result["state"] == "error"
    assert result["errorInfo"] is not None
    assert (result["errorInfo"]["code"], result["errorInfo"]["messageId"]) == ("local-history", "history.update-failed")
    assert recorder.sources == [("history", "failed")]


async def test_history_bug_propagates(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    (sessions / "a.jsonl").write_text('{"tokens": 1}\n')
    ctx = make_context(tmp_path, Recorder())

    def buggy(line: str) -> UsageEvent | None:
        raise KeyError("bug")

    with pytest.raises(KeyError):
        await collect_history(ctx, make_instance(tmp_path), empty_snapshot("acct"), buggy)


async def test_history_is_skipped_without_a_shell_client(tmp_path: Path) -> None:
    sessions = tmp_path / "sessions"
    sessions.mkdir()
    (sessions / "a.jsonl").write_text('{"tokens": 1000000}\n')
    recorder = Recorder()
    ctx = make_context(tmp_path, recorder)
    ctx.history_enabled = False
    snapshot = empty_snapshot("acct")
    result = await collect_history(ctx, make_instance(tmp_path), snapshot, _parse)
    assert result == snapshot
    assert recorder.phases == []
    assert recorder.sources == []
    assert not (tmp_path / "agg.json").exists()
    assert not (tmp_path / "cp.json").exists()
