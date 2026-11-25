from pathlib import Path

import pytest
from dbus_fast import DBusError

from tokengrill.core.config import ConfigStore
from tokengrill.core.runtime import Runtime
from tokengrill.dbus.interface import TokenGrillInterface
from tokengrill.dbus.payloads import SHUTTING_DOWN
from tokengrill.net.http import HttpClient


async def test_calls_after_detach_fail_and_in_flight_is_balanced(tmp_path: Path) -> None:
    started: list[int] = []
    finished: list[int] = []
    interface = TokenGrillInterface(lambda: started.append(1), lambda: finished.append(1))
    async with HttpClient() as http:
        interface.attach(Runtime(ConfigStore(tmp_path / "config.json"), interface, http, {}))
        assert interface.attached
        interface.detach()
        assert not interface.attached
        with pytest.raises(DBusError) as raised:
            async with interface._call():
                pytest.fail("a call after detach must not reach the runtime")
        assert raised.value.type == SHUTTING_DOWN
    assert len(started) == len(finished) == 1


def test_deeply_nested_json_is_invalid_args() -> None:
    from tokengrill.dbus.payloads import INVALID_ARGS, parse_json_arg

    with pytest.raises(DBusError) as raised:
        parse_json_arg("[" * 200_000)
    assert raised.value.type == INVALID_ARGS


async def test_a_failure_inside_a_method_is_logged_and_answered_with_the_internal_error(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    from tokengrill.dbus.payloads import INTERNAL

    interface = TokenGrillInterface()
    async with HttpClient() as http:
        interface.attach(Runtime(ConfigStore(tmp_path / "config.json"), interface, http, {}))
        with pytest.raises(DBusError) as raised:
            async with interface._call():
                raise OSError(28, "No space left on device")
    assert raised.value.type == INTERNAL
    assert "Traceback" not in raised.value.text
    assert any(record.name == "tokengrill.dbus" and record.exc_info for record in caplog.records)
