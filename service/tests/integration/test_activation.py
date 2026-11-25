import asyncio
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path

import pytest
from dbus_fast import Message, MessageType

from conftest import BUS_CONFIG, IFACE, NAME, PATH, WAIT, connect, owner_exists
from tokengrill.cli import main

pytestmark = pytest.mark.integration

# A folder name that a shell would split or expand, with an e-acute, which is not ASCII (the file stays ASCII).
ODD_FOLDER = f"a b {chr(0xE9)} 'q' $HOME %h"


@pytest.fixture
def activating_env(tmp_path: Path) -> Iterator[dict[str, str]]:
    """A private bus that activates from the scratch data folder; every folder the service uses is scratch too."""
    executable = shutil.which("dbus-daemon")
    if executable is None:
        pytest.skip("dbus-daemon is not installed")
    values = {"PATH": os.environ.get("PATH", ""), "HOME": str(tmp_path / "home")}
    for name in ("CONFIG", "DATA", "STATE", "CACHE"):
        values[f"XDG_{name}_HOME"] = str(tmp_path / name.lower())
    services = tmp_path / "data" / "dbus-1" / "services"
    services.mkdir(parents=True)
    config = tmp_path / "bus.conf"
    config.write_text(
        BUS_CONFIG.replace("</busconfig>", f"  <servicedir>{services}</servicedir>\n</busconfig>"), encoding="ascii"
    )
    daemon = subprocess.Popen(
        [executable, f"--config-file={config}", "--print-address", "--nofork"],
        stdout=subprocess.PIPE,
        env=values,
        text=True,
    )
    assert daemon.stdout is not None
    values["DBUS_SESSION_BUS_ADDRESS"] = daemon.stdout.readline().strip()
    yield values
    daemon.kill()
    daemon.wait()
    daemon.stdout.close()


async def _owner_pid(env: dict[str, str]) -> int:
    bus = await connect(env)
    try:
        reply = await bus.call(
            Message(
                destination="org.freedesktop.DBus",
                path="/org/freedesktop/DBus",
                interface="org.freedesktop.DBus",
                member="GetConnectionUnixProcessID",
                signature="s",
                body=[NAME],
            )
        )
        assert reply is not None and reply.message_type == MessageType.METHOD_RETURN
        return int(reply.body[0])
    finally:
        bus.disconnect()


async def test_setup_in_a_folder_with_spaces_and_non_ascii_activates(
    activating_env: dict[str, str], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    folder = tmp_path / ODD_FOLDER
    folder.mkdir()
    script = folder / "tokengrill"
    script.write_text(f'#!/bin/sh\nexec {shlex.quote(sys.executable)} -m tokengrill "$@"\n', encoding="utf-8")
    script.chmod(0o755)
    for key, value in activating_env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(sys, "executable", str(folder / "python3"))
    # setup reloads this bus with its own event loop.
    assert await asyncio.to_thread(main, ["setup"]) == 0

    bus = await connect(activating_env)
    try:
        reply = await bus.call(
            Message(destination=NAME, path=PATH, interface=IFACE, member="Hello", signature="s", body=["cli"])
        )
    finally:
        bus.disconnect()
    assert reply is not None and reply.message_type == MessageType.METHOD_RETURN, reply and reply.body
    assert json.loads(reply.body[0])["schema"] == 1
    os.kill(await _owner_pid(activating_env), signal.SIGTERM)


async def test_purge_stops_the_running_service_before_it_deletes(
    env: dict[str, str], service: subprocess.Popen[str], monkeypatch: pytest.MonkeyPatch
) -> None:
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr("builtins.input", lambda prompt: "y")
    monkeypatch.setattr("tokengrill.providers.keyring.remove_all_api_keys", lambda: 0)
    bus = await connect(env)
    try:
        # A shell client keeps the service running, and its exit flush writes the state files.
        reply = await bus.call(
            Message(destination=NAME, path=PATH, interface=IFACE, member="Hello", signature="s", body=["shell"])
        )
        assert reply is not None and reply.message_type == MessageType.METHOD_RETURN
        reply = await bus.call(
            Message(
                destination=NAME,
                path=PATH,
                interface=IFACE,
                member="SetSettings",
                signature="s",
                body=['{"refreshIntervalSeconds":120}'],
            )
        )
        assert reply is not None and reply.message_type == MessageType.METHOD_RETURN
        assert (Path(env["XDG_CONFIG_HOME"]) / "token-grill" / "config.json").exists()
        assert await asyncio.to_thread(main, ["uninstall", "--purge"]) == 0
        assert await asyncio.to_thread(service.wait, WAIT) == 0
        assert not await owner_exists(bus)
    finally:
        bus.disconnect()
    for name in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        assert not (Path(env[name]) / "token-grill").exists(), name
