import asyncio
import json
import os
import shutil
import signal
import subprocess
import sys
import xml.etree.ElementTree as ET
from collections.abc import AsyncIterator, Iterator
from importlib import resources
from pathlib import Path

import pytest
from dbus_fast import DBusError, Message, MessageType
from dbus_fast.aio import MessageBus, ProxyInterface

from tokengrill.core.config import ConfigStore, default_settings, new_provider
from tokengrill.core.types import ProviderInstance, ProviderKind, ProviderSnapshot
from tokengrill.providers.base import Collector, CollectorContext
from tokengrill.service import run_service

pytestmark = pytest.mark.integration

NAME = "io.github.sh02sahil.TokenGrill"
PATH = "/io/github/sh02sahil/TokenGrill"
IFACE = "io.github.sh02sahil.TokenGrill1"
WAIT = 15.0


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


async def proxy(bus: MessageBus) -> ProxyInterface:
    introspection = await asyncio.wait_for(bus.introspect(NAME, PATH), WAIT)
    return bus.get_proxy_object(NAME, PATH, introspection).get_interface(IFACE)


async def wait_exit(process: subprocess.Popen[str]) -> int:
    async def poll() -> int:
        while (code := process.poll()) is None:
            await asyncio.sleep(0.05)
        return code

    return await asyncio.wait_for(poll(), WAIT)


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


async def test_hello_returns_state_and_registers(env: dict[str, str], service: subprocess.Popen[str]) -> None:
    bus = await connect(env)
    iface = await proxy(bus)
    state = json.loads(await iface.call_hello("shell"))  # type: ignore[attr-defined]
    assert state["schema"] == 1
    assert state["accounts"] == []
    assert state["paused"] is False
    assert await iface.get_api_version() == state["apiVersion"]  # type: ignore[attr-defined]
    assert await iface.get_service_version() == state["serviceVersion"]  # type: ignore[attr-defined]
    assert json.loads(await iface.call_get_state())["schema"] == 1  # type: ignore[attr-defined]
    await iface.call_set_paused(True)  # type: ignore[attr-defined]
    assert json.loads(await iface.call_get_state())["paused"] is True  # type: ignore[attr-defined]
    bus.disconnect()


async def test_bad_arguments_and_unfinished_methods_raise_dbus_errors(
    env: dict[str, str], service: subprocess.Popen[str]
) -> None:
    bus = await connect(env)
    iface = await proxy(bus)
    with pytest.raises(DBusError) as bad_kind:
        await iface.call_hello("browser")  # type: ignore[attr-defined]
    assert bad_kind.value.type == f"{NAME}.Error.InvalidArgs"
    with pytest.raises(DBusError) as unfinished:
        await iface.call_discover("")  # type: ignore[attr-defined]
    assert unfinished.value.type == f"{NAME}.Error.NotSupported"
    bus.disconnect()


async def test_second_instance_exits_1(env: dict[str, str], service: subprocess.Popen[str]) -> None:
    second = start_service(env)
    try:
        assert await wait_exit(second) == 1
    finally:
        second.kill()
        second.wait()
        if second.stderr:
            second.stderr.close()
    assert service.poll() is None


async def test_exits_after_client_disconnects(env: dict[str, str]) -> None:
    process = start_service(env, idle=1)
    bus = await connect(env)
    try:
        await wait_for_name(bus)
        client = await connect(env)
        await (await proxy(client)).call_hello("shell")  # type: ignore[attr-defined]
        await asyncio.sleep(1.5)
        assert process.poll() is None
        client.disconnect()
        assert await wait_exit(process) == 0
        assert not await owner_exists(bus)
    finally:
        bus.disconnect()
        if process.poll() is None:
            process.kill()
        process.wait()
        if process.stderr:
            process.stderr.close()


async def test_sigterm_exits_cleanly_and_releases_name(env: dict[str, str], service: subprocess.Popen[str]) -> None:
    bus = await connect(env)
    await (await proxy(bus)).call_hello("shell")  # type: ignore[attr-defined]
    observer = await connect(env)
    service.send_signal(signal.SIGTERM)
    assert await wait_exit(service) == 0
    assert not await owner_exists(observer)
    assert service.stderr is not None
    assert "Traceback" not in service.stderr.read()
    bus.disconnect()
    observer.disconnect()


async def test_losing_the_bus_exits_0_without_noise(
    env: dict[str, str], daemon: subprocess.Popen[str], service: subprocess.Popen[str]
) -> None:
    bus = await connect(env)
    await (await proxy(bus)).call_hello("shell")  # type: ignore[attr-defined]
    daemon.kill()
    assert await wait_exit(service) == 0
    assert service.stderr is not None
    assert service.stderr.read() == ""


