import asyncio
import os
import shutil
import subprocess
import sys
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from dbus_fast import Message, MessageType
from dbus_fast.aio import MessageBus

BUS_CONFIG = """<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
"""


@pytest.fixture
def daemon(tmp_path: Path) -> Iterator[subprocess.Popen[str]]:
    """A private bus with no service directories: nothing installed on this machine can be activated."""
    executable = shutil.which("dbus-daemon")
    if executable is None:
        pytest.skip("dbus-daemon is not installed")
    config = tmp_path / "bus.conf"
    config.write_text(BUS_CONFIG, encoding="ascii")
    process = subprocess.Popen(
        [executable, f"--config-file={config}", "--print-address", "--nofork"],
        stdout=subprocess.PIPE,
        env={"PATH": os.environ.get("PATH", "")},
        text=True,
    )
    yield process
    process.kill()
    process.wait()
    if process.stdout:
        process.stdout.close()


@pytest.fixture
def bus_address(daemon: subprocess.Popen[str]) -> str:
    assert daemon.stdout is not None
    return daemon.stdout.readline().strip()


@pytest.fixture
def env(bus_address: str, tmp_path: Path) -> dict[str, str]:
    values = {"PATH": os.environ.get("PATH", ""), "DBUS_SESSION_BUS_ADDRESS": bus_address}
    values["HOME"] = str(tmp_path / "home")
    for name in ("CONFIG", "DATA", "STATE", "CACHE"):
        values[f"XDG_{name}_HOME"] = str(tmp_path / name.lower())
    return values


NAME = "io.github.sh02sahil.TokenGrill"
PATH = "/io/github/sh02sahil/TokenGrill"
IFACE = "io.github.sh02sahil.TokenGrill1"
WAIT = 15.0


def start_service(env: dict[str, str], idle: float = 60) -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-m", "tokengrill", "run", "--idle-seconds", str(idle)],
        env=env,
        stderr=subprocess.PIPE,
        text=True,
    )


async def connect(env: dict[str, str]) -> MessageBus:
    return await asyncio.wait_for(MessageBus(bus_address=env["DBUS_SESSION_BUS_ADDRESS"]).connect(), WAIT)


async def owner_exists(bus: MessageBus) -> bool:
    reply = await bus.call(
        Message(
            destination="org.freedesktop.DBus",
            path="/org/freedesktop/DBus",
            interface="org.freedesktop.DBus",
            member="NameHasOwner",
            signature="s",
            body=[NAME],
        )
    )
    assert reply is not None and reply.message_type == MessageType.METHOD_RETURN
    return bool(reply.body[0])


async def wait_for_name(bus: MessageBus) -> None:
    async def poll() -> None:
        while not await owner_exists(bus):
            await asyncio.sleep(0.05)

    await asyncio.wait_for(poll(), WAIT)


@pytest.fixture
async def service(env: dict[str, str]) -> AsyncIterator[subprocess.Popen[str]]:
    process = start_service(env)
    bus = await connect(env)
    try:
        await wait_for_name(bus)
        yield process
    finally:
        bus.disconnect()
        if process.poll() is None:
            process.kill()
        process.wait()
        if process.stderr:
            process.stderr.close()
