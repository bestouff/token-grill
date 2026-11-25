import argparse
import asyncio
import json
import shutil
import sys
from pathlib import Path
from typing import Final

from dbus_fast import DBusError, Message, MessageType
from dbus_fast.aio import MessageBus

from tokengrill import API_VERSION, __version__
from tokengrill.core.paths import config_dir, data_dir, state_dir
from tokengrill.core.timemath import now_ms
from tokengrill.core.types import ServiceState
from tokengrill.statusview import render_status

BUS_NAME: Final = "io.github.sh02sahil.TokenGrill"
OBJECT_PATH: Final = "/io/github/sh02sahil/TokenGrill"
INTERFACE: Final = "io.github.sh02sahil.TokenGrill1"
_BUS_TIMEOUT: Final = 5.0
_REFRESH_TIMEOUT: Final = 60.0
_POLL_SECONDS: Final = 0.5
_MISSING_SERVICE: Final = (
    "org.freedesktop.DBus.Error.ServiceUnknown",
    "org.freedesktop.DBus.Error.NameHasNoOwner",
    "org.freedesktop.DBus.Error.Spawn.ServiceNotFound",
)


def _version() -> int:
    print(f"tokengrill {__version__} (D-Bus API {API_VERSION})")
    return 0


def _service_file() -> Path:
    return data_dir().parent / "dbus-1" / "services" / f"{BUS_NAME}.service"


def _error(reply: Message) -> DBusError:
    return DBusError(reply.error_name or "", str(reply.body[0]) if reply.body else "", reply)


async def _reload_bus_config() -> None:
    bus = await MessageBus().connect()
    try:
        reply = await bus.call(
            Message(
                destination="org.freedesktop.DBus",
                path="/org/freedesktop/DBus",
                interface="org.freedesktop.DBus",
                member="ReloadConfig",
            )
        )
        if reply is not None and reply.message_type == MessageType.ERROR:
            raise _error(reply)
    finally:
        bus.disconnect()


def _reload() -> bool:
    """False when the session bus cannot be reached or refuses the reload; it then reads the folder at next login."""
    try:
        asyncio.run(asyncio.wait_for(_reload_bus_config(), _BUS_TIMEOUT))
    except (OSError, EOFError, DBusError, TimeoutError, ValueError):
        return False
    return True


def _setup() -> int:
    target = _service_file()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        f"[D-BUS Service]\nName={BUS_NAME}\nExec={sys.executable} -m tokengrill run\n",
        encoding="ascii",
    )
    if not _reload():
        print("The session bus could not be reached; it will pick up the service file at next login.")
    print("Token Grill will start the service when it needs it.")
    return 0


def _uninstall(purge: bool) -> int:
    _service_file().unlink(missing_ok=True)
    if not _reload():
        print("The session bus could not be reached; it will notice the removal at next login.")
    print("The Token Grill service file is removed.")
    if purge:
        try:
            answer = input("Also delete the accounts and history? [y/N] ")
        except EOFError:
            answer = ""
        if answer in ("y", "Y"):
            for folder in (config_dir(), data_dir(), state_dir()):
                shutil.rmtree(folder, ignore_errors=True)
            print("The accounts and history are deleted.")
    return 0


async def _call(bus: MessageBus, member: str, signature: str = "", body: list[object] | None = None) -> Message:
    reply = await asyncio.wait_for(
        bus.call(
            Message(
                destination=BUS_NAME,
                path=OBJECT_PATH,
                interface=INTERFACE,
                member=member,
                signature=signature,
                body=body or [],
            )
        ),
        _REFRESH_TIMEOUT,
    )
    assert reply is not None
    if reply.message_type == MessageType.ERROR:
        raise _error(reply)
    return reply


def _all_idle(state: ServiceState) -> bool:
    return all(entry["phase"] == "idle" for entry in state["runtime"].values())


async def _fetch_state(refresh: bool) -> str:
    bus = await asyncio.wait_for(MessageBus().connect(), _BUS_TIMEOUT)
    try:
        # The first call activates the service through the D-Bus service file.
        text: str = (await _call(bus, "Hello", "s", ["cli"])).body[0]
        if refresh:
            await _call(bus, "RefreshAll")
            deadline = asyncio.get_running_loop().time() + _REFRESH_TIMEOUT
            while True:
                text = (await _call(bus, "GetState")).body[0]
                if _all_idle(json.loads(text)) or asyncio.get_running_loop().time() >= deadline:
                    break
                await asyncio.sleep(_POLL_SECONDS)
        return text
    finally:
        bus.disconnect()


def _status(as_json: bool, refresh: bool) -> int:
    try:
        text = asyncio.run(_fetch_state(refresh))
    except DBusError as failure:
        if failure.type in _MISSING_SERVICE:
            print("The Token Grill service is not installed. Run: tokengrill setup", file=sys.stderr)
        else:
            print(f"tokengrill: {failure.text}", file=sys.stderr)
        return 1
    except (OSError, EOFError, TimeoutError):
        print(
            "The session bus could not be reached, or the service did not answer. Run: tokengrill setup",
            file=sys.stderr,
        )
        return 1
    if as_json:
        print(text)
    else:
        print(render_status(json.loads(text), now_ms()), end="")
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="tokengrill")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("version", help="print the package and D-Bus API versions")
    run = commands.add_parser("run", help="serve the D-Bus interface until the last client leaves")
    run.add_argument("--idle-seconds", type=float, default=60, help=argparse.SUPPRESS)
    commands.add_parser("setup", help="register the D-Bus service so Token Grill starts it on demand")
    uninstall = commands.add_parser("uninstall", help="remove the D-Bus service registration")
    uninstall.add_argument("--purge", action="store_true", help="also offer to delete the accounts and history")
    status = commands.add_parser("status", help="print the accounts and their limits")
    status.add_argument("--json", action="store_true", help="print the service state as JSON")
    status.add_argument("--refresh", action="store_true", help="refresh all accounts first and wait for the result")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exit_request:
        return exit_request.code if isinstance(exit_request.code, int) else 2
    if args.command == "version":
        return _version()
    if args.command == "run":
        from tokengrill.service import run_service

        return asyncio.run(run_service(args.idle_seconds))
    if args.command == "setup":
        return _setup()
    if args.command == "uninstall":
        return _uninstall(args.purge)
    if args.command == "status":
        return _status(args.json, args.refresh)
    print(f"tokengrill: unknown command {args.command}", file=sys.stderr)
    return 2