class BlockedCollector:
    """Records a diagnostic entry, then waits until it is cancelled by the shutdown."""

    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        ctx.record("sign-in", "test")
        await asyncio.Event().wait()
        return snapshot


async def test_sigterm_flushes_and_releases_name(env: dict[str, str], monkeypatch: pytest.MonkeyPatch) -> None:
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    account = new_provider("codex", "codex-cli", str(Path(env["HOME"]) / "codex"))
    await ConfigStore(Path(env["XDG_CONFIG_HOME"]) / "token-grill" / "config.json").save(
        {"schema": 1, "accounts": [account], **default_settings()}
    )
    written = Path(env["XDG_STATE_HOME"]) / "token-grill" / "diagnostics-v1.json"
    collectors: dict[ProviderKind, Collector] = {"codex": BlockedCollector()}
    server = asyncio.create_task(run_service(60, collectors=collectors))
    client = await connect(env)
    try:
        await wait_for_name(client)
        iface = await proxy(client)
        await iface.call_hello("shell")  # type: ignore[attr-defined]
        await asyncio.sleep(0.3)
        assert not written.exists()
        os.kill(os.getpid(), signal.SIGTERM)
        assert await asyncio.wait_for(server, WAIT) == 0
        assert written.exists()
        assert not await owner_exists(client)
    finally:
        client.disconnect()


def _signature(element: ET.Element) -> dict[str, object]:
    """dbus-fast names only the in arguments of methods; the names of out and signal arguments are not compared."""
    methods = {
        m.get("name"): [
            (a.get("name") if a.get("direction") == "in" else None, a.get("direction"), a.get("type"))
            for a in m.findall("arg")
        ]
        for m in element.findall("method")
    }
    signals = {s.get("name"): [a.get("type") for a in s.findall("arg")] for s in element.findall("signal")}
    properties = {p.get("name"): (p.get("type"), p.get("access")) for p in element.findall("property")}
    return {"methods": methods, "signals": signals, "properties": properties}


async def test_introspection_matches_interface_xml(env: dict[str, str], service: subprocess.Popen[str]) -> None:
    bus = await connect(env)
    reply = await bus.call(
        Message(
            destination=NAME,
            path=PATH,
            interface="org.freedesktop.DBus.Introspectable",
            member="Introspect",
        )
    )
    assert reply is not None and reply.message_type == MessageType.METHOD_RETURN
    live = next(i for i in ET.fromstring(reply.body[0]).findall("interface") if i.get("name") == IFACE)
    shipped_text = resources.files("tokengrill.dbus").joinpath("interface.xml").read_text(encoding="ascii")
    shipped = next(i for i in ET.fromstring(shipped_text).findall("interface") if i.get("name") == IFACE)
    expected = _signature(shipped)
    assert _signature(live) == expected
    assert len(expected["methods"]) == 20  # type: ignore[arg-type]
    bus.disconnect()


class QuickCollector:
    async def collect(
        self, instance: ProviderInstance, snapshot: ProviderSnapshot, ctx: CollectorContext
    ) -> ProviderSnapshot:
        return {**snapshot, "plan": "Pro", "lastUpdated": 1_800_000_000_000}


async def test_account_changed_signal_carries_snapshot_and_runtime(
    env: dict[str, str], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    for key in (
        "DBUS_SESSION_BUS_ADDRESS",
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
    ):
        monkeypatch.setenv(key, env[key])
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    account = new_provider("codex", "codex-cli", str(tmp_path / "codex-home"))
    await ConfigStore(Path(env["XDG_CONFIG_HOME"]) / "token-grill" / "config.json").save(
        {"schema": 1, "accounts": [account], **default_settings()}
    )
    collectors: dict[ProviderKind, Collector] = {"codex": QuickCollector()}
    server = asyncio.create_task(run_service(0.3, collectors=collectors))
    client = await connect(env)
    try:
        await wait_for_name(client)
        iface = await proxy(client)
        seen: asyncio.Queue[tuple[str, str]] = asyncio.Queue()
        iface.on_account_changed(lambda id_, payload: seen.put_nowait((id_, payload)))  # type: ignore[attr-defined]
        await iface.call_hello("shell")  # type: ignore[attr-defined]
        payloads: list[dict[str, object]] = []
        while True:
            id_, text = await asyncio.wait_for(seen.get(), WAIT)
            assert id_ == account["id"]
            payload = json.loads(text)
            payloads.append(payload)
            runtime = payload["runtime"]
            assert isinstance(runtime, dict)
            if runtime["phase"] == "idle" and runtime["outcome"] is not None:
                break
        assert all(p["schema"] == 1 for p in payloads)
        assert payloads[-1]["snapshot"]["plan"] == "Pro"  # type: ignore[index]
    finally:
        client.disconnect()
    assert await asyncio.wait_for(server, WAIT) == 0
