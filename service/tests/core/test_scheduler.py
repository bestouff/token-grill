import asyncio
import random

import pytest

import tokengrill.core.scheduler as scheduler_module
from tokengrill.core.config import new_provider
from tokengrill.core.scheduler import WAKE_SECONDS, Scheduler, SchedulerJob
from tokengrill.core.types import ProviderInstance


def provider(provider_id: str, enabled: bool = True) -> ProviderInstance:
    return {**new_provider("codex", "codex-cli", "~/.codex"), "id": provider_id, "enabled": enabled}


class Harness:
    def __init__(self, interval: int = 300) -> None:
        self.now = 1000.0
        self.calls: list[list[SchedulerJob]] = []
        self.scheduler = Scheduler(self.callback, interval, clock=lambda: self.now, rng=random.Random(7))

    async def callback(self, jobs: list[SchedulerJob]) -> None:
        self.calls.append(jobs)

    def ids(self, index: int = -1) -> list[str]:
        return [job["provider"]["id"] for job in self.calls[index]]


def test_wake_seconds_is_fifteen() -> None:
    assert WAKE_SECONDS == 15


async def test_new_provider_is_spread_within_interval() -> None:
    h = Harness(300)
    start = h.now
    h.scheduler.set_providers([provider(str(i)) for i in range(20)])
    dues = list(h.scheduler._due.values())
    assert all(start <= due < start + 300 for due in dues)
    assert max(dues) - min(dues) > 100
    await h.scheduler._tick()
    assert h.calls == []
    for _ in range(20):
        h.now += 15
        await h.scheduler._tick()
    batches = [[job["provider"]["id"] for job in call] for call in h.calls]
    assert len(batches) > 1
    assert sorted((i for batch in batches for i in batch), key=int) == [str(i) for i in range(20)]
    assert all(not job["manual"] for call in h.calls for job in call)


async def test_due_provider_is_collected_on_tick() -> None:
    h = Harness(300)
    h.scheduler.set_providers([provider("a")])
    h.now += 301
    await h.scheduler._tick()
    assert h.ids() == ["a"]
    await h.scheduler._tick()
    assert len(h.calls) == 1
    h.now += 299
    await h.scheduler._tick()
    assert len(h.calls) == 1
    h.now += 2
    await h.scheduler._tick()
    assert len(h.calls) == 2


async def test_disabled_providers_are_not_scheduled_and_removed_ones_are_dropped() -> None:
    h = Harness(300)
    h.scheduler.set_providers([provider("off", False), provider("gone")])
    h.scheduler.set_providers([provider("off", False)])
    h.now += 1000
    await h.scheduler._tick()
    assert h.calls == []
    h.scheduler.set_providers([provider("off", True)])
    await h.scheduler._tick()
    assert h.ids() == ["off"]


async def test_paused_skips_timer_but_not_requests() -> None:
    h = Harness(300)
    h.scheduler.set_providers([provider("a")])
    h.scheduler.set_paused(True)
    assert h.scheduler.paused
    h.now += 1000
    await h.scheduler._tick()
    assert h.calls == []
    assert h.scheduler.request(["a"]) is False
    h.scheduler.set_paused(False)
    await h.scheduler._tick()
    assert h.ids() == ["a"]
    assert h.calls[0][0]["manual"] is False


async def test_request_marks_manual_and_runs_immediately_on_the_loop() -> None:
    h = Harness(3600)
    h.scheduler.set_providers([provider("a"), provider("b")])
    h.scheduler.start()
    try:
        assert h.scheduler.request(["a"]) is True
        for _ in range(20):
            await asyncio.sleep(0)
        assert h.ids() == ["a"]
        assert h.calls[0][0]["manual"] is True
    finally:
        h.scheduler.stop()


async def test_interval_change_reschedules() -> None:
    h = Harness(300)
    h.scheduler.set_providers([provider("a")])
    h.now += 301
    await h.scheduler._tick()
    h.scheduler.set_interval(60)
    h.scheduler.request(["a"])
    await h.scheduler._tick()
    assert len(h.calls) == 2
    h.now += 59
    await h.scheduler._tick()
    assert len(h.calls) == 2
    h.now += 2
    await h.scheduler._tick()
    assert len(h.calls) == 3


