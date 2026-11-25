import asyncio
import os
import shutil
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import secretstorage

from tokengrill.core.errors import ServiceError
from tokengrill.providers import keyring

pytestmark = pytest.mark.integration

WAIT = 15.0
SCHEMA = "org.freedesktop.Secret.Generic"
LOGIN = "/org/freedesktop/secrets/collection/login"
ATTRS = {"service": "tokengrill-synthetic"}


@pytest.fixture
def private_keyring(
    bus_address: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[subprocess.Popen[str]]:
    """A gnome-keyring-daemon on the private bus with its own runtime and data dirs: the real keyring is never touched."""
    executable = shutil.which("gnome-keyring-daemon")
    if executable is None:
        pytest.skip("gnome-keyring-daemon is not installed")
    runtime = tmp_path / "run"
    runtime.mkdir(mode=0o700)
    home = tmp_path / "kr-home"
    home.mkdir()
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home),
        "XDG_RUNTIME_DIR": str(runtime),
        "XDG_DATA_HOME": str(home / "data"),
        "XDG_CONFIG_HOME": str(home / "config"),
        "DBUS_SESSION_BUS_ADDRESS": bus_address,
    }
    daemon = subprocess.Popen(
        [executable, "--foreground", "--unlock", "--components=secrets"],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert daemon.stdin is not None
    daemon.stdin.write("synthetic-password")
    daemon.stdin.close()
    monkeypatch.setenv("DBUS_SESSION_BUS_ADDRESS", bus_address)
    deadline = time.monotonic() + WAIT
    while True:
        try:
            connection = secretstorage.dbus_init()
            try:
                secretstorage.Collection(connection, LOGIN)
            finally:
                connection.close()
            break
        except secretstorage.SecretServiceNotAvailableException:
            assert time.monotonic() < deadline, "the private keyring did not appear"
            assert daemon.poll() is None
            time.sleep(0.1)
    yield daemon
    daemon.kill()
    daemon.wait()
    for stream in (daemon.stdout, daemon.stderr):
        if stream:
            stream.close()


def plant_locked_item() -> None:
    connection = secretstorage.dbus_init()
    try:
        # A bare daemon has no default alias yet, and creating one would prompt.
        collection = secretstorage.Collection(connection, LOGIN)
        collection.create_item("Token Grill synthetic", {"xdg:schema": SCHEMA, **ATTRS}, b"synthetic-secret")
        collection.lock()
        assert collection.is_locked()
    finally:
        connection.close()


def monitor(bus_address: str) -> subprocess.Popen[str]:
    executable = shutil.which("dbus-monitor")
    if executable is None:
        pytest.skip("dbus-monitor is not installed")
    process = subprocess.Popen(
        [executable, "--address", bus_address, "type='method_call'"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env={"PATH": os.environ.get("PATH", "")},
    )
    # dbus-monitor prints nothing until it sees traffic, so give it a moment to attach before any call.
    time.sleep(1)
    return process


def test_lookup_never_calls_unlock(private_keyring: subprocess.Popen[str], bus_address: str) -> None:
    plant_locked_item()
    watcher = monitor(bus_address)
    try:
        with pytest.raises(ServiceError) as raised:
            asyncio.run(keyring.lookup_secret(SCHEMA, ATTRS, "copilot.keyring-unavailable"))
        assert raised.value.code == "dependency"
        time.sleep(0.5)
    finally:
        watcher.terminate()
        output, _ = watcher.communicate(timeout=WAIT)
    searches = output.count("member=SearchItems")
    assert searches >= 1, output
    assert output.count("member=Unlock") == 0
    assert output.count("member=Prompt") == 0
    assert "synthetic-secret" not in output


def test_purge_removes_only_token_grill_key_items(private_keyring: subprocess.Popen[str]) -> None:
    connection = secretstorage.dbus_init()
    try:
        collection = secretstorage.Collection(connection, LOGIN)
        for account in ("a", "b"):
            own = {"xdg:schema": keyring.TOKEN_GRILL_KEY_SCHEMA, "account": account}
            collection.create_item(keyring.API_KEY_LABEL, own, b"synthetic-key")
        collection.create_item("Token Grill synthetic", {"xdg:schema": SCHEMA, **ATTRS}, b"synthetic-secret")
    finally:
        connection.close()
    assert keyring.remove_all_api_keys() == 2
    assert keyring.remove_all_api_keys() == 0
    connection = secretstorage.dbus_init()
    try:
        left = [item.get_label() for item in secretstorage.Collection(connection, LOGIN).get_all_items()]
    finally:
        connection.close()
    assert left == ["Token Grill synthetic"]
