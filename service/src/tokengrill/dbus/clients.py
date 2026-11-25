"""Which bus clients keep the service alive, tracked by their unique bus names."""

import asyncio
from collections.abc import Callable
from typing import Literal

ClientKind = Literal["shell", "prefs", "cli"]
CLIENT_KINDS: tuple[ClientKind, ...] = ("shell", "prefs", "cli")


class ClientTracker:
    """Calls on_shell when the first shell client arrives or the last leaves, and on_idle after idle_seconds
    without a shell or prefs client. A cli client only gets its call answered; it never keeps the service alive."""

    def __init__(self, on_shell: Callable[[bool], None], on_idle: Callable[[], None], idle_seconds: float = 60) -> None:
        self._on_shell = on_shell
        self._on_idle = on_idle
        self._idle_seconds = idle_seconds
        self._kinds: dict[str, ClientKind] = {}
        self._timer: asyncio.TimerHandle | None = None
        self._shell = False
        self._calls = 0

    @property
    def has_shell(self) -> bool:
        return self._shell

    def start(self) -> None:
        """A service that was activated by a cli call alone still exits after the idle time."""
        self._update()

    def add(self, sender: str, kind: ClientKind) -> None:
        self._kinds[sender] = kind
        self._update()

    def remove(self, sender: str) -> None:
        if self._kinds.pop(sender, None) is not None:
            self._update()

    def call_started(self) -> None:
        self._calls += 1
        self._update()

    def call_finished(self) -> None:
        self._calls -= 1
        self._update()

    def close(self) -> None:
        self._cancel_timer()

    def _update(self) -> None:
        kinds = self._kinds.values()
        shell = "shell" in kinds
        if shell != self._shell:
            self._shell = shell
            self._on_shell(shell)
        # A cli client keeps the service alive only while its call runs.
        if self._calls > 0 or any(kind != "cli" for kind in kinds):
            self._cancel_timer()
        elif self._timer is None:
            self._timer = asyncio.get_running_loop().call_later(self._idle_seconds, self._on_idle)

    def _cancel_timer(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
