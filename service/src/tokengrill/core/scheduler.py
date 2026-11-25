import asyncio
import contextlib
import logging
import random
import time
from collections.abc import Awaitable, Callable
from typing import TypedDict

from tokengrill.core.types import ProviderInstance

WAKE_SECONDS = 15

_log = logging.getLogger(__name__)


class SchedulerJob(TypedDict):
    provider: ProviderInstance
    manual: bool


class Scheduler:
    """Hands due accounts to the callback, one batch at a time.

    Providers are spread over the interval on first sight so accounts sharing a
    service do not all hit it in the same second.
    """

    def __init__(
        self,
        callback: Callable[[list[SchedulerJob]], Awaitable[None]],
        interval_seconds: int,
        clock: Callable[[], float] = time.monotonic,
        rng: random.Random | None = None,
    ) -> None:
        self._callback = callback
        self._interval = interval_seconds
        self._clock = clock
        self._rng = rng or random.Random()
        self._task: asyncio.Task[None] | None = None
        self._wake: asyncio.Event | None = None
        self._running = False
        self._paused = False
        self._providers: list[ProviderInstance] = []
        self._due: dict[str, float] = {}
        self._manual: set[str] = set()

    @property
    def paused(self) -> bool:
        return self._paused

    def start(self) -> None:
        if self._task is not None:
            self._task.cancel()
        self._wake = asyncio.Event()
        self._task = asyncio.get_running_loop().create_task(self._loop(self._wake))

    def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
        self._task = None
        self._wake = None
        self._due.clear()
        self._manual.clear()
        self._providers = []

    def set_interval(self, seconds: int) -> None:
        self._interval = seconds

    def set_providers(self, providers: list[ProviderInstance]) -> None:
        self._providers = providers
        ids = {provider["id"] for provider in providers}
        for gone in [key for key in self._due if key not in ids]:
            del self._due[gone]
        self._manual &= ids
        now = self._clock()
        for provider in providers:
            if provider["id"] not in self._due:
                self._due[provider["id"]] = now + self._rng.random() * self._interval

    def set_paused(self, paused: bool) -> None:
        self._paused = paused

    def request(self, ids: list[str]) -> bool:
        """Queue accounts for an immediate refresh; False while paused."""
        if self._paused:
            return False
        now = self._clock()
        for provider_id in ids:
            self._manual.add(provider_id)
            self._due[provider_id] = now
        if self._wake is not None:
            self._wake.set()
        return True

    async def _loop(self, wake: asyncio.Event) -> None:
        while True:
            await self._tick()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(wake.wait(), WAKE_SECONDS)
            wake.clear()

    async def _tick(self) -> None:
        # Jobs queued while the callback runs are picked up by the next pass.
        while not (self._running or self._paused):
            now = self._clock()
            jobs: list[SchedulerJob] = []
            for provider in self._providers:
                if not provider["enabled"] or self._due.get(provider["id"], float("inf")) > now:
                    continue
                manual = provider["id"] in self._manual
                self._manual.discard(provider["id"])
                jobs.append({"provider": provider, "manual": manual})
                self._due[provider["id"]] = now + self._interval
            if not jobs:
                return
            self._running = True
            try:
                await self._callback(jobs)
            except Exception:  # noqa: BLE001 - a failing callback must not end the loop
                _log.exception("scheduler callback failed")
            finally:
                self._running = False
