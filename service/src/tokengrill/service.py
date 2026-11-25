"""Owns the bus name, runs the runtime and exits when nobody needs it."""

import asyncio
import signal
from typing import Final

from dbus_fast import Message, MessageType, NameFlag, RequestNameReply
from dbus_fast.aio import MessageBus

from tokengrill.core.config import ConfigStore
from tokengrill.core.paths import config_dir
from tokengrill.core.runtime import Runtime
from tokengrill.core.types import ProviderKind
from tokengrill.dbus.clients import CLIENT_KINDS, ClientKind, ClientTracker
from tokengrill.dbus.interface import INTERFACE_NAME, TokenGrillInterface
from tokengrill.net.http import HttpClient
from tokengrill.providers.base import Collector
from tokengrill.providers.registry import create_collectors

BUS_NAME: Final = "io.github.sh02sahil.TokenGrill"
OBJECT_PATH: Final = "/io/github/sh02sahil/TokenGrill"
_BUS_DAEMON: Final = "org.freedesktop.DBus"
_BUS_DAEMON_PATH: Final = "/org/freedesktop/DBus"
_NAME_OWNER_MATCH: Final = f"type='signal',sender='{_BUS_DAEMON}',interface='{_BUS_DAEMON}',member='NameOwnerChanged'"


def _client_kind(value: object) -> ClientKind | None:
    for kind in CLIENT_KINDS:
        if value == kind:
            return kind
    return None


async def _watch_client_names(bus: MessageBus, tracker: ClientTracker) -> None:
    """Hello callers are tracked by unique name; the daemon says when a name loses its owner."""

    def handle(message: Message) -> None:
        if message.message_type == MessageType.METHOD_CALL:
            is_hello = message.path == OBJECT_PATH and message.interface == INTERFACE_NAME and message.member == "Hello"
            if is_hello and message.sender:
                kind = _client_kind(message.body[0] if message.body else None)
                if kind:
                    tracker.add(message.sender, kind)
        elif (
            message.message_type == MessageType.SIGNAL
            and message.sender == _BUS_DAEMON
            and message.path == _BUS_DAEMON_PATH
            and message.interface == _BUS_DAEMON
            and message.member == "NameOwnerChanged"
        ):
            name, _old, new = message.body
            if not new:
                tracker.remove(name)

    bus.add_message_handler(handle)
    await bus.call(
        Message(
            destination=_BUS_DAEMON,
            path="/org/freedesktop/DBus",
            interface=_BUS_DAEMON,
            member="AddMatch",
            signature="s",
            body=[_NAME_OWNER_MATCH],
        )
    )


async def run_service(idle_seconds: float = 60, *, collectors: dict[ProviderKind, Collector] | None = None) -> int:
    """Returns 0 after an idle exit, a termination signal or the loss of the bus, 1 when another instance owns the name."""
    loop = asyncio.get_running_loop()
    finished = asyncio.Event()
    bus_lost = False
    runtime: Runtime | None = None

    def on_shell(connected: bool) -> None:
        # Before the runtime has started the state is applied once it has; after detach it is not applied.
        if runtime is not None and interface.attached:
            runtime.set_shell_connected(connected)

    def on_disconnect(task: "asyncio.Future[None]") -> None:
        nonlocal bus_lost
        # The reason (EOF of the socket) is not a failure of the service; it is read so it is not reported.
        if not task.cancelled():
            task.exception()
            bus_lost = True
            interface.mute()
            finished.set()

    tracker = ClientTracker(on_shell, finished.set, idle_seconds)
    bus = await MessageBus().connect()
    interface = TokenGrillInterface(tracker.call_started, tracker.call_finished)
    for number in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(number, finished.set)
    disconnected = asyncio.ensure_future(bus.wait_for_disconnect())  # type: ignore[no-untyped-call]
    disconnected.add_done_callback(on_disconnect)
    try:
        await _watch_client_names(bus, tracker)
        bus.export(OBJECT_PATH, interface)
        reply = await bus.request_name(BUS_NAME, NameFlag.DO_NOT_QUEUE)
        if reply != RequestNameReply.PRIMARY_OWNER:
            return 1
        async with HttpClient() as http:
            runtime = Runtime(
                ConfigStore(config_dir() / "config.json"), interface, http, collectors or create_collectors()
            )
            try:
                await runtime.start()
                interface.attach(runtime)
                runtime.set_shell_connected(tracker.has_shell)
                tracker.start()
                await finished.wait()
            finally:
                tracker.close()
                interface.detach()
                await runtime.stop()
        if not bus_lost:
            await bus.release_name(BUS_NAME)
        return 0
    except (EOFError, OSError):
        # The bus went away while a request to the daemon was open; nothing is left to release.
        if bus_lost or not disconnected.done():
            raise
        return 0
    finally:
        for number in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(number)
        disconnected.cancel()
        if not bus_lost:
            bus.disconnect()