async def test_callback_error_does_not_stop_the_scheduler() -> None:
    calls: list[int] = []

    async def callback(jobs: list[SchedulerJob]) -> None:
        calls.append(len(jobs))
        raise RuntimeError("boom")

    now = [0.0]
    s = Scheduler(callback, 60, clock=lambda: now[0], rng=random.Random(1))
    s.set_providers([provider("a")])
    now[0] += 61
    await s._tick()
    now[0] += 61
    await s._tick()
    assert calls == [1, 1]


async def test_stop_cancels_tick() -> None:
    h = Harness(60)
    h.scheduler.start()
    task = h.scheduler._task
    assert task is not None
    await asyncio.sleep(0)
    h.scheduler.stop()
    assert h.scheduler._task is None
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 2)
    assert task.cancelled()


class Gate:
    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.active = 0
        self.max_active = 0
        self.batches: list[list[str]] = []

    async def callback(self, jobs: list[SchedulerJob]) -> None:
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.batches.append([job["provider"]["id"] for job in jobs])
        self.entered.set()
        try:
            await self.release.wait()
        finally:
            self.active -= 1


async def test_request_during_running_callback_is_collected_afterwards() -> None:
    gate = Gate()
    now = [0.0]
    s = Scheduler(gate.callback, 3600, clock=lambda: now[0], rng=random.Random(1))
    s.set_providers([provider("a")])
    s.request(["a"])
    task = asyncio.create_task(s._tick())
    try:
        await asyncio.wait_for(gate.entered.wait(), 2)
        s.request(["a"])
        gate.release.set()
        await asyncio.wait_for(task, 2)
    finally:
        gate.release.set()
        task.cancel()
        s.stop()
    assert gate.batches == [["a"], ["a"]]
    assert gate.max_active == 1


async def test_callbacks_never_overlap() -> None:
    gate = Gate()
    now = [0.0]
    s = Scheduler(gate.callback, 3600, clock=lambda: now[0], rng=random.Random(1))
    s.set_providers([provider("a"), provider("b")])
    s.start()
    try:
        s.request(["a"])
        await asyncio.wait_for(gate.entered.wait(), 2)
        s.request(["b"])
        await s._tick()
        for _ in range(20):
            await asyncio.sleep(0)
        assert gate.batches == [["a"]]
        assert gate.max_active == 1
        gate.release.set()
        for _ in range(50):
            await asyncio.sleep(0)
        assert gate.batches == [["a"], ["b"]]
        assert gate.max_active == 1
    finally:
        s.stop()


async def test_loop_survives_a_callback_exception() -> None:
    calls: list[int] = []
    done = asyncio.Event()

    async def callback(jobs: list[SchedulerJob]) -> None:
        calls.append(len(jobs))
        if len(calls) == 1:
            raise RuntimeError("boom")
        done.set()

    s = Scheduler(callback, 3600, clock=lambda: 0.0, rng=random.Random(1))
    s.set_providers([provider("a")])
    s.start()
    task = s._task
    assert task is not None
    try:
        s.request(["a"])
        for _ in range(20):
            await asyncio.sleep(0)
        assert calls == [1]
        assert not task.done()
        s.request(["a"])
        await asyncio.wait_for(done.wait(), 2)
        assert calls == [1, 1]
        assert not task.done()
    finally:
        s.stop()


async def test_timer_wake_collects_due_provider_without_request(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(scheduler_module, "WAKE_SECONDS", 0.01)
    now = [0.0]
    got = asyncio.Event()
    batches: list[list[SchedulerJob]] = []

    async def callback(jobs: list[SchedulerJob]) -> None:
        batches.append(jobs)
        got.set()

    s = Scheduler(callback, 60, clock=lambda: now[0], rng=random.Random(1))
    s.set_providers([provider("a")])
    s.start()
    try:
        await asyncio.sleep(0)
        assert batches == []
        now[0] += 61
        await asyncio.wait_for(got.wait(), 2)
        assert batches[0][0]["manual"] is False
    finally:
        s.stop()
